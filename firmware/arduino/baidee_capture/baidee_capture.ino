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

namespace {
constexpr uint32_t CaptureIntervalMs = BAIDEE_CAPTURE_INTERVAL_MS;
constexpr uint32_t RetryIntervalMs = BAIDEE_RETRY_INTERVAL_MS;
constexpr framesize_t CaptureFrameSize = FRAMESIZE_UXGA;
constexpr uint8_t JpegQuality = 10;
constexpr char PendingImagePath[] = "/pending.jpg";
constexpr char PendingPayloadPath[] = "/pending.json";
constexpr char MultipartBoundary[] = "----BaiDeeCaptureBoundary";

bool cameraReady = false;
bool wifiReady = false;
bool timeReady = false;
bool otaReady = false;
bool storageReady = false;
uint32_t lastCaptureAt = 0;
uint32_t lastRetryAt = 0;

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
  }
  return true;
}

bool networkConfigured() {
  return BAIDEE_WIFI_SSID[0] != '\0';
}

bool uploadConfigured() {
  return BAIDEE_WORKER_URL[0] != '\0' && BAIDEE_HMAC_SECRET[0] != '\0';
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
  payload += "\",\"image_size\":{\"w\":1600,\"h\":1200},\"stage\":\"edge_triage\",\"capture_meta\":{\"fw\":\"0.1.0\",\"bytes\":";
  payload += String(imageSize) + "}}";
  return payload;
}

bool initializeStorage() {
  storageReady = LittleFS.begin(true);
  Serial.printf("storage=%s\n", storageReady ? "ready" : "failed");
  return storageReady;
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

  WiFi.mode(WIFI_STA);
  WiFi.begin(BAIDEE_WIFI_SSID, BAIDEE_WIFI_PASSWORD);
  Serial.printf("wifi_connecting ssid=%s\n", BAIDEE_WIFI_SSID);
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

void printHealth() {
  String ip = wifiReady ? WiFi.localIP().toString() : "-";
  Serial.printf("health camera=%s psram=%s wifi=%s ip=%s ntp=%s ota=%s upload=%s storage=%s uptime_ms=%lu\n",
    cameraReady ? "ready" : "failed",
    psramFound() ? "available" : "missing",
    wifiReady ? "ready" : (networkConfigured() ? "failed" : "not_configured"),
    ip.c_str(),
    timeReady ? "ready" : "not_ready",
    otaReady ? "ready" : "not_ready",
    uploadConfigured() ? "configured" : "not_configured",
    storageReady ? "ready" : "failed",
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
    const String captureId = timestamp.substring(0, 4) + timestamp.substring(5, 7) + timestamp.substring(8, 10) + "T" + timestamp.substring(11, 17) + "Z_" + BAIDEE_NODE_ID;
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
  } else {
    Serial.println("commands=capture|health|wifi|upload");
  }
}
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(20);
  delay(300);

  Serial.println("baidee_firmware=0.1.0");
  Serial.println("board=mb0184_esp32_s3_cam");
  Serial.printf("psram=%s flash_mb=%u\n", psramFound() ? "available" : "missing", ESP.getFlashChipSize() / (1024U * 1024U));

  initializeStorage();
  cameraReady = initializeCamera();
  Serial.printf("camera=%s\n", cameraReady ? "ready" : "failed");
  connectNetwork();
  captureFrame();
  lastCaptureAt = millis();
}

void loop() {
  processSerialCommands();
  if (otaReady) ArduinoOTA.handle();
  retryPending();
  const uint32_t now = millis();
  if (now - lastCaptureAt >= CaptureIntervalMs) {
    captureFrame();
    lastCaptureAt = now;
  }
  delay(10);
}
