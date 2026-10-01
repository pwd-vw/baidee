#include "esp_camera.h"
#include <ArduinoOTA.h>
#include <FS.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <time.h>

#if __has_include("config.h")
#include "config.h"
#endif

#ifndef BAIDEE_WIFI_SSID
#define BAIDEE_WIFI_SSID ""
#endif

#ifndef BAIDEE_WIFI_PASSWORD
#define BAIDEE_WIFI_PASSWORD ""
#endif

#ifndef BAIDEE_WORKER_URL
#define BAIDEE_WORKER_URL ""
#endif

#ifndef BAIDEE_NODE_ID
#define BAIDEE_NODE_ID "bd-s01-b01-c01"
#endif

#ifndef BAIDEE_HMAC_SECRET
#define BAIDEE_HMAC_SECRET ""
#endif

#ifndef BAIDEE_OTA_PASSWORD
#define BAIDEE_OTA_PASSWORD ""
#endif

#ifndef BAIDEE_CAPTURE_INTERVAL_MS
#define BAIDEE_CAPTURE_INTERVAL_MS (60UL * 60UL * 1000UL)
#endif

#ifndef BAIDEE_RETRY_INTERVAL_MS
#define BAIDEE_RETRY_INTERVAL_MS (5UL * 60UL * 1000UL)
#endif

#ifndef BAIDEE_CMD_POLL_INTERVAL_MS
#define BAIDEE_CMD_POLL_INTERVAL_MS (10UL * 1000UL)
#endif

#ifndef BAIDEE_HEARTBEAT_INTERVAL_MS
#define BAIDEE_HEARTBEAT_INTERVAL_MS (10UL * 60UL * 1000UL)
#endif

#ifndef BAIDEE_WIFI_RETRY_INTERVAL_MS
#define BAIDEE_WIFI_RETRY_INTERVAL_MS (2UL * 60UL * 1000UL)
#endif

// Mirrors the frame left-to-right so any text/markers in view (zone labels,
// reference cards) read correctly, matching how this camera is physically
// mounted. Override per-node in config.h if a different unit is mounted
// rotated/mirrored the other way.
#ifndef BAIDEE_CAMERA_HMIRROR
#define BAIDEE_CAMERA_HMIRROR 1
#endif

#ifndef BAIDEE_CAMERA_VFLIP
#define BAIDEE_CAMERA_VFLIP 0
#endif

namespace {
constexpr char FirmwareVersion[] = "0.2.0";
constexpr uint32_t DefaultCaptureIntervalMs = BAIDEE_CAPTURE_INTERVAL_MS;
constexpr uint32_t RetryIntervalMs = BAIDEE_RETRY_INTERVAL_MS;
constexpr uint32_t CmdPollIntervalMs = BAIDEE_CMD_POLL_INTERVAL_MS;
constexpr uint32_t HeartbeatIntervalMs = BAIDEE_HEARTBEAT_INTERVAL_MS;
constexpr uint32_t WifiRetryIntervalMs = BAIDEE_WIFI_RETRY_INTERVAL_MS;
constexpr uint32_t MinCaptureIntervalMs = 60UL * 1000UL;
constexpr framesize_t CaptureFrameSize = FRAMESIZE_UXGA;
constexpr uint8_t JpegQuality = 10;
constexpr char PendingImagePath[] = "/pending.jpg";
constexpr char PendingPayloadPath[] = "/pending.json";
constexpr char WifiOverridePath[] = "/wifi.json";
constexpr char ConfigOverridePath[] = "/config.json";
constexpr char MultipartBoundary[] = "----BaiDeeCaptureBoundary";

bool cameraReady = false;
bool wifiReady = false;
bool timeReady = false;
bool otaReady = false;
bool storageReady = false;
bool wifiOverrideLoaded = false;
uint32_t lastCaptureAt = 0;
uint32_t lastRetryAt = 0;
uint32_t lastCmdPollAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastWifiRetryAt = 0;
uint32_t captureIntervalMs = DefaultCaptureIntervalMs;
String overrideSsid;
String overridePassword;

void captureFrame();
void connectNetwork();

camera_config_t cameraConfig() {
  camera_config_t config{};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = 11;
  config.pin_d1 = 9;
  config.pin_d2 = 8;
  config.pin_d3 = 10;
  config.pin_d4 = 12;
  config.pin_d5 = 18;
  config.pin_d6 = 17;
  config.pin_d7 = 16;
  config.pin_xclk = 15;
  config.pin_pclk = 13;
  config.pin_vsync = 6;
  config.pin_href = 7;
  config.pin_sccb_sda = 4;
  config.pin_sccb_scl = 5;
  config.pin_pwdn = -1;
  config.pin_reset = -1;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = CaptureFrameSize;
  config.jpeg_quality = JpegQuality;
  config.fb_count = 1;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  return config;
}

bool initializeCamera() {
  camera_config_t config = cameraConfig();
  const esp_err_t result = esp_camera_init(&config);
  if (result != ESP_OK) {
    Serial.printf("camera_init_failed=0x%08x\n", result);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor != nullptr) {
    sensor->set_framesize(sensor, CaptureFrameSize);
    sensor->set_quality(sensor, JpegQuality);
    sensor->set_hmirror(sensor, BAIDEE_CAMERA_HMIRROR);
    sensor->set_vflip(sensor, BAIDEE_CAMERA_VFLIP);
  }
  return true;
}

String activeSsid() {
  return wifiOverrideLoaded ? overrideSsid : String(BAIDEE_WIFI_SSID);
}

String activePassword() {
  return wifiOverrideLoaded ? overridePassword : String(BAIDEE_WIFI_PASSWORD);
}

bool networkConfigured() {
  return activeSsid().length() > 0;
}

bool uploadConfigured() {
  return BAIDEE_WORKER_URL[0] != '\0' && BAIDEE_HMAC_SECRET[0] != '\0';
}

String jsonEscape(const String& value) {
  String out;
  out.reserve(value.length());
  for (size_t index = 0; index < value.length(); ++index) {
    const char c = value[index];
    if (c == '"' || c == '\\') out += '\\';
    if (c == '\n') {
      out += "\\n";
      continue;
    }
    out += c;
  }
  return out;
}

// Extracts a string value for "key" from a flat JSON object. Handles the
// small, self-generated payloads this firmware exchanges with the Worker;
// it does not handle escaped quotes inside the value.
String extractJsonString(const String& json, const String& key, const String& fallback) {
  const String pattern = "\"" + key + "\":\"";
  const int start = json.indexOf(pattern);
  if (start < 0) return fallback;
  const int valueStart = start + pattern.length();
  const int valueEnd = json.indexOf('"', valueStart);
  if (valueEnd < 0) return fallback;
  return json.substring(valueStart, valueEnd);
}

long extractJsonNumber(const String& json, const String& key, long fallback) {
  const String pattern = "\"" + key + "\":";
  const int start = json.indexOf(pattern);
  if (start < 0) return fallback;
  int index = start + pattern.length();
  const int length = json.length();
  int end = index;
  while (end < length && (isDigit(json[end]) || json[end] == '-')) end++;
  if (end == index) return fallback;
  return json.substring(index, end).toInt();
}

String hexBytes(const uint8_t* bytes, size_t length) {
  String result;
  result.reserve(length * 2);
  for (size_t index = 0; index < length; ++index) {
    if (bytes[index] < 16) result += '0';
    result += String(bytes[index], HEX);
  }
  return result;
}

String hmacHex(const String& value) {
  uint8_t digest[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_context_t context;
  mbedtls_md_init(&context);
  mbedtls_md_setup(&context, info, 1);
  mbedtls_md_hmac_starts(&context, reinterpret_cast<const uint8_t*>(BAIDEE_HMAC_SECRET), strlen(BAIDEE_HMAC_SECRET));
  mbedtls_md_hmac_update(&context, reinterpret_cast<const uint8_t*>(value.c_str()), value.length());
  mbedtls_md_hmac_finish(&context, digest);
  mbedtls_md_free(&context);
  return hexBytes(digest, sizeof(digest));
}

String imageSha256(const uint8_t* data, size_t length) {
  uint8_t digest[32];
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  mbedtls_sha256_starts(&context, 0);
  mbedtls_sha256_update(&context, data, length);
  mbedtls_sha256_finish(&context, digest);
  mbedtls_sha256_free(&context);
  return hexBytes(digest, sizeof(digest));
}

String utcTimestamp() {
  time_t now = time(nullptr);
  struct tm utc;
  gmtime_r(&now, &utc);
  char buffer[25];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return String(buffer);
}

String makePayload(const String& captureId, const String& timestamp, const String& imageSha, size_t imageSize) {
  String payload;
  payload.reserve(512);
  payload += "{\"schema_version\":\"1.0\",\"capture_id\":\"" + captureId;
  payload += "\",\"node_id\":\"" + String(BAIDEE_NODE_ID);
  payload += "\",\"site_id\":\"s01\",\"bed_id\":\"b01\",\"timestamp\":\"" + timestamp;
  payload += "\",\"image_sha256\":\"" + imageSha;
  payload += "\",\"image_size\":{\"w\":1600,\"h\":1200},\"stage\":\"edge_triage\",\"capture_meta\":{\"fw\":\"";
  payload += FirmwareVersion;
  payload += "\",\"bytes\":";
  payload += String(imageSize) + "}}";
  return payload;
}

bool initializeStorage() {
  storageReady = LittleFS.begin(true);
  Serial.printf("storage=%s\n", storageReady ? "ready" : "failed");
  return storageReady;
}

void loadWifiOverride() {
  if (!storageReady || !LittleFS.exists(WifiOverridePath)) return;
  File file = LittleFS.open(WifiOverridePath, FILE_READ);
  if (!file) return;
  const String content = file.readString();
  file.close();
  const String ssid = extractJsonString(content, "ssid", "");
  if (ssid.length() == 0) return;
  overrideSsid = ssid;
  overridePassword = extractJsonString(content, "password", "");
  wifiOverrideLoaded = true;
  Serial.printf("wifi_override=loaded ssid=%s\n", overrideSsid.c_str());
}

bool saveWifiOverride(const String& ssid, const String& password) {
  if (!storageReady) return false;
  File file = LittleFS.open(WifiOverridePath, FILE_WRITE);
  if (!file) return false;
  const String content = "{\"ssid\":\"" + jsonEscape(ssid) + "\",\"password\":\"" + jsonEscape(password) + "\"}";
  file.print(content);
  file.close();
  overrideSsid = ssid;
  overridePassword = password;
  wifiOverrideLoaded = true;
  return true;
}

void loadConfigOverride() {
  if (!storageReady || !LittleFS.exists(ConfigOverridePath)) return;
  File file = LittleFS.open(ConfigOverridePath, FILE_READ);
  if (!file) return;
  const String content = file.readString();
  file.close();
  const long interval = extractJsonNumber(content, "capture_interval_ms", -1);
  if (interval >= static_cast<long>(MinCaptureIntervalMs)) {
    captureIntervalMs = static_cast<uint32_t>(interval);
    Serial.printf("config_override=loaded capture_interval_ms=%lu\n", static_cast<unsigned long>(captureIntervalMs));
  }
}

bool saveConfigOverride(uint32_t intervalMs) {
  if (!storageReady) return false;
  File file = LittleFS.open(ConfigOverridePath, FILE_WRITE);
  if (!file) return false;
  file.print("{\"capture_interval_ms\":" + String(intervalMs) + "}");
  file.close();
  return true;
}

bool savePending(const String& payload, const uint8_t* image, size_t imageSize) {
  if (!storageReady) return false;
  File payloadFile = LittleFS.open(PendingPayloadPath, FILE_WRITE);
  File imageFile = LittleFS.open(PendingImagePath, FILE_WRITE);
  if (!payloadFile || !imageFile) return false;
  payloadFile.print(payload);
  const size_t written = imageFile.write(image, imageSize);
  payloadFile.close();
  imageFile.close();
  return written == imageSize;
}

String workerHost() {
  String url = BAIDEE_WORKER_URL;
  if (!url.startsWith("https://")) return "";
  url.remove(0, 8);
  const int slash = url.indexOf('/');
  return slash < 0 ? url : url.substring(0, slash);
}

int extractStatusCode(const String& statusLine) {
  const int firstSpace = statusLine.indexOf(' ');
  if (firstSpace < 0) return 0;
  const int secondSpace = statusLine.indexOf(' ', firstSpace + 1);
  String code = secondSpace < 0 ? statusLine.substring(firstSpace + 1) : statusLine.substring(firstSpace + 1, secondSpace);
  code.trim();
  return code.toInt();
}

// Minimal HTTPS/1.1 request for the small JSON endpoints (cmd poll, cmd ack,
// heartbeat). The multipart image upload in uploadPending() stays separate
// because it streams the file body directly.
bool httpsRequest(const String& method, const String& path, const String& body, const String& extraHeaders, String& responseBody, int& statusCode) {
  statusCode = 0;
  const String host = workerHost();
  if (host.isEmpty()) return false;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(15000);
  if (!client.connect(host.c_str(), 443)) return false;

  client.printf("%s %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n", method.c_str(), path.c_str(), host.c_str());
  client.print(extraHeaders);
  if (body.length() > 0) {
    client.printf("Content-Type: application/json\r\nContent-Length: %u\r\n\r\n", static_cast<unsigned>(body.length()));
    client.print(body);
  } else {
    client.print("\r\n");
  }

  const String statusLine = client.readStringUntil('\n');
  statusCode = extractStatusCode(statusLine);
  while (client.connected() || client.available()) {
    const String line = client.readStringUntil('\n');
    if (line.length() <= 1) break;
  }
  responseBody = client.readString();
  client.stop();
  return statusCode >= 200 && statusCode < 300;
}

void ackCommand(long commandId, bool ok, const String& message) {
  const String status = ok ? "done" : "failed";
  const String canonical = String(BAIDEE_NODE_ID) + ":" + String(commandId) + ":" + status;
  const String body = "{\"node_id\":\"" + String(BAIDEE_NODE_ID) + "\",\"command_id\":" + String(commandId)
    + ",\"status\":\"" + status + "\",\"message\":\"" + jsonEscape(message) + "\"}";
  const String headers = "X-Signature: " + hmacHex(canonical) + "\r\n";
  String responseBody;
  int statusCode;
  httpsRequest("POST", "/v1/cmd/ack", body, headers, responseBody, statusCode);
  Serial.printf("cmd_ack id=%ld status=%s http=%d\n", commandId, status.c_str(), statusCode);
}

void executeCommand(const String& commandObject) {
  const long id = extractJsonNumber(commandObject, "id", -1);
  const String command = extractJsonString(commandObject, "command", "");
  const int argsIndex = commandObject.indexOf("\"args\":{");
  const String args = argsIndex >= 0 ? commandObject.substring(argsIndex + 7) : "{}";

  bool ok = true;
  String message = "ok";

  if (command == "capture_now") {
    captureFrame();
  } else if (command == "set_wifi") {
    const String ssid = extractJsonString(args, "ssid", "");
    const String password = extractJsonString(args, "password", "");
    if (ssid.length() == 0) {
      ok = false;
      message = "missing ssid";
    } else if (!saveWifiOverride(ssid, password)) {
      ok = false;
      message = "storage_failed";
    } else {
      connectNetwork();
      ok = wifiReady;
      message = wifiReady ? "connected" : "connect_failed";
    }
  } else if (command == "set_config") {
    const long intervalMs = extractJsonNumber(args, "capture_interval_ms", -1);
    if (intervalMs < static_cast<long>(MinCaptureIntervalMs)) {
      ok = false;
      message = "invalid capture_interval_ms";
    } else if (!saveConfigOverride(static_cast<uint32_t>(intervalMs))) {
      ok = false;
      message = "storage_failed";
    } else {
      captureIntervalMs = static_cast<uint32_t>(intervalMs);
    }
  } else {
    ok = false;
    message = "unknown_command";
  }

  Serial.printf("cmd_exec id=%ld command=%s ok=%s\n", id, command.c_str(), ok ? "true" : "false");
  if (id >= 0) ackCommand(id, ok, message);
}

void pollCommands() {
  if (!wifiReady || !uploadConfigured()) return;
  const String path = "/v1/cmd?node=" + String(BAIDEE_NODE_ID);
  const String headers = "X-Signature: " + hmacHex(String(BAIDEE_NODE_ID)) + "\r\n";
  String responseBody;
  int statusCode;
  if (!httpsRequest("GET", path, "", headers, responseBody, statusCode) || statusCode != 200) return;

  const int arrayStart = responseBody.indexOf('[');
  const int arrayEnd = responseBody.lastIndexOf(']');
  if (arrayStart < 0 || arrayEnd <= arrayStart) return;
  const String items = responseBody.substring(arrayStart + 1, arrayEnd);
  if (items.length() == 0) return;

  // Process only the first queued command per poll; the next poll (every
  // CmdPollIntervalMs) picks up the rest.
  const int splitAt = items.indexOf("},{");
  const String first = splitAt < 0 ? items : items.substring(0, splitAt + 1);
  executeCommand(first);
}

void sendHeartbeat() {
  if (!wifiReady || !uploadConfigured() || !timeReady) return;
  const String ip = wifiReady ? WiFi.localIP().toString() : "";
  String payload;
  payload.reserve(320);
  payload += "{\"node_id\":\"" + String(BAIDEE_NODE_ID) + "\",\"timestamp\":\"" + utcTimestamp() + "\"";
  payload += ",\"fw_version\":\"" + String(FirmwareVersion) + "\",\"wifi_ip\":\"" + ip + "\"";
  payload += ",\"rssi\":" + String(WiFi.RSSI()) + ",\"uptime_ms\":" + String(millis());
  payload += ",\"camera\":\"" + String(cameraReady ? "ready" : "failed") + "\"";
  payload += ",\"psram\":\"" + String(psramFound() ? "available" : "missing") + "\"";
  payload += ",\"storage\":\"" + String(storageReady ? "ready" : "failed") + "\"";
  payload += ",\"capture_interval_ms\":" + String(captureIntervalMs) + "}";

  const String headers = "X-Node-Id: " + String(BAIDEE_NODE_ID) + "\r\nX-Signature: " + hmacHex(payload) + "\r\n";
  String responseBody;
  int statusCode;
  httpsRequest("POST", "/v1/heartbeat", payload, headers, responseBody, statusCode);
  Serial.printf("heartbeat http=%d\n", statusCode);
}

bool uploadPending() {
  if (!storageReady || !wifiReady || !timeReady || !uploadConfigured()) return false;
  File payloadFile = LittleFS.open(PendingPayloadPath, FILE_READ);
  File imageFile = LittleFS.open(PendingImagePath, FILE_READ);
  if (!payloadFile || !imageFile) return false;

  String url = BAIDEE_WORKER_URL;
  if (!url.startsWith("https://")) return false;
  url.remove(0, 8);
  const int slash = url.indexOf('/');
  const String host = slash < 0 ? url : url.substring(0, slash);
  const String path = slash < 0 ? "/v1/ingest" : url.substring(slash);
  const String payload = payloadFile.readString();
  const String signature = hmacHex(payload);
  const String preamble = String("--") + MultipartBoundary + "\r\nContent-Disposition: form-data; name=\"payload\"\r\n\r\n" + payload + "\r\n--" + MultipartBoundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
  const String postamble = String("\r\n--") + MultipartBoundary + "--\r\n";
  const size_t contentLength = preamble.length() + imageFile.size() + postamble.length();

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(15000);
  if (!client.connect(host.c_str(), 443)) return false;
  client.printf("POST %s HTTP/1.1\r\nHost: %s\r\nContent-Type: multipart/form-data; boundary=%s\r\nContent-Length: %u\r\nX-Node-Id: %s\r\nX-Signature: %s\r\nConnection: close\r\n\r\n", path.c_str(), host.c_str(), MultipartBoundary, static_cast<unsigned>(contentLength), BAIDEE_NODE_ID, signature.c_str());
  client.print(preamble);
  uint8_t buffer[1024];
  while (imageFile.available()) {
    const size_t count = imageFile.read(buffer, sizeof(buffer));
    if (client.write(buffer, count) != count) return false;
  }
  client.print(postamble);
  const String statusLine = client.readStringUntil('\n');
  const bool accepted = statusLine.indexOf(" 2") > 0;
  client.stop();
  payloadFile.close();
  imageFile.close();
  if (accepted) {
    LittleFS.remove(PendingPayloadPath);
    LittleFS.remove(PendingImagePath);
    Serial.println("upload=accepted");
  } else {
    Serial.printf("upload=failed status=%s", statusLine.c_str());
  }
  return accepted;
}

void retryPending() {
  if (millis() - lastRetryAt < RetryIntervalMs) return;
  lastRetryAt = millis();
  uploadPending();
}

bool syncUtcTime() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  const uint32_t startedAt = millis();
  while (millis() - startedAt < 10000) {
    const time_t now = time(nullptr);
    if (now > 1700000000) return true;
    delay(250);
  }
  return false;
}

void connectNetwork() {
  if (!networkConfigured()) {
    Serial.println("wifi=not_configured");
    return;
  }

  const String ssid = activeSsid();
  const String password = activePassword();
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());
  Serial.printf("wifi_connecting ssid=%s\n", ssid.c_str());
  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 15000) {
    delay(250);
  }
  wifiReady = WiFi.status() == WL_CONNECTED;
  if (!wifiReady) {
    Serial.printf("wifi=failed status=%d\n", WiFi.status());
    return;
  }

  timeReady = syncUtcTime();
  Serial.printf("wifi=ready ip=%s ntp=%s rssi=%d\n",
    WiFi.localIP().toString().c_str(),
    timeReady ? "ready" : "failed",
    WiFi.RSSI());
  ArduinoOTA.setHostname(BAIDEE_NODE_ID);
  if (BAIDEE_OTA_PASSWORD[0] != '\0') ArduinoOTA.setPassword(BAIDEE_OTA_PASSWORD);
  ArduinoOTA.begin();
  otaReady = true;
}

// connectNetwork() only ever ran once, at boot. If that attempt failed (or
// Wi-Fi later dropped — a router reboot, moving the device, interference —
// wifiReady stayed stuck at whatever it was last set to, with nothing in
// loop() to ever retry. This checks the real WiFi.status() periodically and
// reconnects on its own, so the device recovers without a manual power cycle.
void maintainWifi() {
  if (!networkConfigured()) return;
  if (WiFi.status() == WL_CONNECTED) {
    wifiReady = true;
    return;
  }
  wifiReady = false;
  if (millis() - lastWifiRetryAt < WifiRetryIntervalMs) return;
  lastWifiRetryAt = millis();
  Serial.println("wifi_retry");
  connectNetwork();
}

void printHealth() {
  String ip = wifiReady ? WiFi.localIP().toString() : "-";
  Serial.printf("health camera=%s psram=%s wifi=%s ip=%s ntp=%s ota=%s upload=%s storage=%s interval_ms=%lu uptime_ms=%lu\n",
    cameraReady ? "ready" : "failed",
    psramFound() ? "available" : "missing",
    wifiReady ? "ready" : (networkConfigured() ? "failed" : "not_configured"),
    ip.c_str(),
    timeReady ? "ready" : "not_ready",
    otaReady ? "ready" : "not_ready",
    uploadConfigured() ? "configured" : "not_configured",
    storageReady ? "ready" : "failed",
    static_cast<unsigned long>(captureIntervalMs),
    static_cast<unsigned long>(millis()));
}

void captureFrame() {
  if (!cameraReady) return;

  camera_fb_t* frame = esp_camera_fb_get();
  if (frame == nullptr) {
    Serial.println("capture_failed=frame_buffer_null");
    return;
  }

  Serial.printf(
    "capture_ok bytes=%u width=%u height=%u format=%u psram=%s\n",
    static_cast<unsigned>(frame->len),
    static_cast<unsigned>(frame->width),
    static_cast<unsigned>(frame->height),
    static_cast<unsigned>(frame->format),
    psramFound() ? "true" : "false"
  );
  if (uploadConfigured() && timeReady) {
    const String timestamp = utcTimestamp();
    // timestamp is "YYYY-MM-DDTHH:MM:SSZ"; build "YYYYMMDDTHHMMSSZ_node" per the SSOT capture_id convention.
    const String captureId = timestamp.substring(0, 4) + timestamp.substring(5, 7) + timestamp.substring(8, 10)
      + "T" + timestamp.substring(11, 13) + timestamp.substring(14, 16) + timestamp.substring(17, 19)
      + "Z_" + BAIDEE_NODE_ID;
    const String payload = makePayload(captureId, timestamp, imageSha256(frame->buf, frame->len), frame->len);
    if (savePending(payload, frame->buf, frame->len)) uploadPending();
  }
  esp_camera_fb_return(frame);
}

void processSerialCommands() {
  if (!Serial.available()) return;
  const String command = Serial.readStringUntil('\n');
  if (command.equalsIgnoreCase("capture")) {
    captureFrame();
  } else if (command.equalsIgnoreCase("wifi")) {
    connectNetwork();
  } else if (command.equalsIgnoreCase("health")) {
    printHealth();
  } else if (command.equalsIgnoreCase("upload")) {
    uploadPending();
  } else if (command.equalsIgnoreCase("cmd")) {
    pollCommands();
  } else if (command.equalsIgnoreCase("hb")) {
    sendHeartbeat();
  } else {
    Serial.println("commands=capture|health|wifi|upload|cmd|hb");
  }
}
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(20);
  delay(300);

  Serial.printf("baidee_firmware=%s\n", FirmwareVersion);
  Serial.println("board=mb0184_esp32_s3_cam");
  Serial.printf("psram=%s flash_mb=%u\n", psramFound() ? "available" : "missing", ESP.getFlashChipSize() / (1024U * 1024U));

  initializeStorage();
  loadWifiOverride();
  loadConfigOverride();
  cameraReady = initializeCamera();
  Serial.printf("camera=%s\n", cameraReady ? "ready" : "failed");
  connectNetwork();
  captureFrame();
  sendHeartbeat();
  lastCaptureAt = millis();
  lastCmdPollAt = millis();
  lastHeartbeatAt = millis();
  lastWifiRetryAt = millis();
}

void loop() {
  processSerialCommands();
  maintainWifi();
  if (otaReady) ArduinoOTA.handle();
  retryPending();

  const uint32_t now = millis();
  if (now - lastCaptureAt >= captureIntervalMs) {
    captureFrame();
    lastCaptureAt = now;
  }
  if (now - lastCmdPollAt >= CmdPollIntervalMs) {
    pollCommands();
    lastCmdPollAt = now;
  }
  if (now - lastHeartbeatAt >= HeartbeatIntervalMs) {
    sendHeartbeat();
    lastHeartbeatAt = now;
  }
  delay(10);
}
