from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

DATA_DIR = Path(__file__).resolve().parents[3] / "data"
IMAGE_DIR = DATA_DIR / "images"
DB_PATH = DATA_DIR / "baidee.sqlite3"

app = FastAPI(title="BaiDee Edge", version="0.1.0")


def get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS captures (
            capture_id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            image_path TEXT NOT NULL,
            received_at TEXT NOT NULL
        )
        """
    )
    return connection


def validate_payload(payload: dict[str, object]) -> str:
    required = ("schema_version", "capture_id", "node_id", "timestamp", "image_sha256")
    missing = [field for field in required if field not in payload]
    if missing:
        raise HTTPException(status_code=422, detail=f"missing fields: {', '.join(missing)}")
    if payload["schema_version"] != "1.0":
        raise HTTPException(status_code=422, detail="unsupported schema_version")
    capture_id = payload["capture_id"]
    if not isinstance(capture_id, str) or not capture_id:
        raise HTTPException(status_code=422, detail="capture_id must be a non-empty string")
    return capture_id


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/ingest")
async def ingest(
    payload: str = Form(...),
    image: UploadFile = File(...),
) -> dict[str, object]:
    try:
        decoded = json.loads(payload)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="payload must be valid JSON") from error
    if not isinstance(decoded, dict):
        raise HTTPException(status_code=422, detail="payload must be a JSON object")

    capture_id = validate_payload(decoded)
    image_bytes = await image.read()
    actual_sha256 = hashlib.sha256(image_bytes).hexdigest()
    if decoded["image_sha256"] != actual_sha256:
        raise HTTPException(status_code=422, detail="image_sha256 does not match uploaded image")

    timestamp = datetime.fromisoformat(str(decoded["timestamp"]).replace("Z", "+00:00"))
    image_dir = IMAGE_DIR / timestamp.strftime("%Y/%m/%d")
    image_dir.mkdir(parents=True, exist_ok=True)
    image_path = image_dir / f"{capture_id}.jpg"

    connection = get_db()
    try:
        existing = connection.execute(
            "SELECT image_path FROM captures WHERE capture_id = ?", (capture_id,)
        ).fetchone()
        if existing:
            return {"accepted": True, "duplicate": True, "capture_id": capture_id}
        image_path.write_bytes(image_bytes)
        connection.execute(
            "INSERT INTO captures(capture_id, node_id, timestamp, payload_json, image_path, received_at) VALUES (?, ?, ?, ?, ?, ?)",
            (capture_id, str(decoded["node_id"]), str(decoded["timestamp"]), json.dumps(decoded), str(image_path), datetime.utcnow().isoformat() + "Z"),
        )
        connection.commit()
    finally:
        connection.close()

    return {"accepted": True, "duplicate": False, "capture_id": capture_id}
