#!/usr/bin/env python3
"""
compute_volume_analysis.py

Unified server-side volume analysis job.

Outputs:
  - result.json
  - analysis_surface_grid.json
  - analysis_surface_mesh.json
  - base_surface_grid.json
  - base_surface_mesh.json
  - preview_analysis.png
  - preview_base.png
"""

import json
import math
import os
import sys
import warnings
from datetime import datetime, timezone

import numpy as np

try:
    import laspy
except ImportError:
    laspy = None

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, PageBreak
except ImportError:
    SimpleDocTemplate = None
    ImageReader = None

from matplotlib.path import Path as MplPath

from generate_dtm import read_las_fast, save_preview_png
from generate_surface_mesh import build_surface_mesh, downsample_grid_if_needed, fill_grid_holes, write_obj

try:
    from classify_ground import classify_ground_csf
except Exception:
    classify_ground_csf = None


LOCAL_CSF_ENABLED = str(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF', '1')).strip().lower() not in {'0', 'false', 'off', 'no'}
LOCAL_CSF_MAX_POINTS = int(float(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_MAX_POINTS', '500000')))
LOCAL_CSF_MIN_POINTS = int(float(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_MIN_POINTS', '1000')))
LOCAL_CSF_MIN_GROUND_RATIO = float(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_MIN_GROUND_RATIO', '0.015'))
LOCAL_CSF_CLOTH_RESOLUTION = float(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_CLOTH_RESOLUTION', '0'))
LOCAL_CSF_CLASS_THRESHOLD = float(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_CLASS_THRESHOLD', '0'))
LOCAL_CSF_RIGIDNESS = int(float(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_RIGIDNESS', '2')))
LOCAL_CSF_ITERATIONS = int(float(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_ITERATIONS', '500')))
LOCAL_CSF_SLOPE_SMOOTH = str(os.environ.get('CLOUDSTUDIO_VOLUME_LOCAL_CSF_SLOPE_SMOOTH', '1')).strip().lower() not in {'0', 'false', 'off', 'no'}


def load_payload(path):
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def polygon_bounds(points):
    xs = [float(p['x']) for p in points]
    ys = [float(p['y']) for p in points]
    return {
        'minX': min(xs),
        'maxX': max(xs),
        'minY': min(ys),
        'maxY': max(ys),
    }


def vectorized_points_in_polygon(xs, ys, polygon_xy):
    path = MplPath(np.asarray(polygon_xy, dtype=np.float64))
    points = np.column_stack([xs, ys])
    return path.contains_points(points)


def robust_surface_value(values, profile='p80'):
    vals = np.asarray(values, dtype=np.float64)
    if vals.size == 0:
        return math.nan
    if vals.size == 1:
        return float(vals[0])
    profile = str(profile or 'p80').lower()
    if profile == 'p85':
        return float(np.percentile(vals, 85 if vals.size >= 6 else 80))
    if profile in ('median', 'surface'):
        return float(np.median(vals))
    if profile == 'max':
        return float(np.max(vals))
    if profile == 'min':
        return float(np.min(vals))
    if profile == 'ground':
        return float(np.percentile(vals, 20))
    return float(np.percentile(vals, 80 if vals.size >= 6 else 75))


def denoise_spike_grid(grid, support, threshold, max_chunk_cells=500_000):
    """Clamp isolated 3x3 high/low cells with chunked NumPy neighbor stats."""
    rows, cols = grid.shape
    if rows == 0 or cols == 0:
        return grid
    padded = np.pad(grid.astype(np.float32, copy=False), 1, mode='constant', constant_values=np.nan)
    chunk_rows = max(1, min(rows, int(max_chunk_cells) // max(1, cols)))
    updated = None

    for row0 in range(0, rows, chunk_rows):
        row1 = min(rows, row0 + chunk_rows)
        neighbors = np.stack([
            padded[row0 + dy:row1 + dy, dx:dx + cols]
            for dy in range(3)
            for dx in range(3)
        ], axis=0)
        finite_count = np.sum(np.isfinite(neighbors), axis=0)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', category=RuntimeWarning)
            lower, median, upper = np.nanpercentile(neighbors, [25, 50, 75], axis=0)

        local = grid[row0:row1]
        eligible = (
            np.isfinite(local) &
            (finite_count >= 4) &
            (support[row0:row1] <= 2)
        )
        high_spikes = eligible & (local > upper + threshold)
        low_spikes = eligible & (local < lower - threshold)
        if not np.any(high_spikes) and not np.any(low_spikes):
            continue

        if updated is None:
            updated = grid.copy()
        target = updated[row0:row1]
        high_floor = np.maximum(median, upper)
        low_ceiling = np.minimum(median, lower)
        target[high_spikes] = high_floor[high_spikes].astype(np.float32)
        target[low_spikes] = low_ceiling[low_spikes].astype(np.float32)

    return updated if updated is not None else grid


def polygon_area_xy(polygon_xy):
    if not polygon_xy:
        return 0.0
    return abs(sum(
        polygon_xy[i][0] * polygon_xy[(i + 1) % len(polygon_xy)][1] -
        polygon_xy[(i + 1) % len(polygon_xy)][0] * polygon_xy[i][1]
        for i in range(len(polygon_xy))
    )) * 0.5


def grid_center_inside_mask(bounds, rows, cols, res_x, res_y, polygon_path):
    xs = bounds['minX'] + (np.arange(cols, dtype=np.float64) + 0.5) * res_x
    ys = bounds['minY'] + (np.arange(rows, dtype=np.float64) + 0.5) * res_y
    xx, yy = np.meshgrid(xs, ys)
    points = np.column_stack([xx.ravel(), yy.ravel()])
    return polygon_path.contains_points(points).reshape(rows, cols)


def normalize_surface_profile(surface_type='stockpile', aggregate_mode='p80'):
    surface_type = str(surface_type or 'stockpile').lower()
    aggregate_mode = str(aggregate_mode or 'p80').lower()
    if surface_type == 'dsm':
        return 'max'
    if surface_type == 'dtm':
        return 'ground'
    return aggregate_mode if aggregate_mode in {'p80', 'p85', 'median', 'max', 'min'} else 'p80'


def resolve_classification_filter(mode='all'):
    mode = str(mode or 'all').lower()
    if mode == 'exclude_vegetation':
        return {3, 4, 5}, False
    if mode == 'exclude_vegetation_buildings':
        return {3, 4, 5, 6}, False
    if mode == 'ground_only':
        return set(), True
    return set(), False


def iter_batches_laspy(las_path, polygon_xy, bounds, excluded_classes, ground_only):
    min_x = bounds['minX']
    max_x = bounds['maxX']
    min_y = bounds['minY']
    max_y = bounds['maxY']

    def _gen():
        with laspy.open(las_path) as reader:
            for chunk in reader.chunk_iterator(1_000_000):
                x_raw = np.asarray(chunk.x, dtype=np.float64)
                y_raw = np.asarray(chunk.y, dtype=np.float64)
                z_raw = np.asarray(chunk.z, dtype=np.float64)
                cls_raw = np.asarray(chunk.classification) if hasattr(chunk, 'classification') else None
                mask = (
                    (x_raw >= min_x) & (x_raw <= max_x) &
                    (y_raw >= min_y) & (y_raw <= max_y)
                )
                if cls_raw is not None and excluded_classes:
                    for code in excluded_classes:
                        mask &= (cls_raw != code)
                if ground_only and cls_raw is not None:
                    mask &= (cls_raw == 2)
                if not np.any(mask):
                    continue
                x = x_raw[mask]
                y = y_raw[mask]
                z = z_raw[mask]
                cls = cls_raw[mask] if cls_raw is not None else None
                inside = vectorized_points_in_polygon(x, y, polygon_xy)
                if not np.any(inside):
                    continue
                yield x[inside], y[inside], z[inside], (cls[inside] if cls is not None else None)

    return _gen()


def iter_batches_fallback(las_path, polygon_xy, bounds, excluded_classes, ground_only):
    cloud = read_las_fast(las_path)
    x = np.asarray(cloud['x'], dtype=np.float64)
    y = np.asarray(cloud['y'], dtype=np.float64)
    z = np.asarray(cloud['z'], dtype=np.float64)
    cls = np.asarray(cloud.get('classification')) if cloud.get('classification') is not None else None

    mask = (
        (x >= bounds['minX']) & (x <= bounds['maxX']) &
        (y >= bounds['minY']) & (y <= bounds['maxY'])
    )
    if cls is not None and excluded_classes:
        for code in excluded_classes:
            mask &= (cls != code)
    if ground_only and cls is not None:
        mask &= (cls == 2)
    x = x[mask]
    y = y[mask]
    z = z[mask]
    cls = cls[mask] if cls is not None else None

    if x.size:
        inside = vectorized_points_in_polygon(x, y, polygon_xy)
        x = x[inside]
        y = y[inside]
        z = z[inside]
        cls = cls[inside] if cls is not None else None
    return [(x, y, z, cls)]


def append_grouped_cell_values(target, flat_indices, values):
    if flat_indices.size == 0:
        return
    order = np.argsort(flat_indices, kind='mergesort')
    sorted_flat = flat_indices[order]
    sorted_values = values[order]
    unique_flat, starts = np.unique(sorted_flat, return_index=True)
    stops = np.r_[starts[1:], sorted_flat.size]
    for flat, start, stop in zip(unique_flat, starts, stops):
        key = int(flat)
        bucket = target.get(key)
        if bucket is None:
            bucket = []
            target[key] = bucket
        bucket.append(sorted_values[start:stop].astype(np.float32, copy=True))


def build_grid_from_batches(point_batches, bounds, resolution, polygon_xy, profile='p80', surface_ceiling=None, require_ground_samples=False):
    width = max(bounds['maxX'] - bounds['minX'], resolution)
    height = max(bounds['maxY'] - bounds['minY'], resolution)
    cols = max(2, int(math.ceil(width / resolution)))
    rows = max(2, int(math.ceil(height / resolution)))
    res_x = width / cols
    res_y = height / rows

    cell_z = {}
    cell_ground_z = {}
    support_flat = np.zeros(rows * cols, dtype=np.int32)
    sample_count = 0
    ground_count = 0
    classified_nondefault_count = 0
    polygon_path = MplPath(np.asarray(polygon_xy, dtype=np.float64))

    for x, y, z, cls in point_batches:
        if x.size == 0:
            continue
        if surface_ceiling is not None:
            keep = z <= surface_ceiling
            if not np.any(keep):
                continue
            x = x[keep]
            y = y[keep]
            z = z[keep]
            cls = cls[keep] if cls is not None else None
            if x.size == 0:
                continue
        ix = np.clip(((x - bounds['minX']) / res_x).astype(np.int32), 0, cols - 1)
        iy = np.clip(((y - bounds['minY']) / res_y).astype(np.int32), 0, rows - 1)
        flat = iy.astype(np.int64) * cols + ix.astype(np.int64)
        sample_count += int(z.size)
        support_flat += np.bincount(flat, minlength=rows * cols).astype(np.int32)
        append_grouped_cell_values(cell_z, flat, z)
        if cls is not None:
            cls_int = np.asarray(cls, dtype=np.int32)
            classified_nondefault_count += int(np.count_nonzero(cls_int != 0))
            ground_mask = cls_int == 2
            if np.any(ground_mask):
                ground_count += int(np.count_nonzero(ground_mask))
                append_grouped_cell_values(cell_ground_z, flat[ground_mask], z[ground_mask])

    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    support = support_flat.reshape(rows, cols)

    for flat, z_parts in cell_z.items():
        iy = flat // cols
        ix = flat % cols
        if profile == 'ground':
            ground_parts = cell_ground_z.get(flat)
            if require_ground_samples and not ground_parts:
                continue
            values = np.concatenate(ground_parts) if ground_parts else np.concatenate(z_parts)
        else:
            values = np.concatenate(z_parts)
        grid[iy, ix] = np.float32(robust_surface_value(values, profile=profile))

    center_mask = grid_center_inside_mask(bounds, rows, cols, res_x, res_y, polygon_path)
    grid[~center_mask] = np.nan
    support[~center_mask] = 0

    return grid, support, res_x, res_y, sample_count, ground_count, classified_nondefault_count


def build_ground_grid_pair_from_batches(point_batches, bounds, resolution, polygon_xy, surface_ceiling=None):
    """Build class-2 ground and low-percentile fallback grids in one pass.

    R-13 (2026-05-07): ground-fitted volume used to call
    build_grid_from_batches twice: once requiring class-2 ground and again for
    the all-point P20 fallback. This shares the same cell binning work and
    materializes both grids from a single grouped cell cache.
    """
    width = max(bounds['maxX'] - bounds['minX'], resolution)
    height = max(bounds['maxY'] - bounds['minY'], resolution)
    cols = max(2, int(math.ceil(width / resolution)))
    rows = max(2, int(math.ceil(height / resolution)))
    res_x = width / cols
    res_y = height / rows

    cell_z = {}
    cell_ground_z = {}
    support_flat = np.zeros(rows * cols, dtype=np.int32)
    sample_count = 0
    ground_count = 0
    classified_nondefault_count = 0
    polygon_path = MplPath(np.asarray(polygon_xy, dtype=np.float64))

    for x, y, z, cls in point_batches:
        if x.size == 0:
            continue
        if surface_ceiling is not None:
            keep = z <= surface_ceiling
            if not np.any(keep):
                continue
            x = x[keep]
            y = y[keep]
            z = z[keep]
            cls = cls[keep] if cls is not None else None
            if x.size == 0:
                continue
        ix = np.clip(((x - bounds['minX']) / res_x).astype(np.int32), 0, cols - 1)
        iy = np.clip(((y - bounds['minY']) / res_y).astype(np.int32), 0, rows - 1)
        flat = iy.astype(np.int64) * cols + ix.astype(np.int64)
        sample_count += int(z.size)
        support_flat += np.bincount(flat, minlength=rows * cols).astype(np.int32)
        append_grouped_cell_values(cell_z, flat, z)
        if cls is not None:
            cls_int = np.asarray(cls, dtype=np.int32)
            classified_nondefault_count += int(np.count_nonzero(cls_int != 0))
            ground_mask = cls_int == 2
            if np.any(ground_mask):
                ground_count += int(np.count_nonzero(ground_mask))
                append_grouped_cell_values(cell_ground_z, flat[ground_mask], z[ground_mask])

    ground_grid = np.full((rows, cols), np.nan, dtype=np.float32)
    fallback_grid = np.full((rows, cols), np.nan, dtype=np.float32)
    support = support_flat.reshape(rows, cols)
    ground_support = np.zeros((rows, cols), dtype=np.int32)

    for flat, z_parts in cell_z.items():
        iy = flat // cols
        ix = flat % cols
        values = np.concatenate(z_parts)
        fallback_grid[iy, ix] = np.float32(robust_surface_value(values, profile='ground'))
        ground_parts = cell_ground_z.get(flat)
        if ground_parts:
            ground_values = np.concatenate(ground_parts)
            ground_grid[iy, ix] = np.float32(robust_surface_value(ground_values, profile='ground'))
            ground_support[iy, ix] = int(ground_values.size)

    center_mask = grid_center_inside_mask(bounds, rows, cols, res_x, res_y, polygon_path)
    ground_grid[~center_mask] = np.nan
    fallback_grid[~center_mask] = np.nan
    support[~center_mask] = 0
    ground_support[~center_mask] = 0

    return {
        'groundGrid': ground_grid,
        'fallbackGrid': fallback_grid,
        'support': support,
        'groundSupport': ground_support,
        'resX': res_x,
        'resY': res_y,
        'sampleCount': int(sample_count),
        'groundCount': int(ground_count),
        'classifiedNonDefaultCount': int(classified_nondefault_count),
    }


def collect_local_csf_points(point_batches, max_points):
    xyz_parts = []
    total = 0
    for x, y, z, _cls in point_batches:
        if x.size == 0:
            continue
        xyz_parts.append(np.column_stack([x, y, z]).astype(np.float64, copy=False))
        total += int(x.size)
    if not xyz_parts:
        return np.empty((0, 3), dtype=np.float64), 0, 0

    xyz = np.vstack(xyz_parts)
    original_count = int(total)
    max_points = max(1000, int(max_points))
    if xyz.shape[0] <= max_points:
        return xyz, original_count, int(xyz.shape[0])

    rng = np.random.default_rng(20260507)
    indexes = rng.choice(xyz.shape[0], size=max_points, replace=False)
    indexes.sort()
    return xyz[indexes], original_count, int(max_points)


def build_local_csf_ground_grid(point_batches, bounds, resolution, polygon_xy):
    stats = {
        'available': bool(LOCAL_CSF_ENABLED and classify_ground_csf is not None),
        'used': False,
        'reason': None,
        'inputPointCount': 0,
        'classifiedPointCount': 0,
        'groundPointCount': 0,
        'groundRatio': 0.0,
        'clothResolution': None,
        'classThreshold': None,
        'rigidness': int(LOCAL_CSF_RIGIDNESS),
        'iterations': int(LOCAL_CSF_ITERATIONS),
        'slopeSmooth': bool(LOCAL_CSF_SLOPE_SMOOTH),
    }
    if not LOCAL_CSF_ENABLED:
        stats['reason'] = 'disabled'
        return None, stats
    if classify_ground_csf is None:
        stats['reason'] = 'missing_csf_dependency'
        return None, stats

    xyz, original_count, classified_count = collect_local_csf_points(point_batches, LOCAL_CSF_MAX_POINTS)
    stats['inputPointCount'] = int(original_count)
    stats['classifiedPointCount'] = int(classified_count)
    if classified_count < LOCAL_CSF_MIN_POINTS:
        stats['reason'] = 'too_few_points'
        return None, stats

    cloth_resolution = LOCAL_CSF_CLOTH_RESOLUTION if LOCAL_CSF_CLOTH_RESOLUTION > 0 else max(0.5, float(resolution) * 2.0)
    class_threshold = LOCAL_CSF_CLASS_THRESHOLD if LOCAL_CSF_CLASS_THRESHOLD > 0 else max(0.15, min(0.45, float(resolution) * 0.75))
    stats['clothResolution'] = float(cloth_resolution)
    stats['classThreshold'] = float(class_threshold)

    try:
        ground_mask = classify_ground_csf(
            xyz,
            cloth_resolution=cloth_resolution,
            class_threshold=class_threshold,
            rigidness=LOCAL_CSF_RIGIDNESS,
            iterations=LOCAL_CSF_ITERATIONS,
            slope_smooth=LOCAL_CSF_SLOPE_SMOOTH,
        )
    except Exception as error:
        stats['reason'] = f'csf_failed: {error}'
        return None, stats

    ground_count = int(np.count_nonzero(ground_mask))
    ground_ratio = float(ground_count / max(classified_count, 1))
    stats['groundPointCount'] = ground_count
    stats['groundRatio'] = ground_ratio
    if ground_count < max(25, int(classified_count * LOCAL_CSF_MIN_GROUND_RATIO)):
        stats['reason'] = 'too_few_ground_points'
        return None, stats

    ground_xyz = xyz[ground_mask]
    ground_grid, _, res_x, res_y, *_ = build_grid_from_batches(
        [(ground_xyz[:, 0], ground_xyz[:, 1], ground_xyz[:, 2], None)],
        bounds,
        resolution,
        polygon_xy,
        profile='ground',
        surface_ceiling=None,
        require_ground_samples=False,
    )
    if not np.isfinite(ground_grid).any():
        stats['reason'] = 'empty_ground_grid'
        return None, stats

    stats['used'] = True
    stats['reason'] = 'ok'
    return {
        'grid': ground_grid,
        'resX': res_x,
        'resY': res_y,
    }, stats


def safe_vertex_z(value, fallback=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return number if math.isfinite(number) else float(fallback)


def filter_boundary_vertices_by_mad(vertices, mad_factor=4.5, min_keep=3):
    """R-2 (2026-05-07): drop boundary vertices whose Z is a strong outlier.

    Operators frequently snap polygon vertices to convenient on-screen points
    while sketching — including points sitting on top of the stockpile they
    are about to measure. With a pure inverse-distance weighted base grid
    those high outliers drag the entire base surface upward, which silently
    under-estimates the cut volume.

    We use the median + MAD (median absolute deviation) test because it is
    robust against both single-vertex spikes and a small cluster of bad
    vertices. ``mad_factor`` ≈ 4.5 ≈ 3-sigma equivalent for normal data, but
    triggers harder on heavy-tailed point clouds. We always keep at least
    ``min_keep`` vertices so a degenerate input never collapses.
    """
    if len(vertices) <= min_keep:
        return list(vertices), 0
    zs = np.asarray([v[2] for v in vertices], dtype=np.float64)
    finite_mask = np.isfinite(zs)
    kept = [v for v, ok in zip(vertices, finite_mask) if ok]
    zs = zs[finite_mask]
    if len(kept) < min_keep:
        return list(vertices), 0
    median = float(np.median(zs))
    mad = float(np.median(np.abs(zs - median)))
    if mad <= 1e-6:
        # Flat boundaries are common. A single mistaken click on top of a pile
        # can produce [10, 10, 10, 80], where MAD is zero and a pure MAD test
        # would keep the bad vertex. Fall back to a conservative absolute gap
        # test around the dominant flat elevation.
        deviations = np.abs(zs - median)
        flat_threshold = max(0.25, abs(median) * 0.02)
        keep_mask = deviations <= flat_threshold
        if keep_mask.sum() < min_keep:
            return kept, 0
        filtered = [v for v, ok in zip(kept, keep_mask) if ok]
        return filtered, len(kept) - len(filtered)
    # 1.4826 makes MAD a consistent estimator of the std for normal data.
    threshold = mad_factor * 1.4826 * mad
    deviations = np.abs(zs - median)
    keep_mask = deviations <= threshold
    if keep_mask.sum() < min_keep:
        # If MAD would prune too aggressively, keep the closest min_keep.
        order = np.argsort(deviations)
        keep_mask = np.zeros_like(keep_mask)
        keep_mask[order[:min_keep]] = True
    filtered = [v for v, ok in zip(kept, keep_mask) if ok]
    rejected = len(kept) - len(filtered)
    return filtered, rejected


def build_boundary_base_grid(bounds, polygon_xyz, rows, cols, res_x, res_y, polygon_path):
    """Returns ``(grid, vertex_outlier_count)``.

    R-2 (2026-05-07): the second return value exposes how many polygon
    vertices were judged to be Z outliers and excluded from the IDW —
    callers can surface this in the warnings list.
    """
    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    raw_vertices = [
        (float(p['x']), float(p['y']), safe_vertex_z(p.get('z', 0.0)))
        for p in polygon_xyz
    ]
    vertices, rejected_vertex_count = filter_boundary_vertices_by_mad(raw_vertices)
    if not vertices:
        vertices = raw_vertices
        rejected_vertex_count = 0
    for iy in range(rows):
        for ix in range(cols):
            cx = bounds['minX'] + (ix + 0.5) * res_x
            cy = bounds['minY'] + (iy + 0.5) * res_y
            if not polygon_path.contains_point((cx, cy)):
                continue
            weighted_sum = 0.0
            weight_sum = 0.0
            for px, py, pz in vertices:
                dist2 = (cx - px) ** 2 + (cy - py) ** 2
                if dist2 < 1e-12:
                    weighted_sum = pz
                    weight_sum = 1.0
                    break
                weight = 1.0 / dist2
                weighted_sum += pz * weight
                weight_sum += weight
            if weight_sum > 0:
                grid[iy, ix] = np.float32(weighted_sum / weight_sum)
    return grid, int(rejected_vertex_count)


def build_constant_base_grid(bounds, rows, cols, res_x, res_y, polygon_path, reference_height):
    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    ref_z = float(reference_height)
    center_mask = grid_center_inside_mask(bounds, rows, cols, res_x, res_y, polygon_path)
    grid[center_mask] = np.float32(ref_z)
    return grid


def estimate_cell_coverage(bounds, ix, iy, res_x, res_y, polygon_path, samples=4):
    hits = 0
    total = samples * samples
    x0 = bounds['minX'] + ix * res_x
    y0 = bounds['minY'] + iy * res_y
    step_x = res_x / samples
    step_y = res_y / samples
    for sy in range(samples):
        for sx in range(samples):
            cx = x0 + (sx + 0.5) * step_x
            cy = y0 + (sy + 0.5) * step_y
            if polygon_path.contains_point((cx, cy)):
                hits += 1
    return hits / total


def build_coverage_grid(bounds, rows, cols, res_x, res_y, polygon_path, valid_mask, samples=4):
    coverage = np.zeros((rows, cols), dtype=np.float32)
    if not np.any(valid_mask):
        return coverage

    left = bounds['minX'] + np.arange(cols, dtype=np.float64) * res_x
    right = left + res_x
    bottom = bounds['minY'] + np.arange(rows, dtype=np.float64) * res_y
    top = bottom + res_y

    xx_left, yy_bottom = np.meshgrid(left, bottom)
    xx_right, yy_top = np.meshgrid(right, top)
    corners = [
        np.column_stack([xx_left.ravel(), yy_bottom.ravel()]),
        np.column_stack([xx_right.ravel(), yy_bottom.ravel()]),
        np.column_stack([xx_left.ravel(), yy_top.ravel()]),
        np.column_stack([xx_right.ravel(), yy_top.ravel()]),
    ]
    corner_inside = [polygon_path.contains_points(points).reshape(rows, cols) for points in corners]
    full_inside = corner_inside[0] & corner_inside[1] & corner_inside[2] & corner_inside[3]
    coverage[valid_mask & full_inside] = 1.0

    boundary_mask = valid_mask & ~full_inside
    if not np.any(boundary_mask):
        return coverage

    sample_hits = np.zeros((rows, cols), dtype=np.int16)
    for sy in range(samples):
        y = bounds['minY'] + (np.arange(rows, dtype=np.float64) + (sy + 0.5) / samples) * res_y
        for sx in range(samples):
            x = bounds['minX'] + (np.arange(cols, dtype=np.float64) + (sx + 0.5) / samples) * res_x
            xx, yy = np.meshgrid(x, y)
            inside = polygon_path.contains_points(np.column_stack([xx.ravel(), yy.ravel()])).reshape(rows, cols)
            sample_hits += inside.astype(np.int16)
    coverage[boundary_mask] = sample_hits[boundary_mask].astype(np.float32) / float(samples * samples)
    return coverage


def mesh_json_from_grid(grid, bounds, res_x, res_y, meta):
    mesh = build_surface_mesh(grid, bounds['minX'], bounds['minY'], res_x, res_y)
    return {
        'meta': meta,
        'vertices': mesh['vertices'],
        'colors': mesh['colors'],
        'faces': mesh['faces'],
    }, mesh


def get_resolution_recommendation(polygon_area, scenario_mode, current_resolution, effective_cell_count):
    area = max(float(polygon_area or 0.0), 1e-9)
    mode = str(scenario_mode or 'stockpile_boundary').lower()
    if mode == 'plane_cut_fill':
      target_cells = 900
      min_cells = 500
      max_cells = 1600
    elif mode == 'ground_fit_volume':
      target_cells = 1400
      min_cells = 800
      max_cells = 2600
    else:
      target_cells = 1200
      min_cells = 700
      max_cells = 2200

    recommended = math.sqrt(area / target_cells)
    recommended_min = math.sqrt(area / max_cells)
    recommended_max = math.sqrt(area / min_cells)
    current = float(current_resolution or 0.0)
    return {
        'recommendedResolution': round(recommended, 3),
        'recommendedMinResolution': round(recommended_min, 3),
        'recommendedMaxResolution': round(recommended_max, 3),
        'targetCellCount': int(target_cells),
        'currentLooksCoarse': bool(current > recommended_max * 1.1) if current > 0 else False,
        'currentLooksFine': bool(current < recommended_min * 0.9) if current > 0 else False,
        'effectiveCellCount': int(effective_cell_count),
    }


def build_preview_image(path, max_width, max_height):
    if not path or not os.path.exists(path):
        return None
    try:
        if ImageReader is not None:
            reader = ImageReader(path)
            width, height = reader.getSize()
            if width and height:
                scale = min(max_width / float(width), max_height / float(height))
                return Image(path, width=width * scale, height=height * scale)
    except Exception:
        pass
    return Image(path, width=max_width, height=max_height)


def build_volume_pdf_report(output_path, result, analysis_preview_path, base_preview_path, viewport_preview_path=None):
    if SimpleDocTemplate is None:
        raise RuntimeError('reportlab is not available for PDF report generation')

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name='SmallMuted',
        parent=styles['BodyText'],
        fontName='Helvetica',
        fontSize=8.5,
        leading=11,
        textColor=colors.HexColor('#5b6472'),
    ))
    styles.add(ParagraphStyle(
        name='MetricValue',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=14,
        leading=17,
        textColor=colors.HexColor('#0f172a'),
        spaceAfter=2,
    ))
    styles.add(ParagraphStyle(
        name='ReportSubtitle',
        parent=styles['BodyText'],
        fontName='Helvetica',
        fontSize=9,
        leading=12,
        textColor=colors.HexColor('#475569'),
    ))
    styles.add(ParagraphStyle(
        name='SectionHeading',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=11.5,
        leading=14,
        textColor=colors.HexColor('#0f172a'),
        spaceAfter=4,
        spaceBefore=4,
    ))
    styles.add(ParagraphStyle(
        name='WarningText',
        parent=styles['BodyText'],
        fontName='Helvetica',
        fontSize=8.6,
        leading=11,
        textColor=colors.HexColor('#7c2d12'),
    ))
    styles.add(ParagraphStyle(
        name='RiskValue',
        parent=styles['BodyText'],
        fontName='Helvetica-Bold',
        fontSize=10.5,
        leading=13,
        textColor=colors.HexColor('#9a3412'),
    ))
    styles.add(ParagraphStyle(
        name='FigureCaption',
        parent=styles['BodyText'],
        fontName='Helvetica',
        fontSize=8.2,
        leading=10.5,
        textColor=colors.HexColor('#475569'),
        alignment=1,
    ))

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"Volume Report - {result.get('jobId', 'volume')}",
        author='CloudStudio',
    )

    def metric_cell(label, value):
        return [
            Paragraph(label, styles['SmallMuted']),
            Paragraph(value, styles['MetricValue']),
        ]

    def draw_page(canvas, doc):
        canvas.saveState()
        width, height = A4
        canvas.setFillColor(colors.HexColor('#0f172a'))
        canvas.rect(0, height - 16 * mm, width, 16 * mm, fill=1, stroke=0)
        canvas.setFillColor(colors.white)
        canvas.setFont('Helvetica-Bold', 12)
        canvas.drawString(16 * mm, height - 10.8 * mm, 'CloudStudio Volume Analysis Report')
        canvas.setFillColor(colors.HexColor('#64748b'))
        canvas.setFont('Helvetica', 8)
        canvas.drawRightString(width - 16 * mm, 10 * mm, f"Page {doc.page}")
        canvas.restoreState()

    volume = result.get('volume', {})
    stats = result.get('stats', {})
    analysis = result.get('analysisSurface', {})
    base = result.get('baseSurface', {})
    diagnostic = result.get('diagnostic', {})
    report_meta = result.get('reportMeta', {})
    recommendation = diagnostic.get('resolutionRecommendation') or {}
    warnings = diagnostic.get('warnings') or []

    elements = []
    header_table = Table([
        [
            Paragraph(
                f"<b>{report_meta.get('regionName', 'Volume Region')}</b><br/>{report_meta.get('pointcloudName', 'Point Cloud')}",
                styles['Heading2'],
            ),
            Paragraph(
                f"Job ID: {result.get('jobId', 'unknown')}<br/>Scenario: {result.get('scenarioMode', 'unknown')}<br/>Generated: {report_meta.get('generatedAt', 'unknown')}",
                styles['ReportSubtitle'],
            ),
        ]
    ], colWidths=[105 * mm, 69 * mm])
    header_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f8fafc')),
        ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#cbd5e1')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    elements.append(header_table)
    elements.append(Spacer(1, 5 * mm))

    metrics_table = Table([
        [
            metric_cell('Cut Volume', f"{volume.get('cutVolume', 0):,.3f} m3"),
            metric_cell('Fill Volume', f"{volume.get('fillVolume', 0):,.3f} m3"),
            metric_cell('Net Volume', f"{volume.get('netVolume', 0):,.3f} m3"),
        ],
        [
            metric_cell('Coverage', f"{stats.get('coverageRatio', 0) * 100:.1f}%"),
            metric_cell('Effective Cells', f"{int(stats.get('effectiveCellCount', 0)):,}"),
            metric_cell('Confidence', str(diagnostic.get('confidence', 'n/a')).title()),
        ],
        [
            metric_cell('Current Resolution', f"{stats.get('currentResolution', 0):,.3f} m" if stats.get('currentResolution') is not None else 'n/a'),
            metric_cell('Polygon Area', f"{stats.get('polygonArea', 0):,.2f} m2"),
            metric_cell('Ground Support', f"{float(diagnostic.get('groundSupportRatio', 0) or 0):.4f}"),
        ],
    ], colWidths=[58 * mm, 58 * mm, 58 * mm])
    metrics_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f8fafc')),
        ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#cbd5e1')),
        ('INNERGRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#e2e8f0')),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    elements.append(Paragraph('Result Summary', styles['SectionHeading']))
    elements.append(metrics_table)
    elements.append(Spacer(1, 6 * mm))

    risk_summary_rows = [[
        Paragraph('Risk Summary', styles['SmallMuted']),
        Paragraph('Base Source', styles['SmallMuted']),
        Paragraph('Resolution Check', styles['SmallMuted']),
    ], [
        Paragraph(str(diagnostic.get('confidence', 'n/a')).title(), styles['RiskValue']),
        Paragraph(str(diagnostic.get('baseSourceUsed', 'unknown')), styles['RiskValue']),
        Paragraph(
            'Coarse'
            if recommendation.get('currentLooksCoarse')
            else ('Fine' if recommendation.get('currentLooksFine') else 'Within target'),
            styles['RiskValue'],
        ),
    ]]
    risk_summary = Table(risk_summary_rows, colWidths=[58 * mm, 58 * mm, 58 * mm])
    risk_summary.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#fff7ed') if warnings else colors.HexColor('#f0fdf4')),
        ('BACKGROUND', (0, 1), (-1, 1), colors.HexColor('#ffedd5') if warnings else colors.HexColor('#dcfce7')),
        ('BOX', (0, 0), (-1, -1), 0.8, colors.HexColor('#fdba74') if warnings else colors.HexColor('#86efac')),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#fed7aa') if warnings else colors.HexColor('#bbf7d0')),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
    ]))
    elements.append(risk_summary)
    elements.append(Spacer(1, 5 * mm))

    viewer_preview = build_preview_image(viewport_preview_path, 174 * mm, 96 * mm)
    if viewer_preview is not None:
        viewer_table = Table([
            [Paragraph('Current Point Cloud View', styles['SectionHeading'])],
            [viewer_preview],
            [Paragraph('Captured from the active point-cloud viewport at export time.', styles['FigureCaption'])],
        ], colWidths=[174 * mm])
        viewer_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eff6ff')),
            ('BACKGROUND', (0, 1), (-1, 1), colors.white),
            ('BACKGROUND', (0, 2), (-1, 2), colors.HexColor('#f8fafc')),
            ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#cbd5e1')),
            ('INNERGRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#e2e8f0')),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ('ALIGN', (0, 1), (-1, 1), 'CENTER'),
        ]))
        elements.append(viewer_table)
        elements.append(Spacer(1, 5 * mm))

    summary_rows = [
        ['Analysis Surface', f"{analysis.get('surfaceType', 'unknown')} / {analysis.get('surfaceProfile', 'unknown')} / filter={analysis.get('pointFilterMode', 'unknown')}"],
        ['Base Surface', f"{base.get('mode', 'unknown')} / source={diagnostic.get('baseSourceUsed', 'unknown')}"],
        ['Reference Height', f"{base.get('referenceHeight', 0) if base.get('referenceHeight') is not None else 'n/a'}"],
        ['Recommended Resolution', f"{recommendation.get('recommendedResolution', 'n/a')} m (range {recommendation.get('recommendedMinResolution', 'n/a')} - {recommendation.get('recommendedMaxResolution', 'n/a')} m)"],
        ['Ground Support Ratio', f"{float(diagnostic.get('groundSupportRatio', 0) or 0):.4f} | usedGroundSupport={diagnostic.get('usedGroundSupport', False)}"],
        ['Artifact Bundle', 'PDF report / dual-surface mesh / dual-surface grid / previews'],
    ]
    summary_table = Table(summary_rows, colWidths=[42 * mm, 132 * mm])
    summary_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#eff6ff')),
        ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#cbd5e1')),
        ('INNERGRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#e2e8f0')),
        ('FONTNAME', (0, 0), (0, -1), 'Helvetica-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 8.5),
        ('LEADING', (0, 0), (-1, -1), 11),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    elements.append(Paragraph('Method + Inputs', styles['SectionHeading']))
    elements.append(summary_table)
    elements.append(Spacer(1, 4 * mm))

    warning_rows = [[Paragraph('Warnings and Operator Notes', styles['SectionHeading'])]]
    if warnings:
        for index, warning in enumerate(warnings, start=1):
            warning_rows.append([Paragraph(f"{index}. {warning}", styles['WarningText'])])
        warning_table = Table(warning_rows, colWidths=[174 * mm])
        warning_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#ffedd5')),
            ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#fff7ed')),
            ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#fdba74')),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ]))
    else:
        warning_rows.append([Paragraph('No critical warnings were raised for this volume job. Continue to verify suitability before production use.', styles['BodyText'])])
        warning_table = Table(warning_rows, colWidths=[174 * mm])
        warning_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#dcfce7')),
            ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#f0fdf4')),
            ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#86efac')),
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('RIGHTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ]))
    elements.append(warning_table)
    elements.append(Spacer(1, 4 * mm))

    elements.append(PageBreak())
    image_width = 82 * mm
    image_height = 64 * mm
    preview_row = []
    analysis_preview = build_preview_image(analysis_preview_path, image_width, image_height)
    if analysis_preview is not None:
        preview_row.append(analysis_preview)
    else:
        preview_row.append(Paragraph('Analysis preview unavailable', styles['BodyText']))
    base_preview = build_preview_image(base_preview_path, image_width, image_height)
    if base_preview is not None:
        preview_row.append(base_preview)
    else:
        preview_row.append(Paragraph('Base preview unavailable', styles['BodyText']))
    preview_table = Table([
        [Paragraph('Analysis Surface Preview', styles['SmallMuted']), Paragraph('Base Surface Preview', styles['SmallMuted'])],
        preview_row,
    ], colWidths=[86 * mm, 86 * mm])
    preview_table.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#cbd5e1')),
        ('INNERGRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#e2e8f0')),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (0, 1), (-1, -1), 'CENTER'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    elements.append(Paragraph('Surface Previews', styles['SectionHeading']))
    elements.append(preview_table)
    elements.append(Spacer(1, 4 * mm))
    elements.append(Paragraph('Interpretation', styles['SectionHeading']))
    elements.append(Paragraph(
        'This report was generated from the unified server-side volume job. Analysis and base surfaces are derived from the same job context so the displayed previews, downloadable meshes, and numeric results stay in sync. Verify suitability before production use, especially when warnings indicate fallback terrain approximation, coarse resolution, or weak classification support.',
        styles['SmallMuted'],
    ))

    doc.build(elements, onFirstPage=draw_page, onLaterPages=draw_page)


def main():
    if len(sys.argv) < 2:
        print('RESULT:' + json.dumps({'ok': False, 'error': 'Usage: compute_volume_analysis.py <payload.json>'}))
        sys.exit(1)

    payload = load_payload(sys.argv[1])
    if payload.get('reportOnly'):
        output_path = payload.get('outputPath') or os.path.join(os.path.dirname(payload.get('resultPath') or '.'), 'volume_report.pdf')
        result_path = payload.get('resultPath')
        if not result_path or not os.path.exists(result_path):
            raise ValueError('resultPath is required for report-only volume report generation.')
        with open(result_path, 'r', encoding='utf-8') as handle:
            result = json.load(handle)
        build_volume_pdf_report(
            output_path,
            result,
            payload.get('analysisPreviewPath'),
            payload.get('basePreviewPath'),
            payload.get('viewportPreviewPath'),
        )
        print('RESULT:' + json.dumps({
            'ok': True,
            'reportOnly': True,
            'outputPath': output_path,
        }))
        return

    las_path = payload['lasPath']
    output_dir = payload['outputDir']
    region_name = str(payload.get('regionName') or 'Volume Region')
    pointcloud_name = str(payload.get('pointcloudName') or payload.get('cloudName') or 'Point Cloud')
    polygon = payload['polygon']
    resolution = float(payload.get('resolution', 0.25))
    scenario_mode = str(payload.get('scenarioMode') or 'stockpile_boundary').lower()
    analysis_surface = payload.get('analysisSurface') or {}
    base_surface = payload.get('baseSurface') or {}
    hole_mode = str(payload.get('holeFillMode') or 'interpolate').lower()
    if hole_mode in ('reference', 'fixed'):
        hole_mode = 'fixed'
    elif hole_mode in ('leave', 'ignore'):
        hole_mode = 'leave'
    else:
        hole_mode = 'interpolate'
    point_filter_mode = str(analysis_surface.get('pointFilterMode') or 'all').lower()
    surface_type = str(analysis_surface.get('surfaceType') or 'stockpile').lower()
    aggregate_mode = str(analysis_surface.get('aggregateMode') or 'p80').lower()
    spike_threshold = analysis_surface.get('spikeThreshold', payload.get('spikeThreshold'))

    os.makedirs(output_dir, exist_ok=True)

    polygon_xy = [(float(p['x']), float(p['y'])) for p in polygon]
    bounds = polygon_bounds(polygon)
    polygon_path = MplPath(np.asarray(polygon_xy, dtype=np.float64))
    excluded_classes, ground_only = resolve_classification_filter(point_filter_mode)
    iter_fn = iter_batches_laspy if laspy is not None else iter_batches_fallback
    point_batches = list(iter_fn(las_path, polygon_xy, bounds, excluded_classes, ground_only))

    surface_profile = normalize_surface_profile(surface_type, aggregate_mode)
    reference_height = base_surface.get('referenceHeight')
    surface_ceiling = None
    if reference_height is not None and math.isfinite(float(reference_height)):
        max_rise = max(4.0, min(8.0, max(bounds['maxX'] - bounds['minX'], bounds['maxY'] - bounds['minY']) * 0.35))
        surface_ceiling = float(reference_height) + max_rise

    analysis_grid, analysis_support, res_x, res_y, sample_count, ground_count, classified_nondefault_count = build_grid_from_batches(
        point_batches,
        bounds,
        resolution,
        polygon_xy,
        profile=surface_profile,
        surface_ceiling=surface_ceiling,
    )
    dtm_fallback_used = False
    base_source_used = 'boundary'
    local_csf_stats = None
    # R-2 (2026-05-07): track how many boundary vertices were rejected as Z
    # outliers when (or if) a boundary base is later built. Stays 0 for
    # 'fixed' / 'ground' base modes that never call build_boundary_base_grid.
    boundary_vertex_outlier_count = 0
    ground_support_ratio = (float(ground_count) / float(sample_count)) if sample_count else 0.0
    if not np.isfinite(analysis_grid).any() and surface_type == 'dtm':
        dtm_fallback_used = True
        analysis_grid, analysis_support, res_x, res_y, sample_count, ground_count, classified_nondefault_count = build_grid_from_batches(
            point_batches,
            bounds,
            resolution,
            polygon_xy,
            profile='ground',
            surface_ceiling=surface_ceiling,
        )

    if not np.isfinite(analysis_grid).any():
        raise ValueError('No valid source points found in this region.')

    if spike_threshold is not None and np.isfinite(float(spike_threshold)):
        # R-3/R-16 (2026-05-07): spike denoise made symmetric and vectorized.
        # The previous version
        # only clamped positive flyers (local > p75 + threshold). On real
        # surfaces this leaves negative outliers intact — gravity-fed reflection
        # holes, water/ice mirrors, vehicle ruts, lone-low-noise points — which
        # then over-estimate cut and under-estimate fill. We now also clamp
        # local < p25 - threshold using the lower-quantile/median as the floor.
        threshold = max(0.05, float(spike_threshold))
        analysis_grid = denoise_spike_grid(analysis_grid, analysis_support, threshold)

    analysis_grid, res_x, res_y, downsample_factor = downsample_grid_if_needed(analysis_grid, res_x, res_y)
    analysis_grid, analysis_filled_count = fill_grid_holes(analysis_grid, hole_mode, fixed_height=reference_height)

    rows, cols = analysis_grid.shape
    base_mode = str(base_surface.get('mode') or '').lower() or ('fixed' if scenario_mode == 'plane_cut_fill' else 'boundary')
    if base_mode in ('constant', 'fixed', 'plane'):
        if reference_height is None or not math.isfinite(float(reference_height)):
            reference_height = float(np.nanmean(np.asarray([float(p.get('z', 0.0)) for p in polygon], dtype=np.float64)))
        base_grid = build_constant_base_grid(bounds, rows, cols, res_x, res_y, polygon_path, reference_height)
        base_mode = 'fixed'
        base_source_used = 'fixed_elevation'
    elif base_mode in ('ground_fit', 'ground', 'dtm'):
        ground_pair = build_ground_grid_pair_from_batches(
            point_batches,
            bounds,
            resolution * downsample_factor,
            polygon_xy,
            surface_ceiling=None,
        )
        ground_grid = ground_pair['groundGrid']
        ground_support_count = ground_pair['groundCount']
        if np.isfinite(ground_grid).any() and ground_support_count > 0:
            if ground_grid.shape != analysis_grid.shape:
                ground_grid, _, _, _ = downsample_grid_if_needed(ground_grid, res_x / downsample_factor, res_y / downsample_factor)
            # R-4 (2026-05-07): respect the user-selected hole_mode for the
            # base surface as well; previously hardcoded to 'interpolate' which
            # meant 'Leave holes' was honoured only on the analysis grid.
            base_grid, _ = fill_grid_holes(ground_grid, hole_mode, fixed_height=reference_height)
            base_source_used = 'ground_class2_fit'
        else:
            local_csf_result, local_csf_stats = build_local_csf_ground_grid(
                point_batches,
                bounds,
                resolution * downsample_factor,
                polygon_xy,
            )
            if local_csf_result and np.isfinite(local_csf_result['grid']).any():
                local_csf_grid = local_csf_result['grid']
                if local_csf_grid.shape != analysis_grid.shape:
                    local_csf_grid, _, _, _ = downsample_grid_if_needed(
                        local_csf_grid,
                        local_csf_result['resX'],
                        local_csf_result['resY'],
                    )
                base_grid, _ = fill_grid_holes(local_csf_grid, hole_mode, fixed_height=reference_height)
                base_source_used = 'local_csf_fit'
            else:
                fallback_ground_grid = ground_pair['fallbackGrid']
                fallback_sample_count = ground_pair['sampleCount']
                if np.isfinite(fallback_ground_grid).any() and fallback_sample_count > 0:
                    if fallback_ground_grid.shape != analysis_grid.shape:
                        fallback_ground_grid, _, _, _ = downsample_grid_if_needed(
                            fallback_ground_grid,
                            res_x / downsample_factor,
                            res_y / downsample_factor,
                        )
                    # R-4 (2026-05-07): same as above — base inherits user hole_mode.
                    base_grid, _ = fill_grid_holes(fallback_ground_grid, hole_mode, fixed_height=reference_height)
                    base_source_used = 'ground_quantile_fallback'
                else:
                    base_grid, boundary_vertex_outlier_count = build_boundary_base_grid(
                        bounds, polygon, rows, cols, res_x, res_y, polygon_path,
                    )
                    base_source_used = 'boundary_fallback'
        base_mode = 'ground'
    else:
        base_grid, boundary_vertex_outlier_count = build_boundary_base_grid(
            bounds, polygon, rows, cols, res_x, res_y, polygon_path,
        )
        base_mode = 'boundary'
        base_source_used = 'boundary_fit'

    # R-4 (2026-05-07): final base hole-fill also follows the user-selected
    # hole_mode so that 'leave' / 'reference' / 'interpolate' behave the same
    # on both surfaces — the integration loop below already skips cells where
    # either grid is NaN, which is the correct semantic for 'leave'.
    base_grid, base_filled_count = fill_grid_holes(base_grid, hole_mode, fixed_height=reference_height)

    effective_cell_count = 0
    interpolated_cell_count = int(analysis_filled_count)
    coverage_area = 0.0
    cut_volume = 0.0
    fill_volume = 0.0
    z_values = np.asarray([], dtype=np.float64)
    coverage_samples = []

    analysis_grid_for_save = analysis_grid.copy()
    base_grid_for_save = base_grid.copy()
    cell_area = res_x * res_y
    valid_cell_mask = np.isfinite(analysis_grid) & np.isfinite(base_grid)
    coverage_grid = build_coverage_grid(bounds, rows, cols, res_x, res_y, polygon_path, valid_cell_mask, samples=4)
    effective_mask = valid_cell_mask & (coverage_grid > 0)
    analysis_grid_for_save[~effective_mask] = np.nan
    base_grid_for_save[~effective_mask] = np.nan

    effective_cell_count = int(np.count_nonzero(effective_mask))
    if effective_cell_count > 0:
        effective_coverage = coverage_grid[effective_mask].astype(np.float64)
        coverage_area = float(np.sum(effective_coverage) * cell_area)
        coverage_samples = effective_coverage.tolist()
        delta_grid = (analysis_grid - base_grid).astype(np.float64)
        weighted_volume = delta_grid[effective_mask] * cell_area * effective_coverage
        cut_volume = float(np.sum(weighted_volume[weighted_volume > 0]))
        fill_volume = float(np.sum(-weighted_volume[weighted_volume < 0]))
        z_values = analysis_grid[effective_mask].astype(np.float64)

    if effective_cell_count <= 0:
        raise ValueError('No overlapping valid cells were produced for this region.')

    polygon_area = polygon_area_xy(polygon_xy)
    coverage_ratio = coverage_area / max(polygon_area, 1e-9)
    resolution_recommendation = get_resolution_recommendation(
        polygon_area,
        scenario_mode,
        resolution,
        effective_cell_count,
    )

    analysis_meta = {
        'type': 'volume_analysis_surface',
        'surfaceRole': 'analysis',
        'scenarioMode': scenario_mode,
        'surfaceType': surface_type,
        'surfaceProfile': surface_profile,
        'pointFilterMode': point_filter_mode,
        'dtmFallbackUsed': dtm_fallback_used,
        'holeMode': hole_mode,
        'rows': int(rows),
        'cols': int(cols),
        'xMin': float(bounds['minX']),
        'yMin': float(bounds['minY']),
        'resolutionX': float(res_x),
        'resolutionY': float(res_y),
        'sampleCount': int(sample_count),
        'groundPointCount': int(ground_count),
        'filledCellCount': int(analysis_filled_count),
        'downsampleFactor': int(downsample_factor),
        'sourcePath': os.path.abspath(las_path),
        'polygon': polygon,
    }
    base_meta = {
        'type': 'volume_base_surface',
        'surfaceRole': 'base',
        'scenarioMode': scenario_mode,
        'baseMode': base_mode,
        'referenceHeight': reference_height,
        'rows': int(rows),
        'cols': int(cols),
        'xMin': float(bounds['minX']),
        'yMin': float(bounds['minY']),
        'resolutionX': float(res_x),
        'resolutionY': float(res_y),
        'filledCellCount': int(base_filled_count),
        'sourcePath': os.path.abspath(las_path),
        'polygon': polygon,
    }

    analysis_mesh_json, analysis_mesh = mesh_json_from_grid(analysis_grid_for_save, bounds, res_x, res_y, analysis_meta)
    base_mesh_json, base_mesh = mesh_json_from_grid(base_grid_for_save, bounds, res_x, res_y, base_meta)

    save_preview_png(analysis_grid_for_save, os.path.join(output_dir, 'preview_analysis.png'))
    save_preview_png(base_grid_for_save, os.path.join(output_dir, 'preview_base.png'))
    write_obj(os.path.join(output_dir, 'analysis_surface.obj'), analysis_mesh)
    write_obj(os.path.join(output_dir, 'base_surface.obj'), base_mesh)

    with open(os.path.join(output_dir, 'analysis_surface_mesh.json'), 'w', encoding='utf-8') as handle:
        json.dump(analysis_mesh_json, handle, separators=(',', ':'))
    with open(os.path.join(output_dir, 'base_surface_mesh.json'), 'w', encoding='utf-8') as handle:
        json.dump(base_mesh_json, handle, separators=(',', ':'))
    with open(os.path.join(output_dir, 'analysis_surface_grid.json'), 'w', encoding='utf-8') as handle:
        json.dump({'meta': analysis_meta, 'grid': np.where(np.isfinite(analysis_grid_for_save), analysis_grid_for_save, None).tolist()}, handle, separators=(',', ':'))
    with open(os.path.join(output_dir, 'base_surface_grid.json'), 'w', encoding='utf-8') as handle:
        json.dump({'meta': base_meta, 'grid': np.where(np.isfinite(base_grid_for_save), base_grid_for_save, None).tolist()}, handle, separators=(',', ':'))

    warnings = []
    if dtm_fallback_used:
        warnings.append('DTM mode did not find enough class-2 points and fell back to P20 on filtered points.')
    if base_mode == 'ground' and base_source_used == 'ground_quantile_fallback':
        warnings.append('Ground-fit base had no usable class-2 terrain support and approximated terrain from the low-percentile surface of unclassified points.')
    if base_mode == 'ground' and base_source_used == 'local_csf_fit':
        ground_pct = float((local_csf_stats or {}).get('groundRatio') or 0.0) * 100.0
        warnings.append(f'Ground-fit base used local CSF ground classification inside the selected region because class-2 support was unavailable ({ground_pct:.1f}% local ground candidates).')
    if base_mode == 'ground' and base_source_used == 'boundary_fallback':
        warnings.append('Ground-fit base could not derive a usable terrain-like surface and fell back to boundary interpolation.')
    if base_mode == 'ground' and base_source_used == 'ground_class2_fit' and ground_support_ratio < 0.05:
        warnings.append('Ground support ratio is very low; verify classification quality before trusting the fitted base surface.')
    if boundary_vertex_outlier_count > 0:
        # R-2 (2026-05-07): operators sometimes click polygon vertices on top
        # of the very pile they are measuring. We drop those outliers from the
        # boundary IDW so the base surface is not dragged upward, but we still
        # surface the fact so the user can review the polygon if needed.
        warnings.append(
            f"Excluded {boundary_vertex_outlier_count} boundary vertex elevation outlier(s) before building the base surface. Verify your boundary if the cut/fill numbers look unexpected."
        )
    if coverage_ratio < 0.85:
        warnings.append('Effective polygon coverage is below 85%; inspect the selected boundary and resolution.')
    if effective_cell_count < 500:
        warnings.append('Effective cell count is low for this region; consider a finer resolution for more stable volume results.')
    if resolution_recommendation['currentLooksCoarse']:
        warnings.append(
            f"Current resolution {float(resolution):.3f} m looks coarse for this region; try around {resolution_recommendation['recommendedResolution']:.3f} m."
        )

    result = {
        'jobId': os.path.basename(output_dir),
        'scenarioMode': scenario_mode,
        'reportMeta': {
            'regionName': region_name,
            'pointcloudName': pointcloud_name,
            'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        },
        'analysisSurface': {
            'surfaceType': surface_type,
            'surfaceProfile': surface_profile,
            'aggregateMode': aggregate_mode,
            'pointFilterMode': point_filter_mode,
            'meta': analysis_meta,
        },
        'baseSurface': {
            'mode': base_mode,
            'referenceHeight': reference_height,
            'meta': base_meta,
        },
        'stats': {
            'inputPointCount': int(sample_count),
            'filteredPointCount': int(sample_count),
            'groundPointCount': int(ground_count),
            'classifiedNonDefaultCount': int(classified_nondefault_count),
            'effectiveCellCount': int(effective_cell_count),
            'interpolatedCellCount': int(interpolated_cell_count),
            'effectiveArea': float(coverage_area),
            'polygonArea': float(polygon_area),
            'currentResolution': float(resolution),
            'coverageRatio': float(min(coverage_ratio, 1.0)),
            'avgCellCoverage': float(np.mean(coverage_samples)) if coverage_samples else 0.0,
        },
        'volume': {
            'cutVolume': float(cut_volume),
            'fillVolume': float(fill_volume),
            'netVolume': float(fill_volume - cut_volume),
            'minSurface': float(np.nanmin(z_values)) if z_values.size else None,
            'maxSurface': float(np.nanmax(z_values)) if z_values.size else None,
            'avgSurface': float(np.nanmean(z_values)) if z_values.size else None,
        },
        'diagnostic': {
            'confidence': 'medium' if warnings else 'high',
            'warnings': warnings,
            'baseSourceUsed': base_source_used,
            'dtmFallbackUsed': dtm_fallback_used,
            'groundSupportRatio': ground_support_ratio,
            'usedGroundSupport': base_source_used == 'ground_class2_fit',
            'localCsfUsed': base_source_used == 'local_csf_fit',
            'localCsfStats': local_csf_stats,
            'resolutionRecommendation': resolution_recommendation,
        },
    }

    report_status = {
        'pdfAvailable': False,
        'error': None,
    }
    try:
        build_volume_pdf_report(
            os.path.join(output_dir, 'volume_report.pdf'),
            result,
            os.path.join(output_dir, 'preview_analysis.png'),
            os.path.join(output_dir, 'preview_base.png'),
            payload.get('viewportPreviewPath'),
        )
        report_status['pdfAvailable'] = True
    except Exception as report_exc:
        report_status['error'] = str(report_exc)
        print(f"PDF report generation warning: {report_exc}", file=sys.stderr)

    result['reportStatus'] = report_status

    with open(os.path.join(output_dir, 'result.json'), 'w', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)

    print('RESULT:' + json.dumps({
        'ok': True,
        'jobId': os.path.basename(output_dir),
        'result': result,
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('RESULT:' + json.dumps({'ok': False, 'error': str(exc)}))
        raise
