#!/usr/bin/env python3
"""Pull captures from the BaiDee Worker, run automatic quality checks, and
write a manifest.csv ready for Roboflow import (Phase 1.3).

Quality checks (SSOT section 1.3):
- blur: variance of the Laplacian (low variance ~= blurry)
- too dark / too bright: mean pixel brightness outside an acceptable band
- fog/washed-out hint: low contrast (small standard deviation) combined with
  high brightness, a rough proxy for lens condensation

Usage:
    python3 tools/organize_dataset.py \
        --worker-url https://baidee-api.<account>.workers.dev \
        --token "$BAIDEE_API_TOKEN" \
        --out-dir dataset/perilla \
        --node bd-s01-b01-c01
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

BLUR_VARIANCE_MIN = 60.0
BRIGHTNESS_DARK_MAX = 35.0
BRIGHTNESS_BRIGHT_MIN = 220.0
FOG_CONTRAST_MAX = 18.0
FOG_BRIGHTNESS_MIN = 150.0


@dataclass
class QualityResult:
    width: int
    height: int
    blur_variance: float
    brightness_mean: float
    brightness_std: float
    flags: list[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return len(self.flags) == 0


def laplacian_variance(gray: np.ndarray) -> float:
    kernel = np.array([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=np.float32)
    padded = np.pad(gray, 1, mode="edge").astype(np.float32)
    response = (
        padded[:-2, 1:-1] * kernel[0, 1]
        + padded[1:-1, :-2] * kernel[1, 0]
        + padded[1:-1, 1:-1] * kernel[1, 1]
        + padded[1:-1, 2:] * kernel[1, 2]
        + padded[2:, 1:-1] * kernel[2, 1]
    )
    return float(response.var())


def assess_quality(image_bytes: bytes) -> QualityResult:
    with Image.open(io.BytesIO(image_bytes)) as image:
        image = image.convert("L")
        width, height = image.size
        gray = np.asarray(image, dtype=np.float32)

    blur_variance = laplacian_variance(gray)
    brightness_mean = float(gray.mean())
    brightness_std = float(gray.std())

    flags: list[str] = []
    if blur_variance < BLUR_VARIANCE_MIN:
        flags.append("blurry")
    if brightness_mean < BRIGHTNESS_DARK_MAX:
        flags.append("too_dark")
    if brightness_mean > BRIGHTNESS_BRIGHT_MIN:
        flags.append("too_bright")
    if brightness_std < FOG_CONTRAST_MAX and brightness_mean > FOG_BRIGHTNESS_MIN:
        flags.append("possible_fog")

    return QualityResult(width, height, blur_variance, brightness_mean, brightness_std, flags)


def fetch_json(url: str, token: str) -> dict:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"request failed: {url} -> HTTP {error.code} {error.read().decode(errors='replace')}")


def fetch_bytes(url: str, token: str) -> bytes:
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def list_captures(worker_url: str, token: str, node: str | None, limit: int) -> list[dict]:
    query = f"?limit={limit}" + (f"&node={node}" if node else "")
    data = fetch_json(f"{worker_url}/v1/captures{query}", token)
    return data["captures"]


def organize(worker_url: str, token: str, out_dir: Path, node: str | None, limit: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.csv"
    captures = list_captures(worker_url, token, node, limit)
    print(f"fetched {len(captures)} capture records", file=sys.stderr)

    rows = []
    for capture in captures:
        capture_id = capture["capture_id"]
        image_url = f"{worker_url}/v1/image/{capture_id}"
        try:
            image_bytes = fetch_bytes(image_url, token)
        except urllib.error.HTTPError as error:
            print(f"skip {capture_id}: image fetch failed ({error.code})", file=sys.stderr)
            continue

        quality = assess_quality(image_bytes)
        date_dir = capture["captured_at"][:10].replace("-", "/")
        dest_dir = out_dir / date_dir
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / f"{capture_id}.jpg"
        dest_path.write_bytes(image_bytes)

        rows.append({
            "capture_id": capture_id,
            "node_id": capture["node_id"],
            "site_id": capture["site_id"],
            "bed_id": capture["bed_id"],
            "captured_at": capture["captured_at"],
            "stage": capture["stage"],
            "path": str(dest_path.relative_to(out_dir)),
            "width": quality.width,
            "height": quality.height,
            "blur_variance": round(quality.blur_variance, 1),
            "brightness_mean": round(quality.brightness_mean, 1),
            "brightness_std": round(quality.brightness_std, 1),
            "quality_flags": ";".join(quality.flags),
            "quality_ok": quality.passed,
        })

    with manifest_path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()) if rows else [
            "capture_id", "node_id", "site_id", "bed_id", "captured_at", "stage",
            "path", "width", "height", "blur_variance", "brightness_mean",
            "brightness_std", "quality_flags", "quality_ok",
        ])
        writer.writeheader()
        writer.writerows(rows)

    passed = sum(1 for row in rows if row["quality_ok"])
    print(f"wrote {len(rows)} rows to {manifest_path} ({passed} passed quality checks)", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--worker-url", required=True, help="e.g. https://baidee-api.<account>.workers.dev")
    parser.add_argument("--token", required=True, help="BAIDEE_API_TOKEN bearer value")
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--node", default=None, help="filter to one node_id")
    parser.add_argument("--limit", type=int, default=100, help="max captures to pull (Worker caps at 100 per call)")
    args = parser.parse_args()

    organize(args.worker_url.rstrip("/"), args.token, args.out_dir, args.node, args.limit)


if __name__ == "__main__":
    main()
