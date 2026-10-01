# BaiDee capture firmware

Target board: MB0184 ESP32-S3 CAM, ESP32-S3-WROOM-1-N16R8, OV3660.

Current version: `0.2.0` (Phase 1.1 camera/Wi-Fi/upload foundation + Phase 1.2 remote command/heartbeat channel).

## Arduino IDE settings

- Board: `ESP32S3 Dev Module`
- USB port: USB TTL / CH340C, not OTG
- Flash Size: 16MB
- PSRAM: OPI PSRAM
- Upload Speed: 115200 for the first upload
- Port: `/dev/cu.usbserial-110` or the current CH340 port

Equivalent `arduino-cli` commands used during development:

```bash
arduino-cli compile --fqbn 'esp32:esp32:esp32s3:UploadSpeed=115200,FlashSize=16M,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=default,UploadMode=default,EraseFlash=none' firmware/arduino/baidee_capture
arduino-cli upload --port /dev/cu.usbserial-110 --fqbn 'esp32:esp32:esp32s3:UploadSpeed=115200,FlashSize=16M,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=default,UploadMode=default,EraseFlash=none' firmware/arduino/baidee_capture
```

## Configuration (`config.h`)

Copy `config.h.example` to `config.h` and fill in real values. `config.h` is ignored by Git (per-device secrets never get committed).

| Macro | Purpose | If left unset in `config.h` |
|---|---|---|
| `BAIDEE_WIFI_SSID` / `BAIDEE_WIFI_PASSWORD` | Wi-Fi STA credentials | Firmware stays camera-only, never attempts Wi-Fi |
| `BAIDEE_WORKER_URL` | Full ingest URL, e.g. `https://<worker>.workers.dev/v1/ingest` | Upload, command polling, and heartbeat are all disabled |
| `BAIDEE_NODE_ID` | Device identity used in payloads, HMAC signing, and OTA hostname | Defaults to `bd-s01-b01-c01` even without `config.h` |
| `BAIDEE_HMAC_SECRET` | Shared secret with the Worker (`BAIDEE_HMAC_SECRET` Worker secret) | Upload/cmd/heartbeat requests will fail signature checks |
| `BAIDEE_OTA_PASSWORD` | Password for `ArduinoOTA` | OTA runs without a password — set a real one before field use |
| `BAIDEE_CAPTURE_INTERVAL_MS` | Scheduled capture interval (startup default) | Falls back to the in-`.ino` default; can still be changed later at runtime, see below |
| `BAIDEE_RETRY_INTERVAL_MS` | How often a failed upload is retried from the LittleFS queue | Defaults to 5 minutes |
| `BAIDEE_CMD_POLL_INTERVAL_MS` | How often the device polls `GET /v1/cmd` | Defaults to 10 seconds (keeps `capture_now` latency under ~30s) |
| `BAIDEE_HEARTBEAT_INTERVAL_MS` | How often the device reports status via `POST /v1/heartbeat` | Defaults to 10 minutes |
| `BAIDEE_CAMERA_HMIRROR` | `1`/`0` — mirror the frame left-to-right | Defaults to `1` (mirrored), matching this camera's physical mounting so in-frame text/markers read correctly |
| `BAIDEE_CAMERA_VFLIP` | `1`/`0` — flip the frame top-to-bottom | Defaults to `0` |

If `config.h` defines a macro, that value always wins over the `.ino` default (standard C preprocessor `#ifndef` guard) — there is no later runtime override of these specific macros.

`BAIDEE_CAPTURE_INTERVAL_MS` is only the **startup** value, though: it can be changed afterwards without reflashing via the `set_config` remote command (see below), which persists the new interval to LittleFS (`/config.json`) and survives reboots.

## Runtime behavior

On boot the firmware:
1. Mounts LittleFS, loads any saved Wi-Fi override (`/wifi.json`) and capture-interval override (`/config.json`) from previous `set_wifi`/`set_config` commands.
2. Initializes the OV3660 camera (JPEG, `UXGA`, quality 10).
3. Connects Wi-Fi (if configured) and syncs UTC time via NTP.
4. Starts `ArduinoOTA` once Wi-Fi is up.
5. Captures one frame, sends an initial heartbeat.

Then in the main loop, on independent timers:

| Task | Interval | What it does |
|---|---|---|
| Scheduled capture | `captureIntervalMs` (runtime-adjustable) | Captures a JPEG, builds the payload, saves it to LittleFS, and uploads it |
| Upload retry | `BAIDEE_RETRY_INTERVAL_MS` | Retries the single pending capture if the last upload failed |
| Command poll | `BAIDEE_CMD_POLL_INTERVAL_MS` | `GET /v1/cmd?node=<id>` (HMAC-signed), executes and acks one queued command per poll |
| Heartbeat | `BAIDEE_HEARTBEAT_INTERVAL_MS` | `POST /v1/heartbeat` with fw version, Wi-Fi IP/RSSI, uptime, camera/PSRAM/storage state, current capture interval |

### Remote commands (`/v1/cmd`)

Commands are queued from the Cloudflare dashboard (`/dashboard`) or directly via `POST /v1/cmd`, and the device picks them up on its next poll:

- `capture_now` — captures and uploads immediately, independent of the scheduled interval
- `set_wifi` (`args: {ssid, password}`) — writes `/wifi.json` in LittleFS and reconnects immediately with the new credentials
- `set_config` (`args: {capture_interval_ms}`) — writes `/config.json` and updates the live interval (minimum 60000 ms)

Every executed command is acknowledged back to the Worker (`POST /v1/cmd/ack`, HMAC-signed over `node_id:command_id:status`) with `status: done` or `failed` plus a short message, so the dashboard's command history reflects real outcomes.

### Capture ID format

`capture_id` is built as `yyyymmddThhmmssZ_<node_id>` from the UTC timestamp (SSOT §3 naming convention) — e.g. `20260930T172037Z_bd-s01-b01-c01`. This must stay unique per minute-resolution-or-finer; the Worker treats a repeated `capture_id` as an idempotent duplicate and silently skips storing it again.

### Upload queue

Only the single most recent capture is buffered in LittleFS (`/pending.jpg` + `/pending.json`) at a time — this bounds flash usage while offline, per the development guardrails in `docs/DEV_GUARDRAILS.md`, but means a capture is overwritten by the next one before a slow retry succeeds.

## Serial commands

Open Serial Monitor at `115200` baud:

- `health` — print camera/Wi-Fi/NTP/OTA/upload/storage state, current capture interval, and uptime
- `capture` — capture one frame immediately
- `wifi` — connect or reconnect and sync UTC time with NTP
- `upload` — retry the pending capture immediately
- `cmd` — poll `/v1/cmd` immediately (same as the scheduled poll)
- `hb` — send a heartbeat immediately

## Known limitations

- TLS uses `WiFiClientSecure::setInsecure()` (no certificate validation). Required before commercial deployment — see `docs/DEV_GUARDRAILS.md`.
- `set_wifi` sends the new Wi-Fi password to the Worker and it is stored as plaintext in D1 (`commands.args_json`) until the command is delivered. Acceptable for lab use only — see SSOT risk R11.
- The hand-rolled JSON string/number extraction (`extractJsonString`/`extractJsonNumber`) assumes the Worker's own small, self-generated JSON shapes; it does not handle escaped quotes inside values.
- `pollCommands()` only executes one queued command per poll interval; a burst of several commands drains at one per `BAIDEE_CMD_POLL_INTERVAL_MS`.
