#!/usr/bin/env python3
"""Estimate camera coverage and pixel size for the Phase 1 experiment."""

from __future__ import annotations

import argparse
import math


def coverage(height_m: float, horizontal_fov_deg: float, vertical_fov_deg: float) -> tuple[float, float]:
    width = 2 * height_m * math.tan(math.radians(horizontal_fov_deg / 2))
    length = 2 * height_m * math.tan(math.radians(vertical_fov_deg / 2))
    return width, length


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--height-m", type=float, default=1.5)
    parser.add_argument("--horizontal-fov-deg", type=float, default=65.0)
    parser.add_argument("--vertical-fov-deg", type=float, default=51.0)
    parser.add_argument("--horizontal-pixels", type=int, default=1600)
    parser.add_argument("--target-mm", type=float, default=4.0)
    args = parser.parse_args()

    width_m, length_m = coverage(args.height_m, args.horizontal_fov_deg, args.vertical_fov_deg)
    mm_per_pixel = width_m * 1000 / args.horizontal_pixels
    target_pixels = args.target_mm / mm_per_pixel
    print(f"coverage_m={width_m:.3f}x{length_m:.3f}")
    print(f"ground_sample_distance_mm_per_pixel={mm_per_pixel:.3f}")
    print(f"target_object_pixels={target_pixels:.1f}")


if __name__ == "__main__":
    main()
