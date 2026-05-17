#!/usr/bin/env python3
"""
Compute reusable geometric features for LAS/LAZ point clouds.

The implementation follows the common PCA-neighborhood feature family used by
CloudCompare and many point-cloud pipelines: linearity, planarity, sphericity,
verticality, roughness, and mean neighbor distance.

Usage:
    python compute_geometric_features.py <input_las> <output_las> [neighbor_count]
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


DEFAULT_NEIGHBOR_COUNT = 16
GROUND_CLASS = 2
QUERY_BATCH_SIZE = 100_000
FEATURE_DIMENSIONS = {
    "Linearity": "Neighborhood PCA linearity",
    "Planarity": "Neighborhood PCA planarity",
    "Sphericity": "Neighborhood PCA sphericity",
    "Omnivariance": "Neighborhood PCA omnivariance",
    "SurfaceVariation": "Neighborhood PCA surface variation",
    "Verticality": "1 - |normal_z| from local PCA normal",
    "NormalZ": "Z component of the local PCA normal",
    "Roughness": "Absolute point-to-plane residual to local PCA plane",
    "MeanNeighborDistance": "Mean XY/Z nearest-neighbor distance in local neighborhood",
    "LocalHeightRange": "Local neighborhood height range",
    "PointDensity2D": "Approximate local XY point density",
}


def parse_args(argv: list[str]) -> dict[str, object]:
    if len(argv) < 3:
        raise ValueError(
            "Usage: compute_geometric_features.py <input_las> <output_las> [neighbor_count]"
        )

    return {
        "input_path": argv[1],
        "output_path": argv[2],
        "neighbor_count": int(float(argv[3])) if len(argv) > 3 else DEFAULT_NEIGHBOR_COUNT,
    }


def load_las(path: str):
    las = laspy.read(path)
    point_count = len(las.points)
    if point_count == 0:
        raise ValueError("LAS/LAZ file has 0 points")

    xyz = np.column_stack((las.x, las.y, las.z)).astype(np.float64, copy=False)
    print(
        f"[Geom] Loaded {point_count:,} points "
        f"(point_format={las.header.point_format.id}, version={las.header.version})",
        flush=True,
    )
    return las, xyz


def ensure_extra_dimension(las, name: str, description: str) -> None:
    existing = set(las.point_format.extra_dimension_names)
    if name in existing:
        return

    safe_description = str(description or "")[:32]
    las.add_extra_dim(
        laspy.ExtraBytesParams(
            name=name,
            type=np.float32,
            description=safe_description,
        )
    )


def write_feature_dimensions(las, features: dict[str, np.ndarray]) -> None:
    for name, description in FEATURE_DIMENSIONS.items():
        ensure_extra_dimension(las, name, description)
        las[name] = np.asarray(features[name], dtype=np.float32)


def safe_feature_values(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values, dtype=np.float32)
    arr[~np.isfinite(arr)] = 0.0
    return arr


def compute_features(xyz: np.ndarray, neighbor_count: int, classification: np.ndarray | None = None) -> dict[str, np.ndarray]:
    point_count = len(xyz)
    k = max(8, min(int(neighbor_count), point_count))
    query_mask = np.ones(point_count, dtype=bool)
    if classification is not None and len(classification) == point_count:
        query_mask = np.asarray(classification != GROUND_CLASS, dtype=bool)
        if not np.any(query_mask):
            query_mask = np.ones(point_count, dtype=bool)

    query_indices = np.where(query_mask)[0]
    query_xy = xyz[query_indices, :2]
    tree = cKDTree(xyz[:, :2])

    linearity = np.zeros(point_count, dtype=np.float32)
    planarity = np.zeros(point_count, dtype=np.float32)
    sphericity = np.zeros(point_count, dtype=np.float32)
    omnivariance = np.zeros(point_count, dtype=np.float32)
    surface_variation = np.zeros(point_count, dtype=np.float32)
    verticality = np.zeros(point_count, dtype=np.float32)
    normal_z = np.zeros(point_count, dtype=np.float32)
    roughness = np.zeros(point_count, dtype=np.float32)
    mean_neighbor_distance = np.zeros(point_count, dtype=np.float32)
    local_height_range = np.zeros(point_count, dtype=np.float32)
    point_density_2d = np.zeros(point_count, dtype=np.float32)

    query_count = len(query_indices)
    total_batches = max(1, (query_count + QUERY_BATCH_SIZE - 1) // QUERY_BATCH_SIZE)
    for batch_index, start in enumerate(range(0, query_count, QUERY_BATCH_SIZE), start=1):
        end = min(start + QUERY_BATCH_SIZE, query_count)
        batch_query_indices = query_indices[start:end]
        batch_points = xyz[batch_query_indices]
        distances, indices = tree.query(query_xy[start:end], k=k, workers=-1)
        distances = np.asarray(distances, dtype=np.float64)
        indices = np.asarray(indices, dtype=np.int64)
        if k == 1:
            indices = indices[:, np.newaxis]
            distances = distances[:, np.newaxis]

        neighbors = xyz[indices]
        centers = neighbors.mean(axis=1)
        centered = neighbors - centers[:, np.newaxis, :]
        covariances = np.einsum("bni,bnj->bij", centered, centered) / max(k - 1, 1)

        try:
            eigenvalues, eigenvectors = np.linalg.eigh(covariances)
        except np.linalg.LinAlgError:
            print(
                f"[Geom] Falling back to identity features for batch {batch_index}/{total_batches} "
                f"({start:,}-{end:,}) due to eigendecomposition failure",
                flush=True,
            )
            continue

        eigenvalues = np.maximum(eigenvalues, 0.0)
        l3 = eigenvalues[:, 0]
        l2 = eigenvalues[:, 1]
        l1 = eigenvalues[:, 2]
        valid = l1 > 1e-12
        batch_len = end - start

        batch_linearity = np.zeros(batch_len, dtype=np.float32)
        batch_planarity = np.zeros(batch_len, dtype=np.float32)
        batch_sphericity = np.zeros(batch_len, dtype=np.float32)
        batch_omnivariance = np.zeros(batch_len, dtype=np.float32)
        batch_surface_variation = np.zeros(batch_len, dtype=np.float32)

        batch_linearity[valid] = ((l1[valid] - l2[valid]) / l1[valid]).astype(np.float32)
        batch_planarity[valid] = ((l2[valid] - l3[valid]) / l1[valid]).astype(np.float32)
        batch_sphericity[valid] = (l3[valid] / l1[valid]).astype(np.float32)
        batch_omnivariance[valid] = np.cbrt(np.maximum(l1[valid] * l2[valid] * l3[valid], 0.0)).astype(np.float32)
        batch_surface_variation[valid] = (l3[valid] / np.maximum(l1[valid] + l2[valid] + l3[valid], 1e-12)).astype(np.float32)

        normals = eigenvectors[:, :, 0]
        batch_verticality = (1.0 - np.abs(normals[:, 2])).astype(np.float32)
        batch_normal_z = normals[:, 2].astype(np.float32)
        batch_roughness = np.abs(np.sum((batch_points - centers) * normals, axis=1)).astype(np.float32)
        batch_local_height_range = (np.max(neighbors[:, :, 2], axis=1) - np.min(neighbors[:, :, 2], axis=1)).astype(np.float32)

        if k > 1:
            batch_mean_neighbor_distance = np.mean(distances[:, 1:], axis=1).astype(np.float32)
            xy_offsets = neighbors[:, :, :2] - batch_points[:, np.newaxis, :2]
            xy_distances = np.linalg.norm(xy_offsets, axis=2)
            batch_radius = np.max(xy_distances[:, 1:], axis=1)
            batch_point_density_2d = np.zeros(batch_len, dtype=np.float32)
            radius_valid = batch_radius > 1e-6
            batch_point_density_2d[radius_valid] = (
                (k - 1) / (np.pi * np.square(batch_radius[radius_valid]))
            ).astype(np.float32)
        else:
            batch_mean_neighbor_distance = np.zeros(batch_len, dtype=np.float32)
            batch_point_density_2d = np.zeros(batch_len, dtype=np.float32)

        linearity[batch_query_indices] = batch_linearity
        planarity[batch_query_indices] = batch_planarity
        sphericity[batch_query_indices] = batch_sphericity
        omnivariance[batch_query_indices] = batch_omnivariance
        surface_variation[batch_query_indices] = batch_surface_variation
        verticality[batch_query_indices] = batch_verticality
        normal_z[batch_query_indices] = batch_normal_z
        roughness[batch_query_indices] = batch_roughness
        mean_neighbor_distance[batch_query_indices] = batch_mean_neighbor_distance
        local_height_range[batch_query_indices] = batch_local_height_range
        point_density_2d[batch_query_indices] = batch_point_density_2d

        if batch_index == 1 or batch_index == total_batches or batch_index % 10 == 0:
            pct = (end / query_count) * 100.0
            print(
                f"[Geom] Batch {batch_index}/{total_batches} complete "
                f"({end:,}/{query_count:,} query points, {pct:.1f}%)",
                flush=True,
            )

    return {
        "Linearity": safe_feature_values(linearity),
        "Planarity": safe_feature_values(planarity),
        "Sphericity": safe_feature_values(sphericity),
        "Omnivariance": safe_feature_values(omnivariance),
        "SurfaceVariation": safe_feature_values(surface_variation),
        "Verticality": safe_feature_values(verticality),
        "NormalZ": safe_feature_values(normal_z),
        "Roughness": safe_feature_values(roughness),
        "MeanNeighborDistance": safe_feature_values(mean_neighbor_distance),
        "LocalHeightRange": safe_feature_values(local_height_range),
        "PointDensity2D": safe_feature_values(point_density_2d),
    }


def save_las(las, output_path: str) -> None:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    las.write(str(output))
    print(f"[Geom] Written: {output}", flush=True)


def build_stats(features: dict[str, np.ndarray]) -> dict[str, dict[str, float]]:
    stats: dict[str, dict[str, float]] = {}
    for name, values in features.items():
        stats[name] = {
            "min": float(np.min(values)),
            "max": float(np.max(values)),
            "mean": float(np.mean(values)),
            "p95": float(np.percentile(values, 95)),
        }
    return stats


def main() -> None:
    try:
        params = parse_args(sys.argv)
        input_path = os.path.abspath(str(params["input_path"]))
        output_path = os.path.abspath(str(params["output_path"]))
        neighbor_count = int(params["neighbor_count"])

        print(f"[Geom] Input : {input_path}", flush=True)
        print(f"[Geom] Output: {output_path}", flush=True)
        print(f"[Geom] Params: neighborCount={neighbor_count}", flush=True)

        las, xyz = load_las(input_path)
        classification = np.asarray(las.classification, dtype=np.uint8) if hasattr(las, "classification") else None
        if classification is not None:
            non_ground = int(np.count_nonzero(classification != GROUND_CLASS))
            print(f"[Geom] Non-ground query points: {non_ground:,}/{len(xyz):,}", flush=True)
        features = compute_features(xyz, neighbor_count, classification)
        write_feature_dimensions(las, features)
        save_las(las, output_path)

        print("RESULT:" + json.dumps({
            "ok": True,
            "outputPath": output_path,
            "stats": build_stats(features),
        }), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        print("RESULT:" + json.dumps({"ok": False, "error": str(exc)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
