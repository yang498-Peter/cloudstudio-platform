#!/usr/bin/env python3
"""
generate_dtm.py — Pure-Python DTM/DSM generator (no PDAL/GDAL required)

Usage:
    python3 generate_dtm.py <las_path> <output_dir> <dtm_type> <resolution>

Arguments:
    las_path   - Path to input LAS/LAZ file
    output_dir - Directory to write outputs (preview.png, dtm.tif metadata, grid.npy)
    dtm_type   - 'dtm' (ground points only, class 2) or 'dsm' (all points)
    resolution - Grid cell size in meters (e.g. 0.5)

Outputs:
    <output_dir>/preview.png     - Colored elevation map for web display
    <output_dir>/grid.npy        - Raw elevation grid (numpy float32)
    <output_dir>/meta.json       - Metadata: bbox, resolution, crs hint, stats
"""

import sys, os, struct, json, math, traceback, subprocess
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
    # Don't raise — caller will handle via the pure-Python fallback
    print(f"[Setup] Auto-install of '{pip_name}' failed; will use built-in fallback.", flush=True)
    return None


# Try to ensure matplotlib is available; if it fails the preview uses the pure-Python fallback
_ensure_package('matplotlib')

# ─── Minimal LAS reader (no laspy) ─────────────────────────────────────────

LAS_PDRF_FIELDS = {
    # Point Data Record Format -> (x_offset, y_offset, z_offset, classification_offset, record_length)
    # Each entry: list of (name, type_char, size_bytes)
    0: [('x','i',4),('y','i',4),('z','i',4),('intensity','H',2),('flags','B',1),
        ('classification','B',1),('scan_angle','b',1),('user_data','B',1),('point_src','H',2)],
    1: [('x','i',4),('y','i',4),('z','i',4),('intensity','H',2),('flags','B',1),
        ('classification','B',1),('scan_angle','b',1),('user_data','B',1),('point_src','H',2),
        ('gps_time','d',8)],
    2: [('x','i',4),('y','i',4),('z','i',4),('intensity','H',2),('flags','B',1),
        ('classification','B',1),('scan_angle','b',1),('user_data','B',1),('point_src','H',2),
        ('red','H',2),('green','H',2),('blue','H',2)],
    3: [('x','i',4),('y','i',4),('z','i',4),('intensity','H',2),('flags','B',1),
        ('classification','B',1),('scan_angle','b',1),('user_data','B',1),('point_src','H',2),
        ('gps_time','d',8),('red','H',2),('green','H',2),('blue','H',2)],
    6: [('x','i',4),('y','i',4),('z','i',4),('intensity','H',2),('flags','B',1),
        ('flags2','B',1),('classification','B',1),('user_data','B',1),
        ('scan_angle','h',2),('point_src','H',2),('gps_time','d',8)],
    7: [('x','i',4),('y','i',4),('z','i',4),('intensity','H',2),('flags','B',1),
        ('flags2','B',1),('classification','B',1),('user_data','B',1),
        ('scan_angle','h',2),('point_src','H',2),('gps_time','d',8),
        ('red','H',2),('green','H',2),('blue','H',2)],
}

def read_las(path):
    """Read LAS 1.x/2.x file, return dict with arrays: x, y, z, classification."""
    with open(path, 'rb') as f:
        # Public header block
        sig = f.read(4)
        if sig != b'LASF':
            raise ValueError(f"Not a LAS file (signature={sig})")

        f.seek(24)
        major = struct.unpack('B', f.read(1))[0]
        minor = struct.unpack('B', f.read(1))[0]

        f.seek(94)
        header_size = struct.unpack('H', f.read(2))[0]
        offset_to_data = struct.unpack('I', f.read(4))[0]

        # Offset 104: Point Data Format ID (1 byte)
        # Offset 105: Point Data Record Length (2 bytes)
        # NOTE: NOT 99 — bytes 99-103 are the tail of offset_to_data + Number of VLRs
        f.seek(104)
        pdrf = struct.unpack('B', f.read(1))[0]
        point_len = struct.unpack('H', f.read(2))[0]

        # Point count (LAS 1.4 uses 64-bit at offset 247)
        if major == 1 and minor >= 4:
            f.seek(247)
            point_count = struct.unpack('Q', f.read(8))[0]
        else:
            f.seek(107)
            point_count = struct.unpack('I', f.read(4))[0]

        # Scale and offset
        f.seek(131)
        sx, sy, sz = struct.unpack('ddd', f.read(24))
        ox, oy, oz = struct.unpack('ddd', f.read(24))

        if point_count == 0:
            raise ValueError("LAS file has 0 points")

        # Build field layout for this PDRF
        fields = LAS_PDRF_FIELDS.get(pdrf, LAS_PDRF_FIELDS[0])
        fmt = '<' + ''.join(f[1] for f in fields)
        fmt_size = struct.calcsize(fmt)

        # Find offsets of x, y, z, classification in the struct
        field_names = [f[0] for f in fields]
        # Compute byte offsets
        offsets = {}
        off = 0
        for nm, tc, sz_b in fields:
            offsets[nm] = off
            off += sz_b

        # Read all points as raw bytes
        f.seek(offset_to_data)
        raw = f.read(point_count * point_len)

        actual_points = len(raw) // point_len
        if actual_points < point_count:
            point_count = actual_points

        print(f"[LAS] {point_count:,} points, PDRF={pdrf}, scale=({sx},{sy},{sz})", flush=True)

        # Unpack x, y, z, classification efficiently
        # x,y,z are int32 at known offsets
        xi_off = offsets.get('x', 0)
        yi_off = offsets.get('y', 4)
        zi_off = offsets.get('z', 8)
        cls_off = offsets.get('classification', 15 if pdrf < 6 else 16)

        xs = np.zeros(point_count, dtype=np.int32)
        ys = np.zeros(point_count, dtype=np.int32)
        zs = np.zeros(point_count, dtype=np.int32)
        cls = np.zeros(point_count, dtype=np.uint8)

        # Parse in chunks for memory efficiency
        chunk = 200000
        for start in range(0, point_count, chunk):
            end = min(start + chunk, point_count)
            n = end - start
            chunk_raw = raw[start * point_len : end * point_len]
            for i in range(n):
                base = i * point_len
                xs[start + i] = struct.unpack_from('<i', chunk_raw, base + xi_off)[0]
                ys[start + i] = struct.unpack_from('<i', chunk_raw, base + yi_off)[0]
                zs[start + i] = struct.unpack_from('<i', chunk_raw, base + zi_off)[0]
                cls[start + i] = struct.unpack_from('<B', chunk_raw, base + cls_off)[0]

        # Apply scale/offset
        x = xs * sx + ox
        y = ys * sy + oy
        z = zs * sz + oz

        return {'x': x, 'y': y, 'z': z, 'classification': cls,
                'scale': (sx, sy, sz), 'offset': (ox, oy, oz)}


def read_las_fast(path):
    """Faster LAS reader using numpy fromfile for standard PDRFs."""
    with open(path, 'rb') as f:
        sig = f.read(4)
        if sig != b'LASF':
            raise ValueError(f"Not a LAS file")

        f.seek(24)
        major = struct.unpack('B', f.read(1))[0]
        minor = struct.unpack('B', f.read(1))[0]

        f.seek(94)
        header_size = struct.unpack('H', f.read(2))[0]
        offset_to_data = struct.unpack('I', f.read(4))[0]

        # LAS spec: offset 104 = Point Data Format ID, 105-106 = Record Length
        f.seek(104)
        pdrf = struct.unpack('B', f.read(1))[0]
        point_len = struct.unpack('H', f.read(2))[0]

        if major == 1 and minor >= 4:
            f.seek(247)
            point_count = struct.unpack('Q', f.read(8))[0]
        else:
            f.seek(107)
            point_count = struct.unpack('I', f.read(4))[0]

        f.seek(131)
        sx, sy, sz = struct.unpack('ddd', f.read(24))
        ox, oy, oz = struct.unpack('ddd', f.read(24))

        # Point counts from file size
        f.seek(0, 2)
        file_size = f.tell()
        available = (file_size - offset_to_data) // point_len
        if available < point_count:
            point_count = available

        print(f"[LAS] {point_count:,} pts, PDRF={pdrf}, len={point_len}B, scale=({sx:.4g},{sy:.4g},{sz:.4g})", flush=True)

        # PDRF 0-5: classification at byte 15, x/y/z at 0/4/8
        # PDRF 6-10: classification at byte 16, x/y/z at 0/4/8
        cls_byte = 15 if pdrf < 6 else 16

        # Read raw bytes
        f.seek(offset_to_data)
        data = np.frombuffer(f.read(point_count * point_len), dtype=np.uint8)
        data = data.reshape(point_count, point_len)

        xi = np.frombuffer(data[:, 0:4].tobytes(), dtype=np.int32)
        yi = np.frombuffer(data[:, 4:8].tobytes(), dtype=np.int32)
        zi = np.frombuffer(data[:, 8:12].tobytes(), dtype=np.int32)
        cls = data[:, cls_byte].copy()

        x = xi * sx + ox
        y = yi * sy + oy
        z = zi * sz + oz

        return {'x': x, 'y': y, 'z': z, 'classification': cls,
                'scale': (sx, sy, sz), 'offset': (ox, oy, oz),
                'point_count': point_count}


def make_elevation_grid(x, y, z, resolution, method='max'):
    """Create a regular grid of elevation values from point cloud."""
    x_min, x_max = x.min(), x.max()
    y_min, y_max = y.min(), y.max()

    cols = max(2, int(math.ceil((x_max - x_min) / resolution)) + 1)
    rows = max(2, int(math.ceil((y_max - y_min) / resolution)) + 1)

    # Cap grid size for memory safety
    if cols * rows > 20_000_000:
        scale_factor = math.sqrt(20_000_000 / (cols * rows))
        cols = max(2, int(cols * scale_factor))
        rows = max(2, int(rows * scale_factor))
        resolution_x = (x_max - x_min) / (cols - 1)
        resolution_y = (y_max - y_min) / (rows - 1)
        print(f"[DTM] Grid capped: {cols}x{rows}, res_x={resolution_x:.3f}m, res_y={resolution_y:.3f}m", flush=True)
    else:
        resolution_x = resolution
        resolution_y = resolution

    print(f"[DTM] Grid: {cols}x{rows} ({cols*rows:,} cells)", flush=True)

    # Bin points to grid cells
    col_idx = np.clip(((x - x_min) / resolution_x).astype(np.int32), 0, cols - 1)
    row_idx = np.clip(((y - y_min) / resolution_y).astype(np.int32), 0, rows - 1)

    grid = np.full((rows, cols), np.nan, dtype=np.float32)
    cell_idx = row_idx * cols + col_idx

    # Use bincount-based approach for speed
    valid_mask = np.isfinite(z)
    z_valid = z[valid_mask].astype(np.float32)
    ci = cell_idx[valid_mask]

    if method == 'max':
        # For DSM, use max elevation
        order = np.argsort(ci)
        ci_sorted = ci[order]
        z_sorted = z_valid[order]
        unique_ci, first_idx = np.unique(ci_sorted, return_index=True)
        # For each unique cell, take the max
        last_idx = np.concatenate([first_idx[1:], [len(ci_sorted)]])
        for i, (ci_val, fi, li) in enumerate(zip(unique_ci, first_idx, last_idx)):
            row_c = ci_val // cols
            col_c = ci_val % cols
            grid[row_c, col_c] = np.max(z_sorted[fi:li])
    else:
        # For DTM, use min elevation (ground)
        order = np.argsort(ci)
        ci_sorted = ci[order]
        z_sorted = z_valid[order]
        unique_ci, first_idx = np.unique(ci_sorted, return_index=True)
        last_idx = np.concatenate([first_idx[1:], [len(ci_sorted)]])
        for i, (ci_val, fi, li) in enumerate(zip(unique_ci, first_idx, last_idx)):
            row_c = ci_val // cols
            col_c = ci_val % cols
            grid[row_c, col_c] = np.min(z_sorted[fi:li])

    return grid, x_min, y_min, resolution_x, resolution_y


def _save_preview_png_pure(grid, output_path, z_min, z_max):
    """
    Pure Python + numpy PNG writer — no matplotlib required.
    Uses a terrain-like colormap implemented via numpy vectorised ops.
    Output is a valid RGB PNG readable by all browsers.
    """
    import zlib

    grid_display = np.flipud(grid)
    rows, cols = grid_display.shape

    # Normalise to [0, 1]; mark nodata as -1
    span = z_max - z_min if z_max > z_min else 1.0
    norm_grid = np.where(
        np.isfinite(grid_display),
        np.clip((grid_display.astype(np.float32) - z_min) / span, 0.0, 1.0),
        -1.0,
    ).astype(np.float32)

    # Terrain colormap: (stop, R, G, B)  — approximates matplotlib 'terrain'
    STOPS  = np.array([0.00, 0.15, 0.25, 0.40, 0.60, 0.75, 0.90, 1.00], dtype=np.float32)
    COLORS = np.array([
        [ 20,  60, 120],  # deep blue
        [ 50, 130, 200],  # blue
        [ 60, 160,  80],  # green
        [120, 190,  50],  # lime
        [210, 195,  90],  # tan
        [160, 105,  55],  # brown
        [200, 185, 165],  # light tan
        [255, 255, 255],  # white/snow
    ], dtype=np.float32)

    t   = np.where(norm_grid >= 0, norm_grid, 0.0)
    seg = np.searchsorted(STOPS[1:], t, side='left').astype(np.int32)
    seg = np.clip(seg, 0, len(STOPS) - 2)

    t0   = STOPS[seg]                      # (rows, cols)
    t1   = STOPS[seg + 1]
    frac = np.where(t1 > t0, (t - t0) / (t1 - t0), 0.0)[:, :, np.newaxis]

    rgb = np.clip(COLORS[seg] + frac * (COLORS[seg + 1] - COLORS[seg]), 0, 255).astype(np.uint8)
    rgb[norm_grid < 0] = [20, 20, 40]     # nodata → dark background

    # Encode as PNG:  prepend a filter-type-0 byte to each row, then zlib-compress
    filter_col  = np.zeros((rows, 1), dtype=np.uint8)
    scanlines   = np.concatenate([filter_col, rgb.reshape(rows, cols * 3)], axis=1)
    compressed  = zlib.compress(scanlines.tobytes(), 6)

    def _chunk(tag: bytes, payload: bytes) -> bytes:
        import zlib as _zlib
        crc = _zlib.crc32(tag + payload) & 0xFFFFFFFF
        return struct.pack('>I', len(payload)) + tag + payload + struct.pack('>I', crc)

    ihdr = struct.pack('>IIBBBBB', cols, rows, 8, 2, 0, 0, 0)  # RGB, 8-bit

    with open(output_path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(_chunk(b'IHDR', ihdr))
        f.write(_chunk(b'IDAT', compressed))
        f.write(_chunk(b'IEND', b''))

    print(f"[DTM] Preview saved (pure-Python PNG): {output_path}", flush=True)


def save_preview_png(grid, output_path, colormap='terrain'):
    """Save coloured elevation image as PNG.

    Tries matplotlib first for a polished output with a colour-bar.
    Falls back to a pure-Python + numpy PNG writer if matplotlib is not installed.
    """
    grid_display = np.flipud(grid)
    z_valid = grid_display[np.isfinite(grid_display)]
    if len(z_valid) == 0:
        raise ValueError("Grid is empty (no valid elevation values)")

    z_min = float(np.percentile(z_valid, 2))
    z_max = float(np.percentile(z_valid, 98))
    if z_max <= z_min:
        z_max = z_min + 1.0

    # ── Try matplotlib (richer output with colour-bar) ──────────────────────
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import matplotlib.colors as mcolors

        fig, ax = plt.subplots(figsize=(6, 6), dpi=100)
        fig.patch.set_facecolor('#000000')
        ax.set_facecolor('#1a1a2e')

        cmap = plt.get_cmap(colormap)
        norm = mcolors.Normalize(vmin=z_min, vmax=z_max)
        im   = ax.imshow(grid_display, cmap=cmap, norm=norm, aspect='auto',
                         interpolation='nearest')

        cbar = plt.colorbar(im, ax=ax, fraction=0.035, pad=0.02)
        cbar.set_label('Elevation (m)', color='white', fontsize=9)
        cbar.ax.yaxis.set_tick_params(color='white')
        plt.setp(cbar.ax.yaxis.get_ticklabels(), color='white', fontsize=8)

        ax.set_xticks([])
        ax.set_yticks([])
        ax.set_title(f'Elevation Model\nZ: {z_min:.2f}~{z_max:.2f} m',
                     color='white', fontsize=9, pad=4)
        for spine in ax.spines.values():
            spine.set_edgecolor('#333')

        plt.tight_layout(pad=0.5)
        plt.savefig(output_path, dpi=100, bbox_inches='tight',
                    facecolor='#000000', edgecolor='none')
        plt.close()
        print(f"[DTM] Preview saved (matplotlib): {output_path}", flush=True)
        return

    except ImportError:
        print("[DTM] matplotlib not found — using pure-Python PNG fallback", flush=True)
    except Exception as e:
        print(f"[DTM] matplotlib error ({e}) — using pure-Python PNG fallback", flush=True)

    # ── Pure-Python fallback ─────────────────────────────────────────────────
    _save_preview_png_pure(grid, output_path, z_min, z_max)


def write_geotiff_world_file(path, x_min, y_min, res_x, res_y, rows, cols):
    """Write a .tfw world file (simple georeference sidecar for PNG/TIF)."""
    # .tfw format: 6 lines
    # Line 1: pixel size X
    # Line 2: rotation about Y (0)
    # Line 3: rotation about X (0)
    # Line 4: pixel size Y (negative = north-up)
    # Line 5: X coord upper-left pixel center
    # Line 6: Y coord upper-left pixel center
    y_max = y_min + rows * res_y
    with open(path, 'w') as f:
        f.write(f"{res_x:.6f}\n")
        f.write("0.000000\n")
        f.write("0.000000\n")
        f.write(f"-{res_y:.6f}\n")
        f.write(f"{x_min:.6f}\n")
        f.write(f"{y_max:.6f}\n")


def save_minimal_geotiff(grid, x_min, y_min, res_x, res_y, output_path):
    """
    Save elevation grid as a minimal GeoTIFF without GDAL.
    Uses libtiff-compatible TIFF with GeoTIFF tags embedded as raw bytes.
    Falls back to numpy .npy + world file if anything fails.
    """
    rows, cols = grid.shape
    z_min = float(np.nanmin(grid))
    z_max = float(np.nanmax(grid))

    # Replace NaN with nodata value
    nodata = -9999.0
    grid_out = np.where(np.isfinite(grid), grid, nodata).astype(np.float32)

    # Try to write minimal TIFF using struct
    try:
        _write_tiff_float32(grid_out, x_min, y_min, res_x, res_y, output_path)
        print(f"[DTM] GeoTIFF saved: {output_path}", flush=True)
    except Exception as e:
        print(f"[DTM] GeoTIFF write failed ({e}), saving .npy instead", flush=True)
        np_path = output_path.replace('.tif', '.npy')
        np.save(np_path, grid_out)
        # Write world file
        wf_path = output_path.replace('.tif', '.tfw')
        write_geotiff_world_file(wf_path, x_min, y_min, res_x, res_y, rows, cols)
        return np_path

    return output_path


def _write_tiff_float32(grid, x_min, y_min, res_x, res_y, path):
    """Write a Float32 GeoTIFF using raw struct (minimal TIFF format)."""
    rows, cols = grid.shape
    nodata = -9999.0

    # TIFF IFD tags
    # We write a stripped TIFF with:
    # - Single strip (for simplicity, max ~50MB)
    # - Float32 samples
    # - GeoTIFF ModelPixelScaleTag + ModelTiepointTag

    image_data = grid.astype('<f4').tobytes()  # Little-endian float32

    # TIFF header: II (little endian), magic 42, offset to first IFD
    header = struct.pack('<HHI', 0x4949, 42, 8)

    # Tags to write (sorted by tag number):
    # 256 = ImageWidth (cols), 257 = ImageLength (rows)
    # 258 = BitsPerSample (32)
    # 259 = Compression (1=none)
    # 262 = PhotometricInterpretation (1=BlackIsZero)
    # 278 = RowsPerStrip (rows = single strip)
    # 279 = StripByteCounts (len of image data)
    # 284 = PlanarConfiguration (1=chunky)
    # 339 = SampleFormat (3=IEEE float)
    # 34736 = GeoDoubleParamsTag (ModelPixelScaleTag needs doubles)
    # 34737 = GeoAsciiParamsTag

    # GeoTIFF ModelPixelScaleTag (34264): 3 doubles (ScaleX, ScaleY, ScaleZ)
    # GeoTIFF ModelTiepointTag (33922): 6 doubles (I,J,K,X,Y,Z)
    # GeoTIFF GeoKeyDirectoryTag (34735): array of uint16 (optional, skip for simplicity)

    # We'll compute strip offset after header + IFD
    n_tags = 13
    ifd_size = 2 + n_tags * 12 + 4  # count + tags + next_ifd_offset

    # Extra data after IFD: pixel scale (24 bytes) + tiepoint (48 bytes)
    pixel_scale_data = struct.pack('<ddd', res_x, res_y, 0.0)  # 24 bytes
    # Tiepoint: (col_px, row_px, 0, X_geo, Y_geo, 0)
    y_max = y_min + rows * res_y
    tiepoint_data = struct.pack('<dddddd', 0.0, 0.0, 0.0, x_min, y_max, 0.0)  # 48 bytes

    ifd_offset = 8  # right after header
    extra_data_offset = ifd_offset + ifd_size
    pixel_scale_offset = extra_data_offset
    tiepoint_offset = pixel_scale_offset + 24
    strip_offset = tiepoint_offset + 48

    # Build IFD
    def tag(tag_id, type_id, count, value_or_offset):
        return struct.pack('<HHII', tag_id, type_id, count, value_or_offset)

    # Type IDs: 3=SHORT, 4=LONG, 12=DOUBLE
    ifd_tags = []
    ifd_tags.append(tag(256, 4, 1, cols))           # ImageWidth
    ifd_tags.append(tag(257, 4, 1, rows))           # ImageLength
    ifd_tags.append(tag(258, 3, 1, 32))             # BitsPerSample
    ifd_tags.append(tag(259, 3, 1, 1))              # Compression=None
    ifd_tags.append(tag(262, 3, 1, 1))              # PhotometricInterp=BlackIsZero
    ifd_tags.append(tag(273, 4, 1, strip_offset))   # StripOffsets
    ifd_tags.append(tag(277, 3, 1, 1))              # SamplesPerPixel=1
    ifd_tags.append(tag(278, 4, 1, rows))           # RowsPerStrip=all
    ifd_tags.append(tag(279, 4, 1, len(image_data)))# StripByteCounts
    ifd_tags.append(tag(284, 3, 1, 1))              # PlanarConfig=1
    ifd_tags.append(tag(339, 3, 1, 3))              # SampleFormat=3 (IEEE float)
    # GeoTIFF tags
    ifd_tags.append(tag(33922, 12, 6, tiepoint_offset))    # ModelTiepointTag (6 doubles)
    ifd_tags.append(tag(34264, 12, 3, pixel_scale_offset)) # ModelPixelScaleTag (3 doubles)
    # GeoKeyDirectoryTag: minimal - just WGS84 geographic (EPSG:4326)
    # 34735 tag: [KeyDirectoryVersion,KeyRevision,MinorRevision,NumberOfKeys, key1...]
    # We'll skip it since the TFW file handles registration

    # Sort tags by tag ID (required by TIFF spec)
    ifd_tags.sort(key=lambda b: struct.unpack('<H', b[:2])[0])

    assert len(ifd_tags) == n_tags, f"Expected {n_tags} tags, got {len(ifd_tags)}"

    ifd = struct.pack('<H', n_tags)
    for t in ifd_tags:
        ifd += t
    ifd += struct.pack('<I', 0)  # next IFD offset = 0 (no more IFDs)

    with open(path, 'wb') as f:
        f.write(header)
        f.write(ifd)
        f.write(pixel_scale_data)
        f.write(tiepoint_data)
        f.write(image_data)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 5:
        print(json.dumps({'error': 'Usage: generate_dtm.py <las_path> <output_dir> <dtm_type> <resolution>'}))
        sys.exit(1)

    las_path = sys.argv[1]
    output_dir = sys.argv[2]
    dtm_type = sys.argv[3].lower()  # 'dtm' or 'dsm'
    resolution = float(sys.argv[4])

    os.makedirs(output_dir, exist_ok=True)

    try:
        # Read LAS file
        print(f"[DTM] Reading: {las_path}", flush=True)
        data = read_las_fast(las_path)
        x, y, z = data['x'], data['y'], data['z']
        cls = data['classification']
        n_total = len(x)
        print(f"[DTM] Total points: {n_total:,}", flush=True)

        # Filter by classification for DTM
        if dtm_type == 'dtm':
            # Class 2 = Ground in LAS standard
            ground_mask = (cls == 2)
            n_ground = ground_mask.sum()
            print(f"[DTM] Ground points (class 2): {n_ground:,}", flush=True)
            if n_ground < 100:
                print(f"[DTM] Too few ground points, using all points", flush=True)
                ground_mask = np.ones(n_total, dtype=bool)
            x, y, z = x[ground_mask], y[ground_mask], z[ground_mask]
            grid_method = 'min'  # Ground = lowest point in cell
        else:
            # DSM: use all points
            grid_method = 'max'  # Surface = highest point in cell

        n_pts = len(x)
        print(f"[DTM] Using {n_pts:,} points for gridding", flush=True)

        # Make elevation grid
        grid, x_min, y_min, res_x, res_y = make_elevation_grid(x, y, z, resolution, method=grid_method)
        rows, cols = grid.shape

        # Stats
        valid = grid[np.isfinite(grid)]
        z_min_v = float(np.nanmin(valid)) if len(valid) > 0 else 0.0
        z_max_v = float(np.nanmax(valid)) if len(valid) > 0 else 0.0
        z_mean = float(np.nanmean(valid)) if len(valid) > 0 else 0.0
        coverage = float(len(valid)) / (rows * cols) * 100.0

        # Save numpy grid
        np.save(os.path.join(output_dir, 'grid.npy'), grid.astype(np.float32))

        # Save preview PNG
        preview_path = os.path.join(output_dir, 'preview.png')
        cmap_name = 'terrain' if dtm_type == 'dtm' else 'plasma'
        save_preview_png(grid, preview_path, colormap=cmap_name)

        # Save GeoTIFF
        tif_path = os.path.join(output_dir, 'dtm.tif')
        actual_tif = save_minimal_geotiff(grid, x_min, y_min, res_x, res_y, tif_path)

        # Write world file for PNG too
        tfw_path = os.path.join(output_dir, 'preview.tfw')
        write_geotiff_world_file(tfw_path, x_min, y_min, res_x, res_y, rows, cols)

        # Save metadata
        meta = {
            'dtmType': dtm_type,
            'resolution': resolution,
            'resolutionX': res_x,
            'resolutionY': res_y,
            'xMin': x_min,
            'yMin': y_min,
            'xMax': x_min + cols * res_x,
            'yMax': y_min + rows * res_y,
            'rows': rows,
            'cols': cols,
            'zMin': z_min_v,
            'zMax': z_max_v,
            'zMean': z_mean,
            'coverage': coverage,
            'pointsUsed': int(n_pts),
            'pointsTotal': int(n_total),
            'geotiffPath': actual_tif,
            'gridPath': os.path.join(output_dir, 'grid.npy'),
            'previewPath': preview_path,
        }
        with open(os.path.join(output_dir, 'meta.json'), 'w') as f:
            json.dump(meta, f, indent=2)

        # Output result to stdout
        result = {
            'ok': True,
            'stats': {
                'width': cols * res_x,
                'height': rows * res_y,
                'rows': rows,
                'cols': cols,
                'zMin': z_min_v,
                'zMax': z_max_v,
                'zMean': z_mean,
                'coverage': coverage,
                'points': int(n_pts),
            },
        }
        print('RESULT:' + json.dumps(result), flush=True)

    except Exception as e:
        err = {'error': str(e), 'traceback': traceback.format_exc()}
        print('RESULT:' + json.dumps(err), flush=True)
        sys.exit(1)


if __name__ == '__main__':
    main()
