#!/usr/bin/env python3
"""
generate_volume_surface.py

Build a local surface mesh for a selected volume region and export:
  - preview.png
  - grid.npy
  - meta.json
  - surface.obj
  - surface_mesh.json
  - surface_grid.json

Input is a JSON payload file path.
"""

import json
import math
import os
import sys

import numpy as np

try:
    import laspy
except ImportError:
    laspy = None

from matplotlib.path import Path as MplPath

from generate_dtm import read_las_fast, save_preview_png
from generate_surface_mesh import (
    build_surface_mesh,
    downsample_grid_if_needed,
    fill_grid_holes,
    write_obj,
)


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


def cell_intersects_polygon(ix, iy, bounds, res_x, res_y, polygon_xy, polygon_path):
    x0 = bounds['minX'] + ix * res_x
    y0 = bounds['minY'] + iy * res_y
    x1 = x0 + res_x
    y1 = y0 + res_y
    cx = x0 + res_x * 0.5
    cy = y0 + res_y * 0.5
    if polygon_path.contains_point((cx, cy)):
        return True
    corners = np.asarray([
        (x0, y0),
        (x1, y0),
        (x1, y1),
        (x0, y1),
    ], dtype=np.float64)
    if np.any(polygon_path.contains_points(corners)):
        return True
    for px, py in polygon_xy:
        if x0 <= px <= x1 and y0 <= py <= y1:
            return True
    return False


def iter_points_in_polygon_laspy(las_path, polygon_xy, bounds, surface_type):
    """Stream points from a LAS/LAZ file clipped to the polygon.

    For 'dtm' mode, only ground-classified (class=2) points are yielded
    when classification data is present in the file.  Chunks that lack
    class-2 points are skipped entirely; if the result is an empty
    sequence the caller can detect and trigger a fallback path.
    """
    if laspy is None:
        raise RuntimeError('laspy is not available')

    min_x = bounds['minX']
    max_x = bounds['maxX']
    min_y = bounds['minY']
    max_y = bounds['maxY']
    want_ground = surface_type == 'dtm'

    def _gen():
        with laspy.open(las_path) as reader:
            for chunk in reader.chunk_iterator(1_000_000):
                x_raw = chunk.x
                y_raw = chunk.y
                z_raw = chunk.z
                bbox_mask = (
                    (x_raw >= min_x) & (x_raw <= max_x) &
                    (y_raw >= min_y) & (y_raw <= max_y)
                )
                if want_ground and hasattr(chunk, 'classification'):
                    ground_mask = bbox_mask & (np.asarray(chunk.classification) == 2)
                    if np.any(ground_mask):
                        mask = ground_mask
                    else:
                        # This chunk has no ground-classified points; skip for DTM.
                        continue
                else:
                    mask = bbox_mask
                if not np.any(mask):
                    continue
                x = np.asarray(x_raw[mask], dtype=np.float64)
                y = np.asarray(y_raw[mask], dtype=np.float64)
                z = np.asarray(z_raw[mask], dtype=np.float64)
                inside = vectorized_points_in_polygon(x, y, polygon_xy)
                if not np.any(inside):
                    continue
                yield x[inside], y[inside], z[inside]

    return _gen()


def read_points_in_polygon_fallback(las_path, polygon_xy, bounds, surface_type):
    cloud = read_las_fast(las_path)
    x = np.asarray(cloud['x'], dtype=np.float64)
    y = np.asarray(cloud['y'], dtype=np.float64)
    z = np.asarray(cloud['z'], dtype=np.float64)
    classification = np.asarray(cloud.get('classification')) if cloud.get('classification') is not None else None

    mask = (
        (x >= bounds['minX']) & (x <= bounds['maxX']) &
        (y >= bounds['minY']) & (y <= bounds['maxY'])
    )
    if surface_type == 'dtm' and classification is not None:
        ground_mask = mask & (classification == 2)
        if np.any(ground_mask):
            mask = ground_mask
        # else: no class-2 points → use all points, fallback handled after build
    x = x[mask]
    y = y[mask]
    z = z[mask]
    if x.size:
        inside = vectorized_points_in_polygon(x, y, polygon_xy)
        x = x[inside]
        y = y[inside]
        z = z[inside]
    return [(x, y, z)]


def robust_surface_value(values, profile='stockpile'):
    vals = np.asarray(values, dtype=np.float64)
    if vals.size == 0:
        return math.nan
    if vals.size == 1:
        return float(vals[0])
    profile = str(profile or 'stockpile').lower()
    if profile in ('stockpile', 'p80'):
        return float(np.percentile(vals, 80 if vals.size >= 6 else 75))
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
    return float(np.median(vals))


def build_local_grid(point_batches, bounds, resolution, polygon_xy, profile='stockpile', reference_height=None):
    width = max(bounds['maxX'] - bounds['minX'], resolution)
    height = max(bounds['maxY'] - bounds['minY'], resolution)
    cols = max(2, int(math.ceil(width / resolution)))
    rows = max(2, int(math.ceil(height / resolution)))
    res_x = width / max(cols, 1)
    res_y = height / max(rows, 1)
    polygon_path = MplPath(np.asarray(polygon_xy, dtype=np.float64))
    surface_ceiling = None
    if reference_height is not None and math.isfinite(float(reference_height)):
        max_rise = max(4.0, min(8.0, max(width, height) * 0.35))
        surface_ceiling = float(reference_height) + max_rise

    cells = {}
    sample_count = 0
    for x, y, z in point_batches:
        if x.size == 0:
            continue
        if surface_ceiling is not None:
            keep = np.asarray(z, dtype=np.float64) <= surface_ceiling
            if not np.any(keep):
                continue
            x = x[keep]
            y = y[keep]
            z = z[keep]
            if x.size == 0:
                continue
        ix = np.clip(((x - bounds['minX']) / res_x).astype(np.int32), 0, cols - 1)
        iy = np.clip(((y - bounds['minY']) / res_y).astype(np.int32), 0, rows - 1)
        for idx in range(x.size):
            key = (int(iy[idx]), int(ix[idx]))
            cell = cells.get(key)
            if cell is None:
                cell = {'z': [], 'sumX': 0.0, 'sumY': 0.0, 'count': 0}
                cells[key] = cell
            cell['z'].append(float(z[idx]))
            cell['sumX'] += float(x[idx])
            cell['sumY'] += float(y[idx])
            cell['count'] += 1
            sample_count += 1

    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    support = np.zeros((rows, cols), dtype=np.int32)
    centroid_x = np.full((rows, cols), np.nan, dtype=np.float32)
    centroid_y = np.full((rows, cols), np.nan, dtype=np.float32)

    for (iy, ix), cell in cells.items():
        grid[iy, ix] = np.float32(robust_surface_value(cell['z'], profile=profile))
        support[iy, ix] = int(cell['count'])
        centroid_x[iy, ix] = np.float32(cell['sumX'] / max(cell['count'], 1))
        centroid_y[iy, ix] = np.float32(cell['sumY'] / max(cell['count'], 1))

    for iy in range(rows):
        for ix in range(cols):
            if not np.isfinite(grid[iy, ix]):
                continue
            if not cell_intersects_polygon(ix, iy, bounds, res_x, res_y, polygon_xy, polygon_path):
                grid[iy, ix] = np.nan
                support[iy, ix] = 0
                centroid_x[iy, ix] = np.nan
                centroid_y[iy, ix] = np.nan

    return grid, support, centroid_x, centroid_y, res_x, res_y, sample_count


def suppress_spikes(grid, support, resolution, threshold_override=None):
    result = grid.copy()
    threshold = float(threshold_override) if threshold_override is not None else max(0.18, resolution * 0.9)
    threshold = max(0.05, threshold)
    rows, cols = result.shape
    for _ in range(2):
        updated = result.copy()
        changed = 0
        for iy in range(rows):
            y0 = max(0, iy - 1)
            y1 = min(rows, iy + 2)
            for ix in range(cols):
                if not np.isfinite(result[iy, ix]):
                    continue
                x0 = max(0, ix - 1)
                x1 = min(cols, ix + 2)
                neighbors = result[y0:y1, x0:x1]
                neigh = neighbors[np.isfinite(neighbors)]
                if neigh.size < 4:
                    continue
                local = float(result[iy, ix])
                median = float(np.median(neigh))
                upper = float(np.percentile(neigh, 75))
                if local > upper + threshold and support[iy, ix] <= 2:
                    updated[iy, ix] = np.float32(max(median, upper))
                    changed += 1
        result = updated
        if changed == 0:
            break
    return result


def main():
    if len(sys.argv) < 2:
        print('RESULT:' + json.dumps({'ok': False, 'error': 'Usage: generate_volume_surface.py <payload.json>'}))
        sys.exit(1)

    payload = load_payload(sys.argv[1])
    las_path = payload['lasPath']
    output_dir = payload['outputDir']
    polygon = payload['polygon']
    resolution = float(payload.get('resolution', 0.25))
    hole_mode = str(payload.get('holeMode') or 'interpolate').lower()
    fixed_height = payload.get('fixedHeight')
    surface_type = str(payload.get('surfaceType') or 'stockpile').lower()
    spike_threshold = payload.get('spikeThreshold')
    reference_height = payload.get('referenceHeight')

    # Each surface_type has a canonical aggregation profile.
    # The user-selected aggregateMode only applies to 'stockpile' mode.
    if surface_type == 'dsm':
        surface_profile = 'max'          # absolute highest point per cell
    elif surface_type == 'dtm':
        surface_profile = 'ground'       # P20 — approximates ground level
    else:
        # stockpile: honour user selection, default p80
        surface_profile = str(payload.get('aggregateMode') or payload.get('surfaceProfile') or 'p80').lower()

    dtm_fallback_used = False

    os.makedirs(output_dir, exist_ok=True)

    polygon_xy = [(float(p['x']), float(p['y'])) for p in polygon]
    bounds = polygon_bounds(polygon)

    # ── Hard memory guard (2 GB server) ──────────────────────────────────────
    # Estimate grid dimensions and bail out before allocating anything heavy.
    _w = max(bounds['maxX'] - bounds['minX'], resolution)
    _h = max(bounds['maxY'] - bounds['minY'], resolution)
    _cols = max(2, int(math.ceil(_w / resolution)))
    _rows = max(2, int(math.ceil(_h / resolution)))
    _cells = _cols * _rows
    MAX_CELLS = 40000  # ~200×200; ~5 float32 arrays × 4 B × 40k ≈ 3.2 MB; safe on 2 GB
    if _cells > MAX_CELLS:
        print('RESULT:' + json.dumps({
            'ok': False,
            'error': f'Grid too large for this server ({_cells:,} cells > {MAX_CELLS:,}). '
                     f'Increase Cell Size (current {resolution} m) or reduce the region.'
        }))
        sys.exit(1)
    # ─────────────────────────────────────────────────────────────────────────

    if laspy is not None:
        point_batches = iter_points_in_polygon_laspy(las_path, polygon_xy, bounds, surface_type)
    else:
        point_batches = read_points_in_polygon_fallback(las_path, polygon_xy, bounds, surface_type)

    grid, support, centroid_x, centroid_y, res_x, res_y, sample_count = build_local_grid(
        point_batches,
        bounds,
        resolution,
        polygon_xy,
        profile=surface_profile,
        reference_height=reference_height,
    )

    if not np.isfinite(grid).any():
        if surface_type == 'dtm':
            # No ground-classified (class=2) points found.  Fall back to all points
            # aggregated at P20 so users see something useful even on unclassified clouds.
            print(
                'WARNING: No ground-classified (class=2) points found in this region. '
                'Falling back to all points with P20 aggregation.',
                file=sys.stderr
            )
            dtm_fallback_used = True
            if laspy is not None:
                point_batches_fb = iter_points_in_polygon_laspy(las_path, polygon_xy, bounds, 'dsm')
            else:
                point_batches_fb = read_points_in_polygon_fallback(las_path, polygon_xy, bounds, 'dsm')
            grid, support, centroid_x, centroid_y, res_x, res_y, sample_count = build_local_grid(
                point_batches_fb,
                bounds,
                resolution,
                polygon_xy,
                profile='ground',   # P20
                reference_height=reference_height,
            )
        if not np.isfinite(grid).any():
            raise ValueError(
                'No valid source points found in this region. '
                'Check that the point cloud overlaps the selected polygon.'
            )

    grid = suppress_spikes(grid, support, max(res_x, res_y), spike_threshold)
    grid, res_x, res_y, downsample_factor = downsample_grid_if_needed(grid, res_x, res_y)
    support = support[::downsample_factor, ::downsample_factor].copy()
    final_grid, filled_count = fill_grid_holes(grid, hole_mode, fixed_height=fixed_height)

    # Re-apply polygon boundary mask and fill all boundary-edge cells.
    polygon_path_final = MplPath(np.asarray(polygon_xy, dtype=np.float64))
    rows_f, cols_f = final_grid.shape

    # Build centroid coordinate arrays
    _iy = np.arange(rows_f, dtype=np.float64)
    _ix = np.arange(cols_f, dtype=np.float64)
    _ixg, _iyg = np.meshgrid(_ix, _iy)
    _cx = bounds['minX'] + (_ixg + 0.5) * res_x
    _cy = bounds['minY'] + (_iyg + 0.5) * res_y
    _pts = np.column_stack([_cx.ravel(), _cy.ravel()])

    # Generous mask: expand by half-cell diagonal so boundary-edge cells that
    # partially overlap the polygon are included, giving complete edge coverage.
    _cell_diag = math.sqrt(res_x ** 2 + res_y ** 2) * 0.55
    _inside_generous = polygon_path_final.contains_points(
        _pts, radius=_cell_diag
    ).reshape(rows_f, cols_f)

    # Remove valid cells that fall outside even the generous boundary
    final_grid = np.where(_inside_generous | ~np.isfinite(final_grid), final_grid, np.nan).astype(np.float32)

    # Vectorized full-coverage fill: propagate values into every unfilled cell that
    # touches the polygon (generous mask), including boundary-edge partial cells.
    # Each iteration fills one more cell-width layer; runs until convergence.
    _max_iters = rows_f + cols_f
    for _ in range(_max_iters):
        _nan_inside = ~np.isfinite(final_grid) & _inside_generous
        if not _nan_inside.any():
            break
        _padded = np.pad(final_grid, 1, mode='constant', constant_values=np.nan)
        _neighbors = np.stack([
            _padded[:-2, 1:-1],   # north
            _padded[2:,  1:-1],   # south
            _padded[1:-1, :-2],   # west
            _padded[1:-1, 2:],    # east
        ], axis=0)
        with np.errstate(all='ignore'):
            _fill_vals = np.nanmean(_neighbors, axis=0).astype(np.float32)
        _can_fill = _nan_inside & np.isfinite(_fill_vals)
        if not _can_fill.any():
            break
        final_grid[_can_fill] = _fill_vals[_can_fill]

    mesh = build_surface_mesh(final_grid, bounds['minX'], bounds['minY'], res_x, res_y)

    np.save(os.path.join(output_dir, 'grid.npy'), final_grid.astype(np.float32))
    save_preview_png(final_grid, os.path.join(output_dir, 'preview.png'))
    write_obj(os.path.join(output_dir, 'surface.obj'), mesh)

    meta = {
      'type': 'volume_surface_mesh',
      'surfaceType': surface_type,
      'surfaceProfile': surface_profile,
      'dtmFallbackUsed': dtm_fallback_used,
      'holeMode': hole_mode,
      'fixedHeight': fixed_height,
      'rows': int(final_grid.shape[0]),
      'cols': int(final_grid.shape[1]),
      'xMin': float(bounds['minX']),
      'yMin': float(bounds['minY']),
      'resolutionX': float(res_x),
      'resolutionY': float(res_y),
      'zMin': float(mesh['zMin']),
      'zMax': float(mesh['zMax']),
      'vertexCount': int(len(mesh['vertices'])),
      'faceCount': int(len(mesh['faces'])),
      'filledCellCount': int(filled_count),
      'sampleCount': int(sample_count),
      'downsampleFactor': int(downsample_factor),
      'sourcePath': os.path.abspath(las_path),
      'polygon': polygon,
    }

    with open(os.path.join(output_dir, 'meta.json'), 'w', encoding='utf-8') as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    with open(os.path.join(output_dir, 'surface_mesh.json'), 'w', encoding='utf-8') as handle:
        json.dump({
            'meta': meta,
            'vertices': mesh['vertices'],
            'colors': mesh['colors'],
            'faces': mesh['faces'],
        }, handle, separators=(',', ':'))
    with open(os.path.join(output_dir, 'surface_grid.json'), 'w', encoding='utf-8') as handle:
        json.dump({
            'meta': meta,
            'grid': np.where(np.isfinite(final_grid), final_grid, None).tolist(),
        }, handle, separators=(',', ':'))

    print('RESULT:' + json.dumps({
        'ok': True,
        'stats': {
            'rows': meta['rows'],
            'cols': meta['cols'],
            'zMin': meta['zMin'],
            'zMax': meta['zMax'],
            'vertexCount': meta['vertexCount'],
            'faceCount': meta['faceCount'],
            'filledCellCount': meta['filledCellCount'],
            'sampleCount': meta['sampleCount'],
            'downsampleFactor': meta['downsampleFactor'],
        }
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('RESULT:' + json.dumps({'ok': False, 'error': str(exc)}))
        raise
