#!/usr/bin/env python3
"""
generate_surface_mesh.py - Build a local terrain surface mesh from LAS/LAZ input.

Usage:
    python generate_surface_mesh.py <las_path> <output_dir> <surface_type> <resolution> <hole_mode> [fixed_height]

Outputs:
    <output_dir>/preview.png
    <output_dir>/grid.npy
    <output_dir>/meta.json
    <output_dir>/surface.obj
    <output_dir>/surface_mesh.json
    <output_dir>/surface_grid.json
"""

import json
import math
import os
import sys

import numpy as np

from generate_dtm import read_las_fast, make_elevation_grid, save_preview_png


MAX_SURFACE_CELLS = 350_000


def downsample_grid_if_needed(grid, res_x, res_y):
    rows, cols = grid.shape
    cell_count = rows * cols
    if cell_count <= MAX_SURFACE_CELLS:
        return grid, res_x, res_y, 1

    factor = int(math.ceil(math.sqrt(cell_count / MAX_SURFACE_CELLS)))
    factor = max(2, factor)
    reduced = grid[::factor, ::factor].copy()
    return reduced, res_x * factor, res_y * factor, factor


def fill_grid_holes(grid, hole_mode, fixed_height=None):
    hole_mode = str(hole_mode or 'interpolate').strip().lower()
    if hole_mode == 'ignore':
        hole_mode = 'leave'
    elif hole_mode == 'reference':
        hole_mode = 'fixed'

    result = grid.copy()
    original_valid_mask = np.isfinite(result)
    original_valid_count = int(np.count_nonzero(original_valid_mask))

    if hole_mode == 'leave':
        return result, 0

    if hole_mode == 'fixed':
        if fixed_height is None or not math.isfinite(float(fixed_height)):
            valid = result[np.isfinite(result)]
            fixed_height = float(np.nanmean(valid)) if valid.size else 0.0
        fill_mask = ~np.isfinite(result)
        result[fill_mask] = np.float32(fixed_height)
        return result, int(np.count_nonzero(fill_mask))

    # interpolate
    nan_mask = ~np.isfinite(result)
    if not np.any(nan_mask):
        return result, 0

    for _ in range(128):
        changed = 0
        updated = result.copy()
        rows, cols = result.shape
        for iy in range(rows):
            y0 = max(0, iy - 1)
            y1 = min(rows, iy + 2)
            for ix in range(cols):
                if np.isfinite(result[iy, ix]):
                    continue
                x0 = max(0, ix - 1)
                x1 = min(cols, ix + 2)
                neighbors = result[y0:y1, x0:x1]
                valid = neighbors[np.isfinite(neighbors)]
                if valid.size >= 3:
                    updated[iy, ix] = np.float32(valid.mean())
                    changed += 1
        result = updated
        if changed == 0:
            break

    remaining = ~np.isfinite(result)
    if np.any(remaining):
        valid = result[np.isfinite(result)]
        fallback = float(np.nanmean(valid)) if valid.size else 0.0
        result[remaining] = np.float32(fallback)

    filled_count = int(np.count_nonzero(np.isfinite(result)) - original_valid_count)
    return result, filled_count


def elevation_color(z, z_min, z_max):
    if not math.isfinite(z_max) or not math.isfinite(z_min) or z_max <= z_min:
        return (0.70, 0.78, 0.92)
    t = max(0.0, min(1.0, (z - z_min) / (z_max - z_min)))
    stops = [
        (0.00, (0.10, 0.24, 0.56)),
        (0.18, (0.14, 0.47, 0.73)),
        (0.36, (0.21, 0.62, 0.45)),
        (0.58, (0.70, 0.74, 0.42)),
        (0.80, (0.63, 0.43, 0.25)),
        (1.00, (0.94, 0.95, 0.98)),
    ]
    for idx in range(len(stops) - 1):
        t0, c0 = stops[idx]
        t1, c1 = stops[idx + 1]
        if t <= t1:
            local = 0.0 if t1 <= t0 else (t - t0) / (t1 - t0)
            return tuple(c0[i] + (c1[i] - c0[i]) * local for i in range(3))
    return stops[-1][1]


def build_surface_mesh(grid, x_min, y_min, res_x, res_y):
    rows, cols = grid.shape
    valid_mask = np.isfinite(grid)
    if not np.any(valid_mask):
        raise ValueError('Surface grid has no valid cells')

    z_values = grid[valid_mask]
    z_min = float(np.nanmin(z_values))
    z_max = float(np.nanmax(z_values))

    vertices = []
    colors = []
    vertex_index = np.full((rows, cols), -1, dtype=np.int32)

    for iy in range(rows):
      y = y_min + iy * res_y + res_y * 0.5
      for ix in range(cols):
        z = grid[iy, ix]
        if not np.isfinite(z):
            continue
        x = x_min + ix * res_x + res_x * 0.5
        vertex_index[iy, ix] = len(vertices)
        vertices.append((round(float(x), 4), round(float(y), 4), round(float(z), 4)))
        colors.append(tuple(round(c, 5) for c in elevation_color(float(z), z_min, z_max)))

    faces = []
    for iy in range(rows - 1):
        for ix in range(cols - 1):
            a = int(vertex_index[iy, ix])
            b = int(vertex_index[iy, ix + 1])
            c = int(vertex_index[iy + 1, ix])
            d = int(vertex_index[iy + 1, ix + 1])
            if a >= 0 and b >= 0 and c >= 0:
                faces.append((a, b, c))
            if b >= 0 and d >= 0 and c >= 0:
                faces.append((b, d, c))

    return {
        'vertices': vertices,
        'colors': colors,
        'faces': faces,
        'zMin': z_min,
        'zMax': z_max,
    }


def write_obj(path, mesh):
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write('# CloudStudio surface mesh\n')
        for (x, y, z), (r, g, b) in zip(mesh['vertices'], mesh['colors']):
            handle.write(f'v {x:.4f} {y:.4f} {z:.4f} {r:.5f} {g:.5f} {b:.5f}\n')
        for a, b, c in mesh['faces']:
            handle.write(f'f {a + 1} {b + 1} {c + 1}\n')


def main():
    if len(sys.argv) < 6:
        print(json.dumps({'error': 'Usage: generate_surface_mesh.py <las_path> <output_dir> <surface_type> <resolution> <hole_mode> [fixed_height]'}))
        sys.exit(1)

    las_path = sys.argv[1]
    output_dir = sys.argv[2]
    surface_type = sys.argv[3].lower()
    resolution = float(sys.argv[4])
    hole_mode = sys.argv[5].lower()
    fixed_height = float(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] not in ('', 'null', 'None') else None

    if surface_type not in ('dtm', 'dsm'):
        raise ValueError("surface_type must be 'dtm' or 'dsm'")
    if hole_mode not in ('leave', 'interpolate', 'fixed'):
        raise ValueError("hole_mode must be 'leave', 'interpolate', or 'fixed'")

    os.makedirs(output_dir, exist_ok=True)

    cloud = read_las_fast(las_path)
    x = cloud['x']
    y = cloud['y']
    z = cloud['z']
    classification = cloud.get('classification')

    if surface_type == 'dtm' and classification is not None:
        ground_mask = classification == 2
        if np.count_nonzero(ground_mask) >= 100:
            x = x[ground_mask]
            y = y[ground_mask]
            z = z[ground_mask]

    grid_method = 'min' if surface_type == 'dtm' else 'max'
    grid, x_min, y_min, res_x, res_y = make_elevation_grid(x, y, z, resolution, method=grid_method)
    grid, res_x, res_y, downsample_factor = downsample_grid_if_needed(grid, res_x, res_y)
    final_grid, filled_count = fill_grid_holes(grid, hole_mode, fixed_height=fixed_height)

    mesh = build_surface_mesh(final_grid, x_min, y_min, res_x, res_y)

    np.save(os.path.join(output_dir, 'grid.npy'), final_grid.astype(np.float32))
    save_preview_png(final_grid, os.path.join(output_dir, 'preview.png'))
    write_obj(os.path.join(output_dir, 'surface.obj'), mesh)

    meta = {
        'type': 'surface_mesh',
        'surfaceType': surface_type,
        'holeMode': hole_mode,
        'fixedHeight': fixed_height,
        'rows': int(final_grid.shape[0]),
        'cols': int(final_grid.shape[1]),
        'xMin': float(x_min),
        'yMin': float(y_min),
        'resolutionX': float(res_x),
        'resolutionY': float(res_y),
        'zMin': float(mesh['zMin']),
        'zMax': float(mesh['zMax']),
        'vertexCount': int(len(mesh['vertices'])),
        'faceCount': int(len(mesh['faces'])),
        'filledCellCount': int(filled_count),
        'downsampleFactor': int(downsample_factor),
        'sourcePath': os.path.abspath(las_path),
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
            'downsampleFactor': meta['downsampleFactor'],
        }
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('RESULT:' + json.dumps({'ok': False, 'error': str(exc)}))
        raise
