# BaiDee capture smoke test

Target board: MB0184 ESP32-S3 CAM, ESP32-S3-WROOM-1-N16R8, OV3660.

## Arduino IDE settings

- Board: `ESP32S3 Dev Module`
- USB port: USB TTL / CH340C, not OTG
- Flash Size: 16MB
- PSRAM: OPI PSRAM
- Upload Speed: 115200 for the first upload
- Port: `/dev/cu.usbserial-110` or the current CH340 port

Upload `baidee_capture.ino`, then open Serial Monitor at `115200` baud. The firmware captures one JPEG at startup and every 60 seconds.

Optional Wi-Fi/NTP/upload setup is enabled by copying `config.h.example` to `config.h` and filling in the local network, Worker URL, node ID, HMAC secret, and OTA password. `config.h` is ignored by Git. Without it, the firmware remains usable in camera-only mode.

Serial commands:

- `health`: print camera, PSRAM, and uptime state
- `capture`: capture one frame immediately
- `wifi`: connect or reconnect and sync UTC time with NTP
- `upload`: retry the pending capture immediately

When upload is configured, the latest failed capture is stored in LittleFS and retried every 30 seconds. HTTPS certificate pinning is still required before commercial deployment; the current smoke test uses an insecure TLS client after HMAC authentication.

This is the Phase 1.1 hardware smoke test. It does not yet connect Wi-Fi, upload images, run triage, or configure OTA. Those behaviors are added after camera stability is proven.
