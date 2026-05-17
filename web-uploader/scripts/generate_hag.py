#!/usr/bin/env python3
"""
Generate Height Above Ground (HAG / AGL) for LAS/LAZ files.

This follows the core idea of PDAL's hag_nn:
1. Use already-classified ground points (default: Class 2) as the terrain samples.
2. Build a nearest-neighbor index in XY.
3. Interpolate the local ground elevation from the nearest ground neighbors.
4. Store HeightAboveGround as an extra LAS dimension.

Usage:
    python generate_hag.py <input_las> <output_las>
      [neighbor_count] [ground_class] [weight_power] [height_dim_name]
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

import laspy
import numpy as np
from scipy.spatial import cKDTree


DEFAULT_NEIGHBOR_COUNT = 8
DEFAULT_GROUND_CLASS = 2
DEFAULT_WEIGHT_POWER = 2.0
DEFAULT_HEIGHT_DIM_NAME = "HeightAboveGround"
QUERY_BATCH_SIZE = 250_000


def parse_args(argv: list[str]) -> dict[str, object]:
    if len(argv) < 3:
        raise ValueError(
            "Usage: generate_hag.py <input_las> <output_las> "
            "[neighbor_count] [ground_class] [weight_power] [height_dim_name]"
        )

    return {
        "input_path": argv[1],
        "output_path": argv[2],
        "neighbor_count": int(float(argv[3])) if len(argv) > 3 else DEFAULT_NEIGHBOR_COUNT,
        "ground_class": int(float(argv[4])) if len(argv) > 4 else DEFAULT_GROUND_CLASS,
        "weight_power": float(argv[5]) if len(argv) > 5 else DEFAULT_WEIGHT_POWER,
        "height_dim_name": str(argv[6]) if len(argv) > 6 else DEFAULT_HEIGHT_DIM_NAME,
    }


def load_las(path: str):
    las = laspy.read(path)
    point_count = len(las.points)
    if point_count == 0:
        raise ValueError("LAS/LAZ file has 0 points")

    xyz = np.column_stack((las.x, las.y, las.z)).astype(np.float64, copy=False)
    classification = np.asarray(las.classification, dtype=np.uint8)

    print(
        f"[HAG] Loaded {point_count:,} points "
        f"(point_format={las.header.point_format.id}, version={las.header.version})",
        flush=True,
    )
    return las, xyz, classification


def interpolate_ground_surface(
    xyz: np.ndarray,
    ground_mask: np.ndarray,
    *,
    neighbor_count: int,
    weight_power: float,
) -> np.ndarray:
    ground_xyz = xyz[ground_mask]
    if len(ground_xyz) == 0:
        raise ValueError("No ground points found. Run ground classification first.")

    if len(ground_xyz) == 1:
        return np.full(len(xyz), ground_xyz[0, 2], dtype=np.float32)

    xy = xyz[:, :2]
    ground_xy = ground_xyz[:, :2]
    ground_z = ground_xyz[:, 2]
    tree = cKDTree(ground_xy)
    k = max(1, min(int(neighbor_count), len(ground_xyz)))

    surface_z = np.empty(len(xyz), dtype=np.float64)

    for start in range(0, len(xyz), QUERY_BATCH_SIZE):
        end = min(start + QUERY_BATCH_SIZE, len(xyz))
        distances, indexes = tree.query(xy[start:end], k=k, workers=-1)

        if k == 1:
            surface_z[start:end] = ground_z[np.asarray(indexes, dtype=np.int64)]
            continue

        distances = np.asarray(distances, dtype=np.float64)
        indexes = np.asarray(indexes, dtype=np.int64)
        local_ground_z = ground_z[indexes]

        zero_mask = distances <= 1e-12
        weights = np.zeros_like(distances, dtype=np.float64)

        rows_with_zero = np.any(zero_mask, axis=1)
        if np.any(rows_with_zero):
            weights[rows_with_zero] = zero_mask[rows_with_zero].astype(np.float64)

        rows_without_zero = ~rows_with_zero
        if np.any(rows_without_zero):
            safe_distances = np.maximum(distances[rows_without_zero], 1e-12)
            inv = 1.0 / np.power(safe_distances, max(weight_power, 1e-6))
            weights[rows_without_zero] = inv / np.sum(inv, axis=1, keepdims=True)

        surface_z[start:end] = np.sum(local_ground_z * weights, axis=1)

    return surface_z.astype(np.float32)


def ensure_extra_dimension(las, height_dim_name: str) -> None:
    existing = set(las.point_format.extra_dimension_names)
    if height_dim_name in existing:
        return

    description = "Height above nearest ground"[:32]
    las.add_extra_dim(
        laspy.ExtraBytesParams(
            name=height_dim_name,
            type=np.float32,
            description=description,
        )
    )


def write_height_dimension(las, height_dim_name: str, hag: np.ndarray) -> None:
    ensure_extra_dimension(las, height_dim_name)
    las[height_dim_name] = np.asarray(hag, dtype=np.float32)


def compute_hag(
    xyz: np.ndarray,
    classification: np.ndarray,
    *,
    ground_class: int,
    neighbor_count: int,
    weight_power: float,
) -> tuple[np.ndarray, int]:
    ground_mask = classification == int(ground_class)
    ground_count = int(np.sum(ground_mask))
    if ground_count == 0:
        raise ValueError(f"No Class {ground_class} ground points found in the LAS/LAZ file.")

    surface_z = interpolate_ground_surface(
        xyz,
        ground_mask,
        neighbor_count=neighbor_count,
        weight_power=weight_power,
    )
    hag = xyz[:, 2].astype(np.float32) - surface_z
    return hag, ground_count


def save_las(las, output_path: str) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    las.write(str(output))
    print(f"[HAG] Written: {output}", flush=True)


def build_stats(hag: np.ndarray, ground_count: int, point_count: int, height_dim_name: str) -> dict[str, object]:
    return {
        "dimension": height_dim_name,
        "pointCount": int(point_count),
        "groundPointCount": int(ground_count),
        "min": float(np.min(hag)),
        "max": float(np.max(hag)),
        "mean": float(np.mean(hag)),
        "median": float(np.median(hag)),
        "p95": float(np.percentile(hag, 95)),
    }


def main() -> None:
    try:
        params = parse_args(sys.argv)
        input_path = os.path.abspath(str(params["input_path"]))
        output_path = os.path.abspath(str(params["output_path"]))
        neighbor_count = int(params["neighbor_count"])
        ground_class = int(params["ground_class"])
        weight_power = float(params["weight_power"])
        height_dim_name = str(params["height_dim_name"] or DEFAULT_HEIGHT_DIM_NAME)

        print(f"[HAG] Input : {input_path}", flush=True)
        print(f"[HAG] Output: {output_path}", flush=True)
        print(
            f"[HAG] Params: k={neighbor_count} groundClass={ground_class} "
            f"weightPower={weight_power} dim={height_dim_name}",
            flush=True,
        )

        las, xyz, classification = load_las(input_path)
        hag, ground_count = compute_hag(
            xyz,
            classification,
            ground_class=ground_class,
            neighbor_count=neighbor_count,
            weight_power=weight_power,
        )

        write_height_dimension(las, height_dim_name, hag)
        save_las(las, output_path)

        stats = build_stats(hag, ground_count, len(xyz), height_dim_name)
        print("RESULT:" + json.dumps({"ok": True, "outputPath": output_path, "stats": stats}), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        print("RESULT:" + json.dumps({"ok": False, "error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
