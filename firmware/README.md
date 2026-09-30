# ESP32-S3 firmware

Reserved for the C/C++ capture adapter described in Phase 1. The device contract is the shared payload schema in `contracts/payload.schema.json`.

Initial responsibilities:

- capture one configured row on schedule;
- sync UTC time;
- calculate the edge triage field without making a final diagnosis;
- upload multipart payloads with `X-Node-Id` and HMAC signature;
- retry and buffer when the network is unavailable;
- expose OTA and watchdog hooks.
