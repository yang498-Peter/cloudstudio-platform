#!/usr/bin/env python3
import argparse
import json
import math
from pathlib import Path

import numpy as np


def rotation_matrix(theta):
    c = math.cos(theta)
    s = math.sin(theta)
    return np.array([[c, -s], [s, c]], dtype=np.float64)


def collect_slice_points(las_path, z_center, thickness, chunk_size=500_000):
    import laspy

    lower = z_center - thickness * 0.5
    upper = z_center + thickness * 0.5
    chunks = []
    with laspy.open(las_path) as reader:
        for chunk in reader.chunk_iterator(chunk_size):
            mask = (chunk.z >= lower) & (chunk.z <= upper)
            if not np.any(mask):
                continue
            chunks.append(np.column_stack((chunk.x[mask], chunk.y[mask], chunk.z[mask])))
    if not chunks:
        return np.empty((0, 3), dtype=np.float64)
    return np.vstack(chunks)


def align_xy(points_xy, auto_align):
    centroid = points_xy.mean(axis=0)
    centered = points_xy - centroid
    if not auto_align or len(points_xy) < 3:
        return centered, centroid, 0.0
    cov = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    principal = eigenvectors[:, np.argmax(eigenvalues)]
    theta = math.atan2(principal[1], principal[0])
    c = math.cos(-theta)
    s = math.sin(-theta)
    aligned = np.column_stack((
        centered[:, 0] * c - centered[:, 1] * s,
        centered[:, 0] * s + centered[:, 1] * c,
    ))
    return aligned, centroid, theta


def rasterize(points_xy, cell_size):
    min_xy = points_xy.min(axis=0)
    max_xy = points_xy.max(axis=0)
    span = np.maximum(max_xy - min_xy, cell_size)
    width = max(16, int(math.ceil(span[0] / cell_size)) + 3)
    height = max(16, int(math.ceil(span[1] / cell_size)) + 3)
    xi = np.clip(((points_xy[:, 0] - min_xy[0]) / cell_size).astype(int), 0, width - 1)
    yi = np.clip(((points_xy[:, 1] - min_xy[1]) / cell_size).astype(int), 0, height - 1)
    density = np.zeros((width, height), dtype=np.float32)
    np.add.at(density, (xi, yi), 1)
    return density, min_xy, max_xy


def merge_positions(raw_positions, min_separation):
    raw_positions = list(raw_positions)
    if len(raw_positions) == 0:
        return []
    raw_positions = sorted(float(v) for v in raw_positions)
    merged = [[raw_positions[0]]]
    for value in raw_positions[1:]:
        if abs(value - np.mean(merged[-1])) <= min_separation:
            merged[-1].append(value)
        else:
            merged.append([value])
    return [float(np.mean(group)) for group in merged]


def extract_axis_segments(points_xy, orientation, cell_size, min_wall_length, merge_tolerance):
    from scipy import ndimage
    from scipy.signal import find_peaks

    primary = 0 if orientation == "vertical" else 1
    secondary = 1 - primary
    values = points_xy[:, primary]
    other = points_xy[:, secondary]
    min_val = values.min()
    max_val = values.max()
    bins = np.arange(min_val, max_val + cell_size, cell_size)
    if len(bins) < 3:
        return []
    counts, edges = np.histogram(values, bins=bins)
    smoothed = ndimage.gaussian_filter1d(counts.astype(np.float32), sigma=1.2, mode="nearest")
    threshold = max(3.0, float(smoothed.max()) * 0.18)
    peak_idx, props = find_peaks(smoothed, height=threshold, distance=max(1, int(round(merge_tolerance / cell_size))))
    positions = merge_positions(((edges[idx] + edges[idx + 1]) * 0.5 for idx in peak_idx), merge_tolerance)
    segments = []
    for pos in positions:
        band = np.abs(values - pos) <= max(merge_tolerance, cell_size * 1.5)
        if np.count_nonzero(band) < 8:
            continue
        span_min = float(np.quantile(other[band], 0.03))
        span_max = float(np.quantile(other[band], 0.97))
        if span_max - span_min < min_wall_length:
            continue
        if orientation == "vertical":
            p1 = [pos, span_min]
            p2 = [pos, span_max]
        else:
            p1 = [span_min, pos]
            p2 = [span_max, pos]
        confidence = min(1.0, float(np.count_nonzero(band)) / max(20.0, float(smoothed.max())))
        segments.append({
            "orientation": orientation,
            "score": round(confidence, 4),
            "p1": p1,
            "p2": p2,
            "groupId": f"{orientation}_{len(segments) + 1}",
        })
    return segments


def merge_collinear_segments(segments, merge_tolerance):
    if not segments:
        return []
    grouped = {"vertical": [], "horizontal": []}
    for seg in segments:
        grouped[seg["orientation"]].append(seg)
    merged_segments = []
    for orientation, segs in grouped.items():
        if not segs:
            continue
        axis_index = 0 if orientation == "vertical" else 1
        span_index = 1 - axis_index
        segs = sorted(segs, key=lambda seg: (seg["p1"][axis_index] + seg["p2"][axis_index]) * 0.5)
        buckets = []
        for seg in segs:
            center = (seg["p1"][axis_index] + seg["p2"][axis_index]) * 0.5
            if buckets and abs(buckets[-1]["center"] - center) <= merge_tolerance:
                buckets[-1]["segments"].append(seg)
                bucket_positions = [(s["p1"][axis_index] + s["p2"][axis_index]) * 0.5 for s in buckets[-1]["segments"]]
                buckets[-1]["center"] = float(np.mean(bucket_positions))
            else:
                buckets.append({"center": center, "segments": [seg]})
        for bucket in buckets:
            spans = []
            score_values = []
            for seg in bucket["segments"]:
                spans.extend([seg["p1"][span_index], seg["p2"][span_index]])
                score_values.append(seg["score"])
            span_min = min(spans)
            span_max = max(spans)
            center = bucket["center"]
            if orientation == "vertical":
                p1 = [center, span_min]
                p2 = [center, span_max]
            else:
                p1 = [span_min, center]
                p2 = [span_max, center]
            merged_segments.append({
                "orientation": orientation,
                "score": round(float(np.mean(score_values)), 4),
                "p1": p1,
                "p2": p2,
                "groupId": f"{orientation}_{len(merged_segments) + 1}",
            })
    return merged_segments


def rotate_back(point, centroid, theta):
    rot = rotation_matrix(theta)
    world = np.asarray(point, dtype=np.float64) @ rot.T + centroid
    return [float(world[0]), float(world[1])]


def build_world_segments(segments, centroid, theta, z_center):
    world_segments = []
    for seg in segments:
        p1_xy = rotate_back(seg["p1"], centroid, theta)
        p2_xy = rotate_back(seg["p2"], centroid, theta)
        world_segments.append({
            "orientation": seg["orientation"],
            "score": seg["score"],
            "groupId": seg["groupId"],
            "sourceSlice": "horizontal",
            "p1": {"x": p1_xy[0], "y": p1_xy[1], "z": float(z_center)},
            "p2": {"x": p2_xy[0], "y": p2_xy[1], "z": float(z_center)},
        })
    return world_segments


def build_corners(segments, tolerance):
    vertical = [seg for seg in segments if seg["orientation"] == "vertical"]
    horizontal = [seg for seg in segments if seg["orientation"] == "horizontal"]
    corners = []
    for v in vertical:
      x = v["p1"]["x"]
      vy0, vy1 = sorted([v["p1"]["y"], v["p2"]["y"]])
      for h in horizontal:
          y = h["p1"]["y"]
          hx0, hx1 = sorted([h["p1"]["x"], h["p2"]["x"]])
          if (hx0 - tolerance) <= x <= (hx1 + tolerance) and (vy0 - tolerance) <= y <= (vy1 + tolerance):
              corners.append({
                  "x": float(x),
                  "y": float(y),
                  "z": float(v["p1"]["z"]),
                  "source": [v["groupId"], h["groupId"]],
              })
    return corners


def save_debug_image(job_dir, density, segments, min_xy, cell_size):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    image_path = job_dir / "floorplan_preview.png"
    fig, ax = plt.subplots(figsize=(8, 8), dpi=150)
    ax.imshow(density.T, origin="lower", cmap="magma")
    for seg in segments:
        x1 = (seg["p1"]["x"] - min_xy[0]) / cell_size
        y1 = (seg["p1"]["y"] - min_xy[1]) / cell_size
        x2 = (seg["p2"]["x"] - min_xy[0]) / cell_size
        y2 = (seg["p2"]["y"] - min_xy[1]) / cell_size
        color = "#5ad8a6" if seg["orientation"] == "vertical" else "#7aa6ff"
        ax.plot([x1, x2], [y1, y2], color=color, linewidth=1.8)
    ax.set_title("Floorplan Slice Preview")
    ax.set_xticks([])
    ax.set_yticks([])
    fig.tight_layout()
    fig.savefig(image_path, bbox_inches="tight")
    plt.close(fig)
    return image_path.name


def main():
    from scipy import ndimage

    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config_path = Path(args.config)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    las_path = Path(config["lasPath"])
    job_dir = Path(config["jobDir"])
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        z_center = float(config.get("zCenter", 1.2))
        thickness = max(0.02, float(config.get("thickness", 0.12)))
        min_wall_length = max(0.2, float(config.get("minWallLength", 1.2)))
        merge_tolerance = max(0.05, float(config.get("mergeTolerance", 0.18)))
        auto_align = bool(config.get("autoAlign", True))
        orthogonal_only = bool(config.get("orthogonalOnly", True))
        grid_size = max(0.02, float(config.get("gridSize", min(0.08, merge_tolerance * 0.5))))
        debug_preview = bool(config.get("debugPreview", True))

        points = collect_slice_points(str(las_path), z_center, thickness)
        if len(points) < 100:
            raise ValueError("Not enough slice points were found at the requested height.")

        aligned_xy, centroid, theta = align_xy(points[:, :2], auto_align)
        density, density_min_xy, density_max_xy = rasterize(aligned_xy, grid_size)
        occupancy = density >= max(2, int(np.percentile(density[density > 0], 35)) if np.any(density > 0) else 2)
        occupancy = ndimage.binary_closing(occupancy, structure=np.ones((3, 3), dtype=bool))
        occupancy = ndimage.binary_opening(occupancy, structure=np.ones((2, 2), dtype=bool))
        occupancy = ndimage.binary_dilation(occupancy, iterations=1)

        valid_points = []
        xi = np.clip(((aligned_xy[:, 0] - density_min_xy[0]) / grid_size).astype(int), 0, occupancy.shape[0] - 1)
        yi = np.clip(((aligned_xy[:, 1] - density_min_xy[1]) / grid_size).astype(int), 0, occupancy.shape[1] - 1)
        for idx in range(len(aligned_xy)):
            if occupancy[xi[idx], yi[idx]]:
                valid_points.append(aligned_xy[idx])
        if len(valid_points) < 50:
            valid_points = aligned_xy
        valid_points = np.asarray(valid_points, dtype=np.float64)

        segments = []
        segments.extend(extract_axis_segments(valid_points, "vertical", grid_size, min_wall_length, merge_tolerance))
        segments.extend(extract_axis_segments(valid_points, "horizontal", grid_size, min_wall_length, merge_tolerance))
        segments = merge_collinear_segments(segments, merge_tolerance)
        if orthogonal_only:
            segments = [seg for seg in segments if seg["orientation"] in {"vertical", "horizontal"}]
        if not segments:
            raise ValueError("No wall candidate segments were extracted from the slice.")

        world_segments = build_world_segments(segments, centroid, theta, z_center)
        corners = build_corners(world_segments, merge_tolerance * 1.5)

        debug_images = []
        if debug_preview:
            debug_name = save_debug_image(job_dir, density, world_segments, centroid + density_min_xy, grid_size)
            debug_images.append({
                "name": debug_name,
                "url": f"/floorplan-jobs/{job_dir.name}/{debug_name}",
            })

        bounds = {
            "minX": float(points[:, 0].min()),
            "maxX": float(points[:, 0].max()),
            "minY": float(points[:, 1].min()),
            "maxY": float(points[:, 1].max()),
            "minZ": float(points[:, 2].min()),
            "maxZ": float(points[:, 2].max()),
        }
        result = {
            "ok": True,
            "sourcePath": str(las_path),
            "sliceBounds": bounds,
            "rasterMeta": {
                "cellSize": grid_size,
                "width": int(density.shape[0]),
                "height": int(density.shape[1]),
                "rotationRadians": float(theta if auto_align else 0.0),
                "rotationDegrees": float(math.degrees(theta if auto_align else 0.0)),
            },
            "segments": world_segments,
            "corners": corners,
            "debugImages": debug_images,
            "stats": {
                "slicePointCount": int(len(points)),
                "usablePointCount": int(len(valid_points)),
                "segmentCount": int(len(world_segments)),
                "cornerCount": int(len(corners)),
            },
        }
        print("RESULT:" + json.dumps(result), flush=True)
    except Exception as exc:
        print("RESULT:" + json.dumps({"ok": False, "error": str(exc)}), flush=True)
        raise


if __name__ == "__main__":
    main()
