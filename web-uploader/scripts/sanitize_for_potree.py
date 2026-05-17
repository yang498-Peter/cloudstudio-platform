#!/usr/bin/env python3
"""
Create a PotreeConverter-friendly LAS/LAZ copy.

- Removes extra dimensions that frequently crash PotreeConverter on Windows
- Preserves standard LAS dimensions when available
- Optionally remaps classification from RuleBasedClass for semantic outputs
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

import laspy
import numpy as np


STANDARD_COPY_FIELDS = [
    "intensity",
    "return_number",
    "number_of_returns",
    "scan_direction_flag",
    "edge_of_flight_line",
    "classification",
    "synthetic",
    "key_point",
    "withheld",
    "overlap",
    "scanner_channel",
    "scan_angle_rank",
    "scan_angle",
    "user_data",
    "point_source_id",
    "gps_time",
    "red",
    "green",
    "blue",
    "nir",
]


def parse_args(argv: list[str]) -> dict[str, str]:
    if len(argv) < 3:
      raise ValueError("Usage: sanitize_for_potree.py <input_las> <output_las> [classification_mode]")
    return {
      "input_path": argv[1],
      "output_path": argv[2],
      "classification_mode": argv[3] if len(argv) > 3 else "auto",
    }


def get_dimension_names(las) -> set[str]:
    return {str(name) for name in las.point_format.dimension_names}


def resolve_classification(source_las, mode: str) -> np.ndarray:
    available = get_dimension_names(source_las)
    original = np.asarray(source_las.classification, dtype=np.uint8)

    if mode == "original":
        return original

    if "RuleBasedClass" in set(source_las.point_format.extra_dimension_names):
        values = np.asarray(source_las["RuleBasedClass"], dtype=np.int32)
        clipped = np.clip(values, 0, 255).astype(np.uint8)
        return clipped

    if mode == "treeid" and "TreeId" in set(source_las.point_format.extra_dimension_names):
        tree_ids = np.asarray(source_las["TreeId"], dtype=np.int64)
        remapped = np.where(tree_ids > 0, (tree_ids % 31) + 1, 0)
        return np.clip(remapped, 0, 255).astype(np.uint8)

    if "classification" in available:
        return original

    return np.zeros(len(source_las.points), dtype=np.uint8)


def copy_standard_dimensions(source_las, target_las, classification_mode: str) -> dict[str, object]:
    source_names = get_dimension_names(source_las)
    copied = []
    skipped = []

    target_las.x = source_las.x
    target_las.y = source_las.y
    target_las.z = source_las.z
    copied.extend(["x", "y", "z"])

    for name in STANDARD_COPY_FIELDS:
        if name == "classification":
            target_las.classification = resolve_classification(source_las, classification_mode)
            copied.append("classification")
            continue
        if name not in source_names:
            skipped.append(name)
            continue
        try:
            setattr(target_las, name, getattr(source_las, name))
            copied.append(name)
        except Exception:
            skipped.append(name)

    return {
        "copied": copied,
        "skipped": skipped,
    }


def sanitize(input_path: str, output_path: str, classification_mode: str) -> dict[str, object]:
    source = laspy.read(input_path)
    header = laspy.LasHeader(
        point_format=source.header.point_format.id,
        version=source.header.version,
    )
    header.scales = source.header.scales
    header.offsets = source.header.offsets
    header.system_identifier = source.header.system_identifier
    header.generating_software = "CloudStudio Potree Prep"
    target = laspy.LasData(header)

    result = copy_standard_dimensions(source, target, classification_mode)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    target.write(str(output))
    result.update({
        "ok": True,
        "outputPath": str(output.resolve()),
        "pointCount": int(len(target.points)),
        "classificationMode": classification_mode,
    })
    return result


def main() -> None:
    try:
        params = parse_args(sys.argv)
        input_path = os.path.abspath(params["input_path"])
        output_path = os.path.abspath(params["output_path"])
        classification_mode = str(params["classification_mode"] or "auto")
        result = sanitize(input_path, output_path, classification_mode)
        print("RESULT:" + json.dumps(result), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        print("RESULT:" + json.dumps({"ok": False, "error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
