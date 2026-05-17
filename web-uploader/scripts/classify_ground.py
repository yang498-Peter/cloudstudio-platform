#!/usr/bin/env python3
"""
Ground-point classification for LAS/LAZ files using the CSF algorithm.

Usage:
    python classify_ground.py <input_las> <output_las>
      [cloth_resolution] [class_threshold] [rigidness] [iterations] [slope_smooth]

Arguments:
    input_las         Path to input LAS/LAZ file.
    output_las        Path to write classified LAS/LAZ.
    cloth_resolution  Cloth grid spacing in meters. Lower captures smaller terrain detail.
    class_threshold   Max distance to cloth surface for Class 2 ground.
    rigidness         Cloth stiffness from 1 (soft) to 3 (stiff).
    iterations        Cloth simulation iterations.
    slope_smooth      1 to enable steep-slope smoothing, 0 to disable.

The script preserves all point attributes and rewrites only classification values.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

import laspy
import numpy as np


DEFAULT_CLOTH_RESOLUTION = 0.5
DEFAULT_CLASS_THRESHOLD = 0.15
DEFAULT_RIGIDNESS = 2
DEFAULT_ITERATIONS = 500
DEFAULT_SLOPE_SMOOTH = True


def import_csf():
    try:
        import CSF  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "CSF dependency is not installed. Install the Python package "
            "'cloth-simulation-filter' in the runtime environment."
        ) from exc
    return CSF


def normalize_bool(value: str | int | bool | None, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def parse_args(argv: list[str]) -> dict[str, object]:
    if len(argv) < 3:
        raise ValueError(
            "Usage: classify_ground.py <input_las> <output_las> "
            "[cloth_resolution] [class_threshold] [rigidness] [iterations] [slope_smooth]"
        )

    return {
        "input_path": argv[1],
        "output_path": argv[2],
        "cloth_resolution": float(argv[3]) if len(argv) > 3 else DEFAULT_CLOTH_RESOLUTION,
        "class_threshold": float(argv[4]) if len(argv) > 4 else DEFAULT_CLASS_THRESHOLD,
        "rigidness": int(float(argv[5])) if len(argv) > 5 else DEFAULT_RIGIDNESS,
        "iterations": int(float(argv[6])) if len(argv) > 6 else DEFAULT_ITERATIONS,
        "slope_smooth": normalize_bool(argv[7], DEFAULT_SLOPE_SMOOTH) if len(argv) > 7 else DEFAULT_SLOPE_SMOOTH,
    }


def load_las(path: str):
    las = laspy.read(path)
    point_count = len(las.points)
    if point_count == 0:
        raise ValueError("LAS/LAZ file has 0 points")

    xyz = np.column_stack((las.x, las.y, las.z)).astype(np.float64, copy=False)
    print(
        f"[Classify] Loaded {point_count:,} points "
        f"(point_format={las.header.point_format.id}, version={las.header.version})",
        flush=True,
    )
    return las, xyz


def classify_ground_csf(
    xyz: np.ndarray,
    *,
    cloth_resolution: float,
    class_threshold: float,
    rigidness: int,
    iterations: int,
    slope_smooth: bool,
) -> np.ndarray:
    CSF = import_csf()

    csf = CSF.CSF()
    csf.params.cloth_resolution = float(cloth_resolution)
    csf.params.class_threshold = float(class_threshold)
    csf.params.rigidness = int(max(1, min(3, rigidness)))
    csf.params.bSloopSmooth = bool(slope_smooth)
    if hasattr(csf.params, "interations"):
        csf.params.interations = int(max(50, iterations))
    if hasattr(csf.params, "iterations"):
        csf.params.iterations = int(max(50, iterations))

    point_cloud = np.ascontiguousarray(xyz, dtype=np.float64)
    try:
        csf.setPointCloud(point_cloud)
    except TypeError:
        # Older bindings may only accept a Python list payload.
        csf.setPointCloud(point_cloud.tolist())

    ground_indexes = CSF.VecInt()
    non_ground_indexes = CSF.VecInt()
    csf.do_filtering(ground_indexes, non_ground_indexes, False)

    is_ground = np.zeros(len(xyz), dtype=bool)
    if len(ground_indexes):
        is_ground[np.asarray(list(ground_indexes), dtype=np.int64)] = True
    return is_ground


def apply_classification(las, is_ground: np.ndarray) -> tuple[int, int]:
    current = np.asarray(las.classification, dtype=np.uint8).copy()
    updated = current.copy()

    updated[is_ground] = 2

    if np.any(~is_ground):
        non_ground = ~is_ground
        reclassify = non_ground & (current <= 2)
        updated[reclassify] = 1

    las.classification = updated
    return int(is_ground.sum()), len(updated)


def save_las(las, output_path: str) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    las.write(str(output))
    print(f"[Classify] Written: {output}", flush=True)


def main() -> None:
    try:
        params = parse_args(sys.argv)
        input_path = os.path.abspath(str(params["input_path"]))
        output_path = os.path.abspath(str(params["output_path"]))

        print(f"[Classify] Input : {input_path}", flush=True)
        print(f"[Classify] Output: {output_path}", flush=True)
        print(
            "[Classify] CSF params: "
            f"cloth_resolution={params['cloth_resolution']}m  "
            f"class_threshold={params['class_threshold']}m  "
            f"rigidness={params['rigidness']}  "
            f"iterations={params['iterations']}  "
            f"slope_smooth={bool(params['slope_smooth'])}",
            flush=True,
        )

        las, xyz = load_las(input_path)
        is_ground = classify_ground_csf(
            xyz,
            cloth_resolution=float(params["cloth_resolution"]),
            class_threshold=float(params["class_threshold"]),
            rigidness=int(params["rigidness"]),
            iterations=int(params["iterations"]),
            slope_smooth=bool(params["slope_smooth"]),
        )

        n_ground, n_total = apply_classification(las, is_ground)
        ground_pct = round((100.0 * n_ground / n_total) if n_total else 0.0, 2)
        print(f"[Classify] Ground points: {n_ground:,} / {n_total:,} ({ground_pct:.2f}%)", flush=True)

        save_las(las, output_path)

        print(
            "RESULT:" + json.dumps(
                {
                    "ok": True,
                    "algorithm": "CSF",
                    "outputPath": output_path,
                    "nTotal": int(n_total),
                    "nGround": int(n_ground),
                    "groundPct": ground_pct,
                    "clothResolution": float(params["cloth_resolution"]),
                    "classThreshold": float(params["class_threshold"]),
                    "rigidness": int(params["rigidness"]),
                    "iterations": int(params["iterations"]),
                    "slopeSmooth": bool(params["slope_smooth"]),
                }
            ),
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        print("RESULT:" + json.dumps({"ok": False, "error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
