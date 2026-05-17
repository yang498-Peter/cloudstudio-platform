#!/usr/bin/env python3
"""
Rule-based baseline semantic classification for LAS/LAZ files.

Expected upstream inputs:
- ground already classified (default Class 2)
- HeightAboveGround extra dimension already computed
- geometric feature dimensions already computed

Writes:
- RuleBasedClass
- RuleBasedConfidence

RuleBasedClass mapping:
1 = unclassified
2 = ground
3 = low vegetation
4 = medium vegetation
5 = high vegetation
6 = building candidate
7 = noise / outlier candidate
8 = pole / linear object candidate
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

import laspy
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree


DEFAULT_GROUND_CLASS = 2
DEFAULT_HAG_DIM = "HeightAboveGround"


FEATURE_NAMES = [
    "Linearity",
    "Planarity",
    "Sphericity",
    "Omnivariance",
    "SurfaceVariation",
    "Verticality",
    "NormalZ",
    "Roughness",
    "MeanNeighborDistance",
    "LocalHeightRange",
    "PointDensity2D",
]


CLASS_LABELS = {
    1: "unclassified",
    2: "ground",
    3: "low_vegetation",
    4: "medium_vegetation",
    5: "high_vegetation",
    6: "building_candidate",
    7: "noise_candidate",
    8: "pole_candidate",
}

SEMANTIC_CLASSES = {3, 4, 5, 6, 7, 8}
MAX_GRID_CELLS = 10_000_000


def parse_args(argv: list[str]) -> dict[str, object]:
    if len(argv) < 3:
        raise ValueError(
            "Usage: classify_rule_based.py <input_las> <output_las> [ground_class] [hag_dimension]"
        )

    return {
        "input_path": argv[1],
        "output_path": argv[2],
        "ground_class": int(float(argv[3])) if len(argv) > 3 else DEFAULT_GROUND_CLASS,
        "hag_dimension": str(argv[4]) if len(argv) > 4 else DEFAULT_HAG_DIM,
    }


def load_las(path: str):
    las = laspy.read(path)
    point_count = len(las.points)
    if point_count == 0:
        raise ValueError("LAS/LAZ file has 0 points")
    xyz = np.column_stack((las.x, las.y, las.z)).astype(np.float64, copy=False)
    return las, xyz


def require_dimension(las, name: str) -> np.ndarray:
    try:
        return np.asarray(las[name], dtype=np.float32)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Required LAS dimension not found: {name}") from exc


def ensure_extra_dimension(las, name: str, description: str) -> None:
    existing = set(las.point_format.extra_dimension_names)
    if name in existing:
        return
    las.add_extra_dim(
        laspy.ExtraBytesParams(
            name=name,
            type=np.float32,
            description=str(description or "")[:32],
        )
    )


def ensure_u8_dimension(las, name: str, description: str) -> None:
    existing = set(las.point_format.extra_dimension_names)
    if name in existing:
        return
    las.add_extra_dim(
        laspy.ExtraBytesParams(
            name=name,
            type=np.uint8,
            description=str(description or "")[:32],
        )
    )


def safe_dimension(features: dict[str, np.ndarray], name: str, default: float = 0.0) -> np.ndarray:
    sample = next(iter(features.values()))
    return np.asarray(features.get(name, np.full(len(sample), default, dtype=np.float32)), dtype=np.float32)


def resolve_grid_shape(x_span: float, y_span: float, resolution: float) -> tuple[float, int, int]:
    cell_size = max(float(resolution), 0.25)
    rows = int(np.floor(y_span / cell_size)) + 1
    cols = int(np.floor(x_span / cell_size)) + 1
    while rows * cols > MAX_GRID_CELLS:
        cell_size *= 1.35
        rows = int(np.floor(y_span / cell_size)) + 1
        cols = int(np.floor(x_span / cell_size)) + 1
    return cell_size, rows, cols


def raster_connected_components(points_xy: np.ndarray, *, resolution: float) -> np.ndarray:
    if len(points_xy) == 0:
        return np.empty(0, dtype=np.int32)

    x_min = float(np.min(points_xy[:, 0]))
    y_min = float(np.min(points_xy[:, 1]))
    x_span = float(np.max(points_xy[:, 0]) - x_min)
    y_span = float(np.max(points_xy[:, 1]) - y_min)
    cell_size, rows, cols = resolve_grid_shape(x_span, y_span, resolution)
    cols_idx = np.floor((points_xy[:, 0] - x_min) / cell_size).astype(np.int32)
    rows_idx = np.floor((points_xy[:, 1] - y_min) / cell_size).astype(np.int32)
    occupancy = np.zeros((rows, cols), dtype=bool)
    occupancy[rows_idx, cols_idx] = True
    labeled, _ = ndimage.label(occupancy, structure=np.ones((3, 3), dtype=np.uint8))
    return labeled[rows_idx, cols_idx].astype(np.int32)


def refine_class_components(
    xyz: np.ndarray,
    hag: np.ndarray,
    rule_class: np.ndarray,
    confidence: np.ndarray,
    features: dict[str, np.ndarray],
) -> tuple[np.ndarray, np.ndarray]:
    refined_class = rule_class.copy()
    refined_confidence = confidence.copy()
    planarity = features["Planarity"]
    linearity = features["Linearity"]
    verticality = features["Verticality"]
    roughness = features["Roughness"]
    local_height_range = safe_dimension(features, "LocalHeightRange")

    building_mask = refined_class == 6
    if np.count_nonzero(building_mask) >= 24:
        building_points = xyz[building_mask, :2]
        labels = raster_connected_components(building_points, resolution=1.0)
        building_indices = np.where(building_mask)[0]
        for label in np.unique(labels[labels > 0]):
            cluster_idx = building_indices[labels == label]
            xy_extent = np.ptp(xyz[cluster_idx, :2], axis=0)
            max_xy_extent = float(np.max(xy_extent))
            mean_planarity = float(np.mean(planarity[cluster_idx]))
            mean_roughness = float(np.mean(roughness[cluster_idx]))
            mean_verticality = float(np.mean(verticality[cluster_idx]))
            height_span = float(np.ptp(hag[cluster_idx]))
            median_hag = float(np.median(hag[cluster_idx]))
            footprint_area = float(max_xy_extent * max(0.2, float(np.min(xy_extent))))
            if (
                len(cluster_idx) < 30
                or max_xy_extent < 1.4
                or mean_planarity < 0.48
                or mean_roughness > 0.22
                or mean_verticality > 0.34
                or height_span > 2.5
                or (median_hag > 8.0 and footprint_area < 180.0)
            ):
                fallback = np.where(hag[cluster_idx] >= 3.0, 5, np.where(hag[cluster_idx] >= 1.0, 4, 3))
                refined_class[cluster_idx] = fallback.astype(np.uint8)
                refined_confidence[cluster_idx] = np.maximum(refined_confidence[cluster_idx] * 0.7, 0.42)

    pole_mask = refined_class == 8
    if np.count_nonzero(pole_mask) >= 10:
        pole_points = xyz[pole_mask, :2]
        labels = raster_connected_components(pole_points, resolution=0.5)
        pole_indices = np.where(pole_mask)[0]
        for label in np.unique(labels[labels > 0]):
            cluster_idx = pole_indices[labels == label]
            xy_extent = np.ptp(xyz[cluster_idx, :2], axis=0)
            z_span = float(np.ptp(xyz[cluster_idx, 2]))
            min_hag = float(np.min(hag[cluster_idx]))
            median_hag = float(np.median(hag[cluster_idx]))
            mean_linearity = float(np.mean(linearity[cluster_idx]))
            mean_verticality = float(np.mean(verticality[cluster_idx]))
            mean_local_height_range = float(np.mean(local_height_range[cluster_idx]))
            if (
                len(cluster_idx) < 6
                or float(np.max(xy_extent)) > 1.3
                or z_span < 1.8
                or mean_linearity < 0.52
                or mean_verticality < 0.65
                or mean_local_height_range < 0.55
                or min_hag > 3.5
                or (median_hag > 8.0 and z_span < 6.0)
            ):
                fallback = np.where(hag[cluster_idx] >= 3.0, 5, np.where(hag[cluster_idx] >= 1.0, 4, 3))
                refined_class[cluster_idx] = fallback.astype(np.uint8)
                refined_confidence[cluster_idx] = np.maximum(refined_confidence[cluster_idx] * 0.75, 0.4)

    noise_mask = refined_class == 7
    if np.count_nonzero(noise_mask) >= 6:
        noise_points = xyz[noise_mask, :2]
        labels = raster_connected_components(noise_points, resolution=1.0)
        noise_indices = np.where(noise_mask)[0]
        clustered_noise = noise_indices[labels > 0]
        if len(clustered_noise):
            fallback = np.where(hag[clustered_noise] >= 3.0, 5, np.where(hag[clustered_noise] >= 1.0, 4, np.where(hag[clustered_noise] >= 0.15, 3, 1)))
            refined_class[clustered_noise] = fallback.astype(np.uint8)
            refined_confidence[clustered_noise] = np.maximum(refined_confidence[clustered_noise] * 0.6, 0.25)

    return refined_class, refined_confidence


def smooth_semantic_classes(
    xyz: np.ndarray,
    initial_class: np.ndarray,
    confidence: np.ndarray,
    *,
    k: int = 10,
) -> np.ndarray:
    if len(xyz) < 12:
        return initial_class

    smoothed = initial_class.copy()
    tree = cKDTree(xyz[:, :2])
    _, indexes = tree.query(xyz[:, :2], k=min(k + 1, len(xyz)), workers=-1)
    indexes = np.asarray(indexes, dtype=np.int64)
    if indexes.ndim == 1:
        return smoothed

    for point_index in range(len(xyz)):
        current = int(initial_class[point_index])
        if current not in SEMANTIC_CLASSES:
            continue
        if confidence[point_index] >= 0.82:
            continue

        neighbor_classes = initial_class[indexes[point_index, 1:]]
        valid_neighbors = neighbor_classes[np.isin(neighbor_classes, list(SEMANTIC_CLASSES))]
        if len(valid_neighbors) < 4:
            continue

        unique, counts = np.unique(valid_neighbors, return_counts=True)
        winner = int(unique[np.argmax(counts)])
        if winner != current and counts.max() >= max(4, int(0.55 * len(valid_neighbors))):
            smoothed[point_index] = winner

    return smoothed


def classify_points(
    xyz: np.ndarray,
    classification: np.ndarray,
    hag: np.ndarray,
    features: dict[str, np.ndarray],
    *,
    ground_class: int,
) -> tuple[np.ndarray, np.ndarray]:
    linearity = features["Linearity"]
    planarity = features["Planarity"]
    sphericity = safe_dimension(features, "Sphericity")
    omnivariance = safe_dimension(features, "Omnivariance")
    surface_variation = safe_dimension(features, "SurfaceVariation")
    verticality = features["Verticality"]
    roughness = features["Roughness"]
    neighbor_distance = features["MeanNeighborDistance"]
    local_height_range = safe_dimension(features, "LocalHeightRange")
    point_density = safe_dimension(features, "PointDensity2D")
    normal_z = safe_dimension(features, "NormalZ")

    rule_class = np.ones(len(hag), dtype=np.uint8)
    confidence = np.zeros(len(hag), dtype=np.float32)

    ground_mask = classification == int(ground_class)
    rule_class[ground_mask] = 2
    confidence[ground_mask] = 1.0

    non_ground_mask = ~ground_mask
    noise_score = np.zeros(len(hag), dtype=np.float32)
    noise_score += 0.40 * np.clip((neighbor_distance - 0.9) / 0.8, 0.0, 1.0)
    noise_score += 0.25 * np.clip((0.65 - point_density) / 0.65, 0.0, 1.0)
    noise_score += 0.20 * np.clip((roughness - 0.45) / 0.7, 0.0, 1.0)
    noise_score += 0.15 * np.clip((surface_variation - 0.08) / 0.18, 0.0, 1.0)
    noise_mask = non_ground_mask & (noise_score >= 0.6)
    rule_class[noise_mask] = 7
    confidence[noise_mask] = np.clip(noise_score[noise_mask], 0.0, 1.0)

    building_score = np.zeros(len(hag), dtype=np.float32)
    building_score += 0.33 * np.clip((planarity - 0.35) / 0.45, 0.0, 1.0)
    building_score += 0.22 * np.clip((0.35 - verticality) / 0.35, 0.0, 1.0)
    building_score += 0.18 * np.clip((0.28 - roughness) / 0.28, 0.0, 1.0)
    building_score += 0.12 * np.clip((1.6 - local_height_range) / 1.6, 0.0, 1.0)
    building_score += 0.10 * np.clip((np.abs(normal_z) - 0.45) / 0.45, 0.0, 1.0)
    building_score += 0.05 * np.clip((point_density - 0.8) / 3.0, 0.0, 1.0)
    building_mask = (
        non_ground_mask
        & (~noise_mask)
        & (hag > 2.0)
        & (building_score >= 0.58)
        & (
            (hag <= 8.0)
            | (
                (planarity > 0.68)
                & (verticality < 0.12)
                & (linearity < 0.38)
                & (point_density > 4000.0)
            )
        )
    )
    rule_class[building_mask] = 6
    confidence[building_mask] = np.clip(building_score[building_mask], 0.0, 1.0)

    pole_score = np.zeros(len(hag), dtype=np.float32)
    pole_score += 0.42 * np.clip((linearity - 0.52) / 0.38, 0.0, 1.0)
    pole_score += 0.30 * np.clip((verticality - 0.68) / 0.32, 0.0, 1.0)
    pole_score += 0.14 * np.clip((0.42 - planarity) / 0.42, 0.0, 1.0)
    pole_score += 0.10 * np.clip((0.45 - roughness) / 0.45, 0.0, 1.0)
    pole_score += 0.10 * np.clip((local_height_range - 0.4) / 1.4, 0.0, 1.0)
    pole_mask = (
        non_ground_mask
        & (~noise_mask)
        & (~building_mask)
        & (hag > 1.5)
        & ((hag <= 8.0) | ((linearity > 0.82) & (verticality > 0.92)))
        & (pole_score >= 0.64)
    )
    rule_class[pole_mask] = 8
    confidence[pole_mask] = np.clip(pole_score[pole_mask], 0.0, 1.0)

    vegetation_score = np.zeros(len(hag), dtype=np.float32)
    vegetation_score += 0.25 * np.clip((hag - 0.1) / 4.0, 0.0, 1.0)
    vegetation_score += 0.18 * np.clip((roughness - 0.02) / 0.28, 0.0, 1.0)
    vegetation_score += 0.18 * np.clip((surface_variation - 0.005) / 0.08, 0.0, 1.0)
    vegetation_score += 0.12 * np.clip((local_height_range - 0.2) / 1.6, 0.0, 1.0)
    vegetation_score += 0.12 * np.clip((verticality - 0.05) / 0.55, 0.0, 1.0)
    vegetation_score += 0.10 * np.clip((omnivariance - 0.005) / 0.08, 0.0, 1.0)
    vegetation_score += 0.05 * np.clip((sphericity - 0.03) / 0.3, 0.0, 1.0)
    vegetation_candidate = non_ground_mask & (~noise_mask) & (~building_mask) & (~pole_mask) & (vegetation_score >= 0.34)
    low_veg = vegetation_candidate & (hag >= 0.15) & (hag < 1.0)
    medium_veg = vegetation_candidate & (hag >= 1.0) & (hag < 3.0)
    high_veg = vegetation_candidate & (hag >= 3.0)

    rule_class[low_veg] = 3
    rule_class[medium_veg] = 4
    rule_class[high_veg] = 5

    vegetation_mask = low_veg | medium_veg | high_veg
    confidence[vegetation_mask] = np.clip(vegetation_score[vegetation_mask], 0.0, 1.0)

    rule_class, confidence = refine_class_components(xyz, hag, rule_class, confidence, features)

    building_recovery_mask = (
        (~ground_mask)
        & np.isin(rule_class, [1, 3, 4, 5])
        & (hag > 1.5)
        & (hag < 12.0)
        & (planarity > 0.62)
        & (verticality < 0.12)
        & (roughness < 0.01)
        & (local_height_range < 0.08)
    )
    rule_class[building_recovery_mask] = 6
    confidence[building_recovery_mask] = np.maximum(confidence[building_recovery_mask], 0.72)

    pole_recovery_mask = (
        (~ground_mask)
        & np.isin(rule_class, [1, 3, 4, 5])
        & (hag > 1.5)
        & (hag < 8.0)
        & (linearity > 0.78)
        & (verticality > 0.9)
        & (planarity < 0.18)
        & (roughness < 0.02)
    )
    rule_class[pole_recovery_mask] = 8
    confidence[pole_recovery_mask] = np.maximum(confidence[pole_recovery_mask], 0.76)

    rule_class = smooth_semantic_classes(xyz, rule_class, confidence)
    vegetation_final_mask = (rule_class == 3) | (rule_class == 4) | (rule_class == 5)
    confidence[vegetation_final_mask] = np.maximum(
        confidence[vegetation_final_mask],
        0.45,
    )

    return rule_class, confidence


def write_dimensions(las, rule_class: np.ndarray, confidence: np.ndarray) -> None:
    ensure_u8_dimension(las, "RuleBasedClass", "Rule-based semantic class id")
    ensure_extra_dimension(las, "RuleBasedConfidence", "Rule-based semantic class confidence")
    las["RuleBasedClass"] = rule_class
    las["RuleBasedConfidence"] = np.asarray(confidence, dtype=np.float32)


def save_las(las, output_path: str) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    las.write(str(output))
    print(f"[RuleCls] Written: {output}", flush=True)


def build_stats(rule_class: np.ndarray) -> dict[str, object]:
    unique, counts = np.unique(rule_class, return_counts=True)
    summary = {}
    for class_id, count in zip(unique.tolist(), counts.tolist()):
        summary[CLASS_LABELS.get(int(class_id), str(class_id))] = int(count)
    return {
        "classes": summary,
        "classMap": CLASS_LABELS,
    }


def main() -> None:
    try:
        params = parse_args(sys.argv)
        input_path = os.path.abspath(str(params["input_path"]))
        output_path = os.path.abspath(str(params["output_path"]))
        ground_class = int(params["ground_class"])
        hag_dimension = str(params["hag_dimension"])

        print(f"[RuleCls] Input : {input_path}", flush=True)
        print(f"[RuleCls] Output: {output_path}", flush=True)
        print(f"[RuleCls] Params: groundClass={ground_class} hagDimension={hag_dimension}", flush=True)

        las, xyz = load_las(input_path)
        classification = np.asarray(las.classification, dtype=np.uint8)
        hag = require_dimension(las, hag_dimension)
        features = {name: require_dimension(las, name) for name in FEATURE_NAMES}

        rule_class, confidence = classify_points(
          xyz,
          classification,
          hag,
          features,
          ground_class=ground_class,
        )

        write_dimensions(las, rule_class, confidence)
        save_las(las, output_path)

        print("RESULT:" + json.dumps({
            "ok": True,
            "outputPath": output_path,
            "stats": build_stats(rule_class),
        }), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        print("RESULT:" + json.dumps({"ok": False, "error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
