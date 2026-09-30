# BaiDee (ใบดี)

BaiDee is a commercial-ready leaf health monitoring platform for greenhouse farms.
The first implementation targets one row and one camera node, with contracts that can expand to multiple rows, zones, and crops.

## Current slice

- `cloud/`: Cloudflare Worker ingest API with R2 image storage and D1 metadata.
- `edge/`: Raspberry Pi FastAPI receiver with local SQLite buffering.
- `contracts/`: shared payload and class/layout contracts.
- `tools/`: coverage planning utilities.
- `firmware/`: reserved for the ESP32-S3 C/C++ adapter.
- `ml/`: dataset and model artifacts, beginning with fixed class IDs.

## Quick start

```sh
npm install
npm run typecheck
npm run test

python3 -m venv .venv
. .venv/bin/activate
pip install -e ./edge
uvicorn baidee_edge.main:app --reload
```

The edge API listens on `http://127.0.0.1:8000`. The cloud Worker can be run with `npm run dev:cloud` after configuring local bindings in `cloud/wrangler.jsonc`.

## Product decisions

- Phase 1 starts with one row; row and zone counts are configuration, not hardcoded behavior.
- Network distance and shade-cloth conditions are operational parameters and can be changed without redesigning the software contracts.
- Experienced farmers are the label reviewers and have granted commercial-use permission for the collected data.
- The product is aimed at commercial presentation to farmers; third-party licenses must be recorded before release.

The full product SSOT is [BaiDee_SSOT.md](BaiDee_SSOT.md).
