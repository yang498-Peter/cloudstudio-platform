#!/usr/bin/env python3
import argparse
import csv
import json
import struct
import sys
from pathlib import Path

import laspy
import numpy as np

from export_las import (
    ExportTransformer,
    build_keep_mask,
    compute_bounds,
    prepare_output_header,
    quantized_offsets,
    write_output,
)


SUPPORTED_FORMATS = {"las", "laz", "ply", "xyz", "pts", "csv"}


def normalize_format_key(value, default="las"):
    raw = str(value or "").strip().lower()
    return raw if raw in SUPPORTED_FORMATS else default


def get_dimension_or_default(chunk, name, default_value, dtype):
    if hasattr(chunk, name):
        return np.asarray(getattr(chunk, name), dtype=dtype)
    return np.full(len(chunk.array), default_value, dtype=dtype)


def get_chunk_payload(chunk, keep_mask, transformer):
    x, y, z = transformer.transform_xyz(chunk.x[keep_mask], chunk.y[keep_mask], chunk.z[keep_mask])
    payload = {
        "x": np.asarray(x, dtype=np.float64),
        "y": np.asarray(y, dtype=np.float64),
        "z": np.asarray(z, dtype=np.float64),
        "r": get_dimension_or_default(chunk, "red", 0, np.uint16)[keep_mask],
        "g": get_dimension_or_default(chunk, "green", 0, np.uint16)[keep_mask],
        "b": get_dimension_or_default(chunk, "blue", 0, np.uint16)[keep_mask],
        "intensity": get_dimension_or_default(chunk, "intensity", 0, np.uint16)[keep_mask],
    }
    return payload


def normalize_color_channel(channel):
    arr = np.asarray(channel, dtype=np.uint16)
    if arr.size == 0:
        return arr.astype(np.uint8)
    max_value = int(np.max(arr))
    if max_value <= 255:
        return arr.astype(np.uint8)
    return np.rint(arr / 257.0).clip(0, 255).astype(np.uint8)


def write_xyz_output(input_path, output_path, transformer, chunk_size):
    written_points = 0
    with laspy.open(input_path) as reader, open(output_path, "w", encoding="utf-8", newline="") as handle:
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            if not np.any(keep_mask):
                continue
            payload = get_chunk_payload(chunk, keep_mask, transformer)
            for x, y, z in zip(payload["x"], payload["y"], payload["z"]):
                handle.write(f"{x:.8f} {y:.8f} {z:.8f}\n")
            written_points += len(payload["x"])
    return written_points


def write_csv_output(input_path, output_path, transformer, chunk_size):
    written_points = 0
    with laspy.open(input_path) as reader, open(output_path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["x", "y", "z", "r", "g", "b", "intensity"])
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            if not np.any(keep_mask):
                continue
            payload = get_chunk_payload(chunk, keep_mask, transformer)
            rgb_r = normalize_color_channel(payload["r"])
            rgb_g = normalize_color_channel(payload["g"])
            rgb_b = normalize_color_channel(payload["b"])
            for row in zip(payload["x"], payload["y"], payload["z"], rgb_r, rgb_g, rgb_b, payload["intensity"]):
                writer.writerow([
                    f"{row[0]:.8f}",
                    f"{row[1]:.8f}",
                    f"{row[2]:.8f}",
                    int(row[3]),
                    int(row[4]),
                    int(row[5]),
                    int(row[6]),
                ])
            written_points += len(payload["x"])
    return written_points


def write_pts_output(input_path, output_path, transformer, chunk_size):
    total_points = 0
    with laspy.open(input_path) as reader:
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            total_points += int(np.count_nonzero(keep_mask))

    written_points = 0
    with laspy.open(input_path) as reader, open(output_path, "w", encoding="utf-8", newline="") as handle:
        handle.write(f"{total_points}\n")
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            if not np.any(keep_mask):
                continue
            payload = get_chunk_payload(chunk, keep_mask, transformer)
            rgb_r = normalize_color_channel(payload["r"])
            rgb_g = normalize_color_channel(payload["g"])
            rgb_b = normalize_color_channel(payload["b"])
            for row in zip(payload["x"], payload["y"], payload["z"], payload["intensity"], rgb_r, rgb_g, rgb_b):
                handle.write(
                    f"{row[0]:.8f} {row[1]:.8f} {row[2]:.8f} {int(row[3])} {int(row[4])} {int(row[5])} {int(row[6])}\n"
                )
            written_points += len(payload["x"])
    return written_points


def write_ply_ascii(input_path, output_path, transformer, chunk_size, written_points):
    with laspy.open(input_path) as reader, open(output_path, "w", encoding="utf-8", newline="") as handle:
        handle.write("ply\n")
        handle.write("format ascii 1.0\n")
        handle.write("comment Generated by CloudStudio export pipeline\n")
        handle.write(f"element vertex {written_points}\n")
        handle.write("property double x\n")
        handle.write("property double y\n")
        handle.write("property double z\n")
        handle.write("property uchar red\n")
        handle.write("property uchar green\n")
        handle.write("property uchar blue\n")
        handle.write("end_header\n")
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            if not np.any(keep_mask):
                continue
            payload = get_chunk_payload(chunk, keep_mask, transformer)
            rgb_r = normalize_color_channel(payload["r"])
            rgb_g = normalize_color_channel(payload["g"])
            rgb_b = normalize_color_channel(payload["b"])
            for row in zip(payload["x"], payload["y"], payload["z"], rgb_r, rgb_g, rgb_b):
                handle.write(f"{row[0]:.8f} {row[1]:.8f} {row[2]:.8f} {int(row[3])} {int(row[4])} {int(row[5])}\n")


def write_ply_binary(input_path, output_path, transformer, chunk_size, written_points):
    with laspy.open(input_path) as reader, open(output_path, "wb") as handle:
        header = (
            "ply\n"
            "format binary_little_endian 1.0\n"
            "comment Generated by CloudStudio export pipeline\n"
            f"element vertex {written_points}\n"
            "property double x\n"
            "property double y\n"
            "property double z\n"
            "property uchar red\n"
            "property uchar green\n"
            "property uchar blue\n"
            "end_header\n"
        )
        handle.write(header.encode("ascii"))
        packer = struct.Struct("<dddBBB")
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            if not np.any(keep_mask):
                continue
            payload = get_chunk_payload(chunk, keep_mask, transformer)
            rgb_r = normalize_color_channel(payload["r"])
            rgb_g = normalize_color_channel(payload["g"])
            rgb_b = normalize_color_channel(payload["b"])
            for row in zip(payload["x"], payload["y"], payload["z"], rgb_r, rgb_g, rgb_b):
                handle.write(packer.pack(float(row[0]), float(row[1]), float(row[2]), int(row[3]), int(row[4]), int(row[5])))


def write_ply_output(input_path, output_path, transformer, chunk_size, ply_encoding):
    total_points = 0
    with laspy.open(input_path) as reader:
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            total_points += int(np.count_nonzero(keep_mask))

    if total_points == 0:
        raise ValueError("当前删除区域和裁剪盒过滤掉了全部点，无法导出空点云。请调整范围后重试。")

    if ply_encoding == "ascii":
        write_ply_ascii(input_path, output_path, transformer, chunk_size, total_points)
    else:
        write_ply_binary(input_path, output_path, transformer, chunk_size, total_points)
    return total_points


def write_las_family_output(input_path, output_path, transformer, chunk_size):
    with laspy.open(input_path) as reader:
        source_header = reader.header
        out_header = prepare_output_header(source_header, transformer)

    mins, _maxs, _deleted_points, _clip_filtered_points, _kept_points = compute_bounds(input_path, transformer, chunk_size)
    out_header.offsets = quantized_offsets(mins, out_header.scales)
    return write_output(input_path, output_path, transformer, out_header, chunk_size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Path to export config JSON")
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    input_path = config["inputPath"]
    output_path = config["outputPath"]
    chunk_size = int(config.get("chunkSize") or 500000)
    export_options = config.get("exportOptions") or {}
    output_format = normalize_format_key(export_options.get("format"))
    ply_encoding = str(export_options.get("plyEncoding") or "binary").strip().lower()
    if ply_encoding not in {"ascii", "binary"}:
        ply_encoding = "binary"

    with laspy.open(input_path) as reader:
        source_header = reader.header
        transformer = ExportTransformer(config, source_header)
        total_input_points = int(getattr(source_header, "point_count", 0) or 0)
    _mins, _maxs, deleted_points, clip_filtered_points, kept_points = compute_bounds(input_path, transformer, chunk_size)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    if output_format in {"las", "laz"}:
        written_points = write_las_family_output(input_path, output_path, transformer, chunk_size)
    elif output_format == "ply":
        written_points = write_ply_output(input_path, output_path, transformer, chunk_size, ply_encoding)
    elif output_format == "xyz":
        written_points = write_xyz_output(input_path, output_path, transformer, chunk_size)
    elif output_format == "pts":
        written_points = write_pts_output(input_path, output_path, transformer, chunk_size)
    elif output_format == "csv":
        written_points = write_csv_output(input_path, output_path, transformer, chunk_size)
    else:
        raise ValueError(f"不支持的导出格式: {output_format}")

    result = {
        "ok": True,
        "outputPath": output_path,
        "format": output_format,
        "standardCrsWritten": transformer.standard_crs_allowed if output_format in {"las", "laz"} else False,
        "crsOmitReason": transformer.crs_omit_reason if output_format in {"las", "laz"} else "当前格式不写入标准 LAS CRS metadata。",
        "outputLinearUnit": transformer.output_linear_unit,
        "transformKind": transformer.transform_kind,
        "plyEncoding": ply_encoding if output_format == "ply" else None,
        "deleteRegionCount": len(transformer.delete_regions),
        "clipBoxCount": len(transformer.clip_boxes),
        "deletedPoints": int(deleted_points),
        "clipFilteredPoints": int(clip_filtered_points),
        "keptPoints": int(kept_points),
        "writtenPoints": int(written_points),
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
