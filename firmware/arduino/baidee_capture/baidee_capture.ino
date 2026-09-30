#include "esp_camera.h"
#include <WiFi.h>
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

namespace {
constexpr uint32_t CaptureIntervalMs = 60UL * 1000UL;
constexpr framesize_t CaptureFrameSize = FRAMESIZE_UXGA;
constexpr uint8_t JpegQuality = 10;

bool cameraReady = false;
bool wifiReady = false;
bool timeReady = false;
uint32_t lastCaptureAt = 0;

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
}

void printHealth() {
  String ip = wifiReady ? WiFi.localIP().toString() : "-";
  Serial.printf("health camera=%s psram=%s wifi=%s ip=%s ntp=%s uptime_ms=%lu\n",
    cameraReady ? "ready" : "failed",
    psramFound() ? "available" : "missing",
    wifiReady ? "ready" : (networkConfigured() ? "failed" : "not_configured"),
    ip.c_str(),
    timeReady ? "ready" : "not_ready",
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
  } else {
    Serial.println("commands=capture|health|wifi");
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

  cameraReady = initializeCamera();
  Serial.printf("camera=%s\n", cameraReady ? "ready" : "failed");
  connectNetwork();
  captureFrame();
  lastCaptureAt = millis();
}

void loop() {
  processSerialCommands();
  const uint32_t now = millis();
  if (now - lastCaptureAt >= CaptureIntervalMs) {
    captureFrame();
    lastCaptureAt = now;
  }
  delay(10);
}
