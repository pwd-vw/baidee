# ESP32-S3 firmware

The first Arduino smoke test is in `firmware/arduino/baidee_capture/`. It targets the MB0184 ESP32-S3 CAM with OV3660 and validates camera capture before adding networking.

The device contract is the shared payload schema in `contracts/payload.schema.json`.

Initial responsibilities:

- capture one configured row on schedule;
- sync UTC time;
- calculate the edge triage field without making a final diagnosis;
- upload multipart payloads with `X-Node-Id` and HMAC signature;
- retry and buffer when the network is unavailable;
- expose OTA and watchdog hooks.

The smoke test intentionally stops before Wi-Fi and upload integration. Confirm stable JPEG capture and PSRAM first, then add provisioning, UTC time, HMAC upload, retry queue, and OTA.
