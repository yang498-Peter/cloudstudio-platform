#!/usr/bin/env python3
"""
Rule-based individual tree segmentation for LAS/LAZ files.

Expected upstream inputs:
- HeightAboveGround extra dimension
- RuleBasedClass extra dimension from classify_rule_based.py
- preferably geometric features (Linearity / Verticality) for stronger stem seeding

Writes:
- TreeId
- TreeSeedDistance

The approach is intentionally pragmatic:
1. Build stem seeds from a breast-height slice (default 1.2m to 3.0m).
2. Prefer pole-like / vertical linear points as seed candidates.
3. Cluster seed points in XY.
4. Assign vegetation points to the nearest seed within a crown radius.
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


DEFAULT_HAG_DIM = "HeightAboveGround"
DEFAULT_RULE_CLASS_DIM = "RuleBasedClass"
DEFAULT_SEED_MIN_HEIGHT = 1.2
DEFAULT_SEED_MAX_HEIGHT = 3.0
DEFAULT_CLUSTER_RADIUS = 0.6
DEFAULT_MAX_CROWN_RADIUS = 4.0
DEFAULT_CHM_RESOLUTION = 0.75
MIN_STEM_POINTS = 6
MIN_COMPONENT_POINTS = 24
MAX_GRID_CELLS = 12_000_000


VEGETATION_CLASSES = {3, 4, 5, 8}


def parse_args(argv: list[str]) -> dict[str, object]:
    if len(argv) < 3:
        raise ValueError(
            "Usage: segment_individual_trees.py <input_las> <output_las> "
            "[seed_min_height] [seed_max_height] [cluster_radius] [max_crown_radius]"
        )

    return {
        "input_path": argv[1],
        "output_path": argv[2],
        "seed_min_height": float(argv[3]) if len(argv) > 3 else DEFAULT_SEED_MIN_HEIGHT,
        "seed_max_height": float(argv[4]) if len(argv) > 4 else DEFAULT_SEED_MAX_HEIGHT,
        "cluster_radius": float(argv[5]) if len(argv) > 5 else DEFAULT_CLUSTER_RADIUS,
        "max_crown_radius": float(argv[6]) if len(argv) > 6 else DEFAULT_MAX_CROWN_RADIUS,
        "chm_resolution": float(argv[7]) if len(argv) > 7 else DEFAULT_CHM_RESOLUTION,
    }


def load_las(path: str):
    las = laspy.read(path)
    if len(las.points) == 0:
        raise ValueError("LAS/LAZ file has 0 points")
    xyz = np.column_stack((las.x, las.y, las.z)).astype(np.float64, copy=False)
    return las, xyz


def require_dimension(las, name: str, dtype=np.float32) -> np.ndarray:
    try:
        return np.asarray(las[name], dtype=dtype)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Required LAS dimension not found: {name}") from exc


def ensure_u32_dimension(las, name: str, description: str) -> None:
    existing = set(las.point_format.extra_dimension_names)
    if name in existing:
        return
    las.add_extra_dim(
        laspy.ExtraBytesParams(
            name=name,
            type=np.uint32,
            description=str(description or "")[:32],
        )
    )


def ensure_f32_dimension(las, name: str, description: str) -> None:
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


def resolve_grid_shape(x_span: float, y_span: float, resolution: float) -> tuple[float, int, int]:
    cell_size = max(float(resolution), 0.25)
    rows = int(np.floor(y_span / cell_size)) + 1
    cols = int(np.floor(x_span / cell_size)) + 1
    while rows * cols > MAX_GRID_CELLS:
        cell_size *= 1.35
        rows = int(np.floor(y_span / cell_size)) + 1
        cols = int(np.floor(x_span / cell_size)) + 1
    return cell_size, rows, cols


def raster_connected_components(
    points_xy: np.ndarray,
    *,
    resolution: float,
) -> tuple[np.ndarray, tuple[float, float, float, int, int], np.ndarray, np.ndarray]:
    if len(points_xy) == 0:
        empty = np.empty(0, dtype=np.int32)
        return empty, (0.0, 0.0, max(float(resolution), 0.25), 0, 0), empty, empty

    x_min = float(np.min(points_xy[:, 0]))
    y_min = float(np.min(points_xy[:, 1]))
    x_span = float(np.max(points_xy[:, 0]) - x_min)
    y_span = float(np.max(points_xy[:, 1]) - y_min)
    cell_size, rows, cols = resolve_grid_shape(x_span, y_span, resolution)
    cols_idx = np.floor((points_xy[:, 0] - x_min) / cell_size).astype(np.int32)
    rows_idx = np.floor((points_xy[:, 1] - y_min) / cell_size).astype(np.int32)
    occupancy = np.zeros((rows, cols), dtype=bool)
    occupancy[rows_idx, cols_idx] = True
    structure = np.ones((3, 3), dtype=np.uint8)
    labeled, _ = ndimage.label(occupancy, structure=structure)
    point_labels = labeled[rows_idx, cols_idx].astype(np.int32)
    return point_labels, (x_min, y_min, cell_size, rows, cols), rows_idx, cols_idx


def build_tree_seeds(
    xyz: np.ndarray,
    hag: np.ndarray,
    rule_class: np.ndarray,
    linearity: np.ndarray,
    verticality: np.ndarray,
    *,
    seed_min_height: float,
    seed_max_height: float,
    cluster_radius: float,
) -> np.ndarray:
    stem_slice = (hag >= seed_min_height) & (hag <= seed_max_height)
    seed_mask = stem_slice & (
        (rule_class == 8) |
        ((linearity > 0.5) & (verticality > 0.7))
    )

    seed_points = xyz[seed_mask, :2]
    if len(seed_points) == 0:
        raise ValueError("No tree stem seed points found. Check upstream HAG / rule classification quality.")

    labels, _, _, _ = raster_connected_components(
        seed_points,
        resolution=max(0.35, cluster_radius),
    )
    valid = labels > 0
    if not np.any(valid):
        raise ValueError("Tree stem clustering produced no valid seed clusters.")

    centroids = []
    valid_labels = np.unique(labels[valid])
    for label in valid_labels:
        cluster_xy = seed_points[labels == label]
        if len(cluster_xy) < MIN_STEM_POINTS:
            continue
        centroids.append(cluster_xy.mean(axis=0))
    if not centroids:
        raise ValueError("Tree stem clustering produced no valid seed clusters.")
    return np.asarray(centroids, dtype=np.float64)


def build_canopy_peak_seeds(
    xyz: np.ndarray,
    hag: np.ndarray,
    *,
    chm_resolution: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, tuple[float, float, float, int, int]]:
    if len(xyz) == 0:
        return (
            np.empty((0, 2), dtype=np.float64),
            np.empty(0, dtype=np.float32),
            np.empty(0, dtype=np.int32),
            np.empty((0, 0), dtype=np.int32),
            (0.0, 0.0, max(float(chm_resolution), 0.25), 0, 0),
        )

    x_min = float(np.min(xyz[:, 0]))
    y_min = float(np.min(xyz[:, 1]))
    x_span = float(np.max(xyz[:, 0]) - x_min)
    y_span = float(np.max(xyz[:, 1]) - y_min)
    cell_size, rows, cols = resolve_grid_shape(x_span, y_span, chm_resolution)
    col = np.floor((xyz[:, 0] - x_min) / cell_size).astype(np.int32)
    row = np.floor((xyz[:, 1] - y_min) / cell_size).astype(np.int32)

    chm = np.full((rows, cols), -np.inf, dtype=np.float32)
    for idx in range(len(xyz)):
        r = int(row[idx])
        c = int(col[idx])
        if hag[idx] > chm[r, c]:
            chm[r, c] = hag[idx]

    valid_mask = np.isfinite(chm)
    if not np.any(valid_mask):
        return (
            np.empty((0, 2), dtype=np.float64),
            np.empty(0, dtype=np.float32),
            np.empty(0, dtype=np.int32),
            np.empty((rows, cols), dtype=np.int32),
            (x_min, y_min, cell_size, rows, cols),
        )

    chm_filled = np.where(valid_mask, chm, 0.0)
    chm_smooth = ndimage.gaussian_filter(chm_filled, sigma=0.85)
    canopy_mask = valid_mask & (chm_smooth >= 1.8)
    canopy_components, _ = ndimage.label(canopy_mask, structure=np.ones((3, 3), dtype=np.uint8))
    peak_mask = (chm_smooth == ndimage.maximum_filter(chm_smooth, size=3, mode="nearest")) & valid_mask & (chm_smooth >= 2.5)
    peak_rows, peak_cols = np.where(peak_mask)
    if len(peak_rows) == 0:
        return (
            np.empty((0, 2), dtype=np.float64),
            np.empty(0, dtype=np.float32),
            np.empty(0, dtype=np.int32),
            canopy_components.astype(np.int32),
            (x_min, y_min, cell_size, rows, cols),
        )

    peaks_xy = np.column_stack((
        x_min + (peak_cols + 0.5) * cell_size,
        y_min + (peak_rows + 0.5) * cell_size,
    )).astype(np.float64)
    peak_heights = chm_smooth[peak_rows, peak_cols].astype(np.float32)
    peak_cells = np.column_stack((peak_rows, peak_cols)).astype(np.int32)
    return peaks_xy, peak_heights, peak_cells, canopy_components.astype(np.int32), (x_min, y_min, cell_size, rows, cols)


def dedupe_seeds(
    seeds_xy: np.ndarray,
    seed_heights: np.ndarray,
    *,
    radius: float,
) -> tuple[np.ndarray, np.ndarray]:
    if len(seeds_xy) <= 1:
        return seeds_xy, seed_heights

    order = np.argsort(seed_heights)[::-1]
    kept_xy: list[np.ndarray] = []
    kept_h: list[float] = []
    for idx in order:
        candidate = seeds_xy[idx]
        if any(np.linalg.norm(candidate - existing) < radius for existing in kept_xy):
            continue
        kept_xy.append(candidate)
        kept_h.append(float(seed_heights[idx]))
    return np.asarray(kept_xy, dtype=np.float64), np.asarray(kept_h, dtype=np.float32)


def build_vegetation_components(
    vegetation_xy: np.ndarray,
    hag: np.ndarray,
    *,
    cluster_radius: float,
) -> tuple[np.ndarray, tuple[float, float, float, int, int], np.ndarray, np.ndarray]:
    if len(vegetation_xy) == 0:
        empty = np.empty(0, dtype=np.int32)
        return empty, (0.0, 0.0, max(1.0, cluster_radius * 1.8), 0, 0), empty, empty

    return raster_connected_components(
        vegetation_xy,
        resolution=max(1.0, cluster_radius * 1.8),
    )


def build_component_tree_seeds(
    vegetation_xy: np.ndarray,
    hag: np.ndarray,
    vegetation_indices: np.ndarray,
    stem_seeds_xy: np.ndarray,
    canopy_peaks_xy: np.ndarray,
    canopy_peak_heights: np.ndarray,
    canopy_components: np.ndarray,
    canopy_grid_meta: tuple[float, float, float, int, int],
    *,
    cluster_radius: float,
) -> tuple[np.ndarray, np.ndarray]:
    labels, _, veg_rows, veg_cols = build_vegetation_components(
        vegetation_xy,
        hag,
        cluster_radius=cluster_radius,
    )
    if len(vegetation_indices) == 0:
        return np.empty((0, 2), dtype=np.float64), np.empty(0, dtype=np.float32)

    seed_xy_parts: list[np.ndarray] = []
    seed_height_parts: list[np.ndarray] = []
    canopy_tree = cKDTree(canopy_peaks_xy) if len(canopy_peaks_xy) else None
    stem_tree = cKDTree(stem_seeds_xy) if len(stem_seeds_xy) else None
    x_min, y_min, cell_size, _, _ = canopy_grid_meta

    for label in np.unique(labels[labels > 0]):
        component_local_idx = np.where(labels == label)[0]
        if len(component_local_idx) < MIN_COMPONENT_POINTS:
            continue

        component_idx = vegetation_indices[component_local_idx]
        component_xy = vegetation_xy[component_local_idx]
        min_xy = np.min(component_xy, axis=0)
        max_xy = np.max(component_xy, axis=0)
        component_diag = float(np.linalg.norm(max_xy - min_xy))
        component_center = component_xy.mean(axis=0)
        component_hag = hag[component_local_idx]
        component_max_hag = float(np.max(component_hag))
        component_peak_xy: list[np.ndarray] = []
        component_peak_h: list[float] = []

        local_peak_radius = max(1.1, min(4.5, component_diag * 0.22 + 0.8))
        canopy_component_ids = canopy_components[
            np.clip(((component_xy[:, 1] - y_min) / cell_size).astype(np.int32), 0, canopy_components.shape[0] - 1),
            np.clip(((component_xy[:, 0] - x_min) / cell_size).astype(np.int32), 0, canopy_components.shape[1] - 1),
        ] if canopy_components.size else np.empty(0, dtype=np.int32)
        dominant_canopy_component = 0
        if len(canopy_component_ids):
            valid_canopy_ids = canopy_component_ids[canopy_component_ids > 0]
            if len(valid_canopy_ids):
                dominant_canopy_component = int(np.bincount(valid_canopy_ids).argmax())

        if canopy_tree is not None:
            peak_ids = canopy_tree.query_ball_point(component_center, r=max(component_diag * 0.75, 2.5))
            for peak_id in peak_ids:
                peak_xy = canopy_peaks_xy[peak_id]
                peak_row = int(np.clip(np.floor((peak_xy[1] - y_min) / cell_size), 0, canopy_components.shape[0] - 1)) if canopy_components.size else 0
                peak_col = int(np.clip(np.floor((peak_xy[0] - x_min) / cell_size), 0, canopy_components.shape[1] - 1)) if canopy_components.size else 0
                peak_component = int(canopy_components[peak_row, peak_col]) if canopy_components.size else 0
                if peak_component > 0 and dominant_canopy_component > 0 and peak_component != dominant_canopy_component:
                    continue
                if (
                    peak_xy[0] >= min_xy[0] - cell_size
                    and peak_xy[0] <= max_xy[0] + cell_size
                    and peak_xy[1] >= min_xy[1] - cell_size
                    and peak_xy[1] <= max_xy[1] + cell_size
                ):
                    component_peak_xy.append(peak_xy)
                    component_peak_h.append(float(canopy_peak_heights[peak_id]))

        if component_peak_xy:
            selected_xy: list[np.ndarray] = []
            selected_h: list[float] = []
            for order in np.argsort(component_peak_h)[::-1]:
                candidate_xy = np.asarray(component_peak_xy[order], dtype=np.float64)
                if any(np.linalg.norm(candidate_xy - existing) < local_peak_radius for existing in selected_xy):
                    continue
                selected_xy.append(candidate_xy)
                selected_h.append(float(component_peak_h[order]))
            seed_xy_parts.append(np.asarray(selected_xy, dtype=np.float64))
            seed_height_parts.append(np.asarray(selected_h, dtype=np.float32))
            continue

        if stem_tree is not None:
            stem_ids = stem_tree.query_ball_point(component_center, r=max(component_diag * 0.55, 1.8))
            if stem_ids:
                selected_stems = stem_seeds_xy[np.asarray(stem_ids, dtype=np.int64)]
                seed_xy_parts.append(np.asarray(selected_stems, dtype=np.float64))
                seed_height_parts.append(np.full(len(selected_stems), max(component_max_hag, 6.0), dtype=np.float32))
                continue

        top_local = int(np.argmax(component_hag))
        seed_xy_parts.append(component_xy[top_local][np.newaxis, :].astype(np.float64))
        seed_height_parts.append(np.asarray([component_max_hag], dtype=np.float32))

    if not seed_xy_parts:
        return np.empty((0, 2), dtype=np.float64), np.empty(0, dtype=np.float32)
    return dedupe_seeds(
        np.vstack(seed_xy_parts),
        np.concatenate(seed_height_parts),
        radius=max(1.0, cluster_radius * 1.25),
    )


def assign_tree_ids(
    point_count: int,
    vegetation_xy: np.ndarray,
    vegetation_indices: np.ndarray,
    vegetation_component_labels: np.ndarray,
    tree_seeds_xy: np.ndarray,
    tree_seed_heights: np.ndarray,
    *,
    max_crown_radius: float,
) -> tuple[np.ndarray, np.ndarray]:
    tree_ids = np.zeros(point_count, dtype=np.uint32)
    seed_distance = np.full(point_count, -1.0, dtype=np.float32)
    if len(vegetation_xy) == 0:
        return tree_ids, seed_distance

    seed_tree = cKDTree(tree_seeds_xy)
    for label in np.unique(vegetation_component_labels[vegetation_component_labels > 0]):
        component_local_idx = np.where(vegetation_component_labels == label)[0]
        if len(component_local_idx) == 0:
            continue
        component_xy = vegetation_xy[component_local_idx]
        component_center = component_xy.mean(axis=0)
        component_diag = float(np.linalg.norm(np.ptp(component_xy, axis=0)))
        seed_ids = seed_tree.query_ball_point(component_center, r=max(max_crown_radius * 1.4, component_diag * 0.8, 2.5))
        if not seed_ids:
            distances, nearest_idx = seed_tree.query(component_xy, k=1, workers=-1)
            nearest_idx = np.asarray(nearest_idx, dtype=np.int64)
            distances = np.asarray(distances, dtype=np.float64)
        else:
            candidate_seed_ids = np.asarray(seed_ids, dtype=np.int64)
            candidate_seeds = tree_seeds_xy[candidate_seed_ids]
            delta = component_xy[:, np.newaxis, :] - candidate_seeds[np.newaxis, :, :]
            dist_matrix = np.linalg.norm(delta, axis=2)
            choice = np.argmin(dist_matrix, axis=1)
            nearest_idx = candidate_seed_ids[choice]
            distances = dist_matrix[np.arange(len(component_local_idx)), choice]

        adaptive_radius = np.minimum(
            max_crown_radius,
            np.maximum(1.8, 0.26 * tree_seed_heights[nearest_idx] + 0.9),
        )
        valid = distances <= adaptive_radius
        assigned_local = component_local_idx[valid]
        assigned_global = vegetation_indices[assigned_local]
        tree_ids[assigned_global] = nearest_idx[valid].astype(np.uint32) + 1
        seed_distance[assigned_global] = distances[valid].astype(np.float32)

    return tree_ids, seed_distance


def write_dimensions(las, tree_ids: np.ndarray, seed_distance: np.ndarray) -> None:
    ensure_u32_dimension(las, "TreeId", "Individual tree segment id")
    ensure_f32_dimension(las, "TreeSeedDistance", "XY distance from assigned tree seed")
    las["TreeId"] = tree_ids
    las["TreeSeedDistance"] = seed_distance


def save_las(las, output_path: str) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    las.write(str(output))
    print(f"[TreeSeg] Written: {output}", flush=True)


def build_stats(tree_ids: np.ndarray, seed_count: int) -> dict[str, int]:
    nonzero = tree_ids[tree_ids > 0]
    return {
        "seedCount": int(seed_count),
        "treeCount": int(len(np.unique(nonzero))) if len(nonzero) else 0,
        "assignedPointCount": int(len(nonzero)),
    }


def main() -> None:
    try:
        params = parse_args(sys.argv)
        input_path = os.path.abspath(str(params["input_path"]))
        output_path = os.path.abspath(str(params["output_path"]))

        print(f"[TreeSeg] Input : {input_path}", flush=True)
        print(f"[TreeSeg] Output: {output_path}", flush=True)
        print(
            f"[TreeSeg] Params: seedMin={params['seed_min_height']} seedMax={params['seed_max_height']} "
            f"clusterRadius={params['cluster_radius']} maxCrownRadius={params['max_crown_radius']} "
            f"chmResolution={params['chm_resolution']}",
            flush=True,
        )

        las, xyz = load_las(input_path)
        hag = require_dimension(las, DEFAULT_HAG_DIM, dtype=np.float32)
        rule_class = require_dimension(las, DEFAULT_RULE_CLASS_DIM, dtype=np.uint8)

        try:
            linearity = require_dimension(las, "Linearity", dtype=np.float32)
            verticality = require_dimension(las, "Verticality", dtype=np.float32)
        except ValueError:
            linearity = np.zeros(len(xyz), dtype=np.float32)
            verticality = np.zeros(len(xyz), dtype=np.float32)

        vegetation_mask = np.isin(rule_class, list(VEGETATION_CLASSES)) & (hag > 0.8)
        vegetation_indices = np.where(vegetation_mask)[0]
        vegetation_xy = xyz[vegetation_indices, :2]
        vegetation_hag = hag[vegetation_indices]
        print(f"[TreeSeg] Vegetation points: {len(vegetation_indices):,}", flush=True)

        try:
            stem_seeds_xy = build_tree_seeds(
                xyz,
                hag,
                rule_class,
                linearity,
                verticality,
                seed_min_height=float(params["seed_min_height"]),
                seed_max_height=float(params["seed_max_height"]),
                cluster_radius=float(params["cluster_radius"]),
            )
        except ValueError:
            stem_seeds_xy = np.empty((0, 2), dtype=np.float64)

        canopy_seeds_xy, canopy_seed_heights, _, canopy_components, canopy_grid_meta = build_canopy_peak_seeds(
            xyz[vegetation_indices],
            vegetation_hag,
            chm_resolution=float(params["chm_resolution"]),
        )
        vegetation_component_labels, _, _, _ = build_vegetation_components(
            vegetation_xy,
            vegetation_hag,
            cluster_radius=float(params["cluster_radius"]),
        )
        tree_seeds_xy, tree_seed_heights = build_component_tree_seeds(
            vegetation_xy,
            vegetation_hag,
            vegetation_indices,
            stem_seeds_xy,
            canopy_seeds_xy,
            canopy_seed_heights,
            canopy_components,
            canopy_grid_meta,
            cluster_radius=float(params["cluster_radius"]),
        )
        if len(tree_seeds_xy) == 0:
            raise ValueError("No valid tree seeds found from stems or canopy peaks.")
        print(f"[TreeSeg] Final seeds: {len(tree_seeds_xy):,}", flush=True)

        tree_ids, seed_distance = assign_tree_ids(
            len(xyz),
            vegetation_xy,
            vegetation_indices,
            vegetation_component_labels,
            tree_seeds_xy,
            tree_seed_heights,
            max_crown_radius=float(params["max_crown_radius"]),
        )

        write_dimensions(las, tree_ids, seed_distance)
        save_las(las, output_path)

        print("RESULT:" + json.dumps({
            "ok": True,
            "outputPath": output_path,
            "stats": build_stats(tree_ids, len(tree_seeds_xy)),
        }), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        print("RESULT:" + json.dumps({"ok": False, "error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
