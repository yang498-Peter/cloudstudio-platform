#!/usr/bin/env python3
"""
generate_contours.py — Generate contour lines from DTM grid

Usage:
    python3 generate_contours.py <dtm_dir> <output_dir> <interval> [formats]

Arguments:
    dtm_dir    - Directory containing grid.npy and meta.json from generate_dtm.py
    output_dir - Directory to write contour files
    interval   - Contour interval in meters (e.g. 1.0)
    formats    - Comma-separated list: 'geojson,dxf' (default: both)

Outputs:
    <output_dir>/contours.geojson  - GeoJSON LineString features with elevation
    <output_dir>/contours.dxf      - AutoCAD DXF with POLYLINE entities
    <output_dir>/contour_meta.json - Statistics
"""

import sys, os, json, math, traceback, subprocess
import numpy as np


def _ensure_package(pkg_import, pkg_pip=None):
    """Import *pkg_import*; auto-install *pkg_pip* (defaults to *pkg_import*) if missing."""
    import importlib
    try:
        return importlib.import_module(pkg_import)
    except ImportError:
        pass
    pip_name = pkg_pip or pkg_import
    print(f"[Setup] '{pip_name}' not found — installing…", flush=True)
    # Try several pip invocations in order of preference
    attempts = [
        [sys.executable, '-m', 'pip', 'install', pip_name, '--quiet'],
        [sys.executable, '-m', 'pip', 'install', pip_name, '--user', '--quiet'],
        ['pip3', 'install', pip_name, '--quiet'],
    ]
    for cmd in attempts:
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=180, text=True)
            if result.returncode == 0:
                importlib.invalidate_caches()
                mod = importlib.import_module(pkg_import)
                print(f"[Setup] '{pip_name}' installed OK.", flush=True)
                return mod
        except Exception:
            pass
    raise ImportError(
        f"Could not install '{pip_name}'. "
        f"Please run manually:  pip3 install {pip_name}"
    )


# Ensure matplotlib is available (auto-install on first run if missing)
_ensure_package('matplotlib')

# ─── Contour tracing (marching squares) ─────────────────────────────────────

def trace_contours_matplotlib(grid, x_min, y_min, res_x, res_y, levels):
    """Use matplotlib's contour to trace isolines. Returns list of (level, [polylines])."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.path import Path

    rows, cols = grid.shape
    # Create coordinate arrays
    x_coords = x_min + np.arange(cols) * res_x + res_x / 2
    y_coords = y_min + np.arange(rows) * res_y + res_y / 2

    X, Y = np.meshgrid(x_coords, y_coords)

    # Fill NaN with interpolated values for contour (contour doesn't handle NaN well)
    grid_filled = grid.copy()
    nan_mask = ~np.isfinite(grid_filled)
    if nan_mask.any():
        # Simple fill: replace NaN with mean of valid neighbors
        valid_mean = np.nanmean(grid_filled)
        grid_filled[nan_mask] = valid_mean

    fig, ax = plt.subplots(1, 1, figsize=(1, 1))
    cs = ax.contour(X, Y, grid_filled, levels=levels)
    plt.close(fig)

    results = []
    for i, level in enumerate(cs.levels):
        polylines = []
        if i < len(cs.allsegs):
            for seg in cs.allsegs[i]:
                if len(seg) >= 2:
                    polylines.append(seg.tolist())
        results.append((float(level), polylines))

    return results


def contours_to_geojson(contour_data, output_path, crs_wkt=None):
    """Write contour lines to GeoJSON."""
    features = []
    total_lines = 0

    for level, polylines in contour_data:
        for poly in polylines:
            if len(poly) < 2:
                continue
            # GeoJSON LineString: coordinates are [x, y, z] with z = elevation
            coords = [[pt[0], pt[1], level] for pt in poly]
            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords
                },
                "properties": {
                    "elevation": round(level, 4),
                    "elevation_label": f"{level:.2f}m"
                }
            }
            features.append(feature)
            total_lines += 1

    fc = {
        "type": "FeatureCollection",
        "features": features
    }

    if crs_wkt:
        # GeoJSON with named CRS (older spec, but widely supported)
        fc["crs"] = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, separators=(',', ':'))

    return total_lines


def contours_to_dxf(contour_data, output_path, units='m'):
    """Write contour lines to a minimal DXF R2000 file (ASCII, no ezdxf needed)."""

    lines = []

    # DXF header
    lines += [
        '  0', 'SECTION',
        '  2', 'HEADER',
        '  9', '$ACADVER',
        '  1', 'AC1015',  # R2000
        '  9', '$INSUNITS',
        ' 70', '6' if units == 'm' else '1',  # 6=meters, 1=inches
        '  9', '$LUNITS',
        ' 70', '2',  # Decimal
        '  0', 'ENDSEC',
    ]

    # Tables section (minimal)
    lines += [
        '  0', 'SECTION',
        '  2', 'TABLES',
        '  0', 'TABLE',
        '  2', 'LAYER',
        ' 70', str(max(1, len(set(round(lv, 2) for lv, _ in contour_data)) + 1)),
        # Layer 0
        '  0', 'LAYER',
        '  2', '0',
        ' 70', '0',
        ' 62', '7',
        '  6', 'CONTINUOUS',
        # Contours layer
        '  0', 'LAYER',
        '  2', 'CONTOURS',
        ' 70', '0',
        ' 62', '3',  # green
        '  6', 'CONTINUOUS',
        '  0', 'ENDTAB',
        '  0', 'ENDSEC',
    ]

    # Entities
    lines += [
        '  0', 'SECTION',
        '  2', 'ENTITIES',
    ]

    total_lines = 0
    for level, polylines in contour_data:
        for poly in polylines:
            if len(poly) < 2:
                continue
            total_lines += 1
            # LWPOLYLINE entity
            lines += [
                '  0', 'LWPOLYLINE',
                '  8', 'CONTOURS',   # layer
                ' 38', f'{level:.4f}',  # elevation
                ' 62', '3',          # color green
                ' 70', '0',          # flags (open polyline)
                ' 90', str(len(poly)),  # vertex count
            ]
            for pt in poly:
                lines += [
                    ' 10', f'{pt[0]:.4f}',
                    ' 20', f'{pt[1]:.4f}',
                ]

    lines += [
        '  0', 'ENDSEC',
        '  0', 'EOF',
    ]

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
        f.write('\n')

    return total_lines


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 4:
        print(json.dumps({'error': 'Usage: generate_contours.py <dtm_dir> <output_dir> <interval> [formats]'}))
        sys.exit(1)

    dtm_dir = sys.argv[1]
    output_dir = sys.argv[2]
    interval = float(sys.argv[3])
    formats = sys.argv[4].split(',') if len(sys.argv) > 4 else ['geojson', 'dxf']

    os.makedirs(output_dir, exist_ok=True)

    try:
        # Load DTM grid and metadata
        grid_path = os.path.join(dtm_dir, 'grid.npy')
        meta_path = os.path.join(dtm_dir, 'meta.json')

        if not os.path.exists(grid_path):
            raise FileNotFoundError(f"Grid file not found: {grid_path}")
        if not os.path.exists(meta_path):
            raise FileNotFoundError(f"Meta file not found: {meta_path}")

        grid = np.load(grid_path)
        with open(meta_path) as f:
            meta = json.load(f)

        x_min = meta['xMin']
        y_min = meta['yMin']
        res_x = meta['resolutionX']
        res_y = meta['resolutionY']
        z_min = meta['zMin']
        z_max = meta['zMax']

        print(f"[Contour] Grid: {grid.shape}, Z: {z_min:.2f}~{z_max:.2f}m, interval: {interval}m", flush=True)

        # Compute contour levels
        level_min = math.ceil(z_min / interval) * interval
        level_max = math.floor(z_max / interval) * interval
        levels = []
        lv = level_min
        while lv <= level_max + 1e-9:
            levels.append(round(lv, 6))
            lv += interval

        if len(levels) == 0:
            raise ValueError(f"No contour levels in range {z_min:.2f}~{z_max:.2f} with interval {interval}")

        max_levels = 500
        if len(levels) > max_levels:
            print(f"[Contour] Too many levels ({len(levels)}), decimating to {max_levels}", flush=True)
            step = math.ceil(len(levels) / max_levels)
            levels = levels[::step]

        print(f"[Contour] {len(levels)} levels from {levels[0]:.2f} to {levels[-1]:.2f}", flush=True)

        # Trace contours using matplotlib
        contour_data = trace_contours_matplotlib(grid, x_min, y_min, res_x, res_y, levels)

        # Count total lines
        total_segments = sum(len(polys) for _, polys in contour_data)
        print(f"[Contour] {total_segments} polyline segments", flush=True)

        # Write outputs
        has_geojson = False
        has_dxf = False

        if 'geojson' in formats:
            geojson_path = os.path.join(output_dir, 'contours.geojson')
            n = contours_to_geojson(contour_data, geojson_path)
            print(f"[Contour] GeoJSON: {n} features -> {geojson_path}", flush=True)
            has_geojson = True

        if 'dxf' in formats:
            dxf_path = os.path.join(output_dir, 'contours.dxf')
            n = contours_to_dxf(contour_data, dxf_path)
            print(f"[Contour] DXF: {n} polylines -> {dxf_path}", flush=True)
            has_dxf = True

        # Save metadata
        contour_meta = {
            'interval': interval,
            'levels': len(levels),
            'zMin': z_min,
            'zMax': z_max,
            'segments': total_segments,
            'formats': formats,
            'geojsonPath': os.path.join(output_dir, 'contours.geojson') if has_geojson else None,
            'dxfPath': os.path.join(output_dir, 'contours.dxf') if has_dxf else None,
        }
        with open(os.path.join(output_dir, 'contour_meta.json'), 'w') as f:
            json.dump(contour_meta, f, indent=2)

        result = {
            'ok': True,
            'contourCount': total_segments,
            'levelCount': len(levels),
            'zMin': z_min,
            'zMax': z_max,
            'hasGeoJSON': has_geojson,
            'hasDxf': has_dxf,
        }
        print('RESULT:' + json.dumps(result), flush=True)

    except Exception as e:
        err = {'error': str(e), 'traceback': traceback.format_exc()}
        print('RESULT:' + json.dumps(err), flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
