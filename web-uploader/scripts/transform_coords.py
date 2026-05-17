#!/usr/bin/env python3
import argparse
import json
import math
import sys
from pathlib import Path

from pyproj import CRS, Transformer

from export_las import (
    WGS84_3D,
    augment_proj_ref_with_server_grids,
    build_source_crs_context,
    load_grid_registry,
    local_to_ecef_arrays,
    normalize_linear_unit_key,
    resolve_effective_source_geodetic,
)


def apply_manual_projected_adjustment(point, origin_point, coord_config):
    easting_offset = float(coord_config.get("eastingOffset") or 0.0)
    northing_offset = float(coord_config.get("northingOffset") or 0.0)
    height_offset = float(coord_config.get("heightOffset") or 0.0)
    rotation_deg = float(coord_config.get("rotationDeg") or 0.0)
    scale_ppm = float(coord_config.get("scalePpm") or 0.0)

    if not any(abs(v) > 1e-12 for v in (easting_offset, northing_offset, height_offset, rotation_deg, scale_ppm)):
        return point

    origin_x, origin_y, _origin_z = origin_point
    scale = 1.0 + scale_ppm * 1e-6
    rot = math.radians(rotation_deg)
    cos_r = math.cos(rot)
    sin_r = math.sin(rot)

    dx = (point["x"] - origin_x) * scale
    dy = (point["y"] - origin_y) * scale

    return {
        "kind": "projected",
        "x": origin_x + dx * cos_r - dy * sin_r + easting_offset,
        "y": origin_y + dx * sin_r + dy * cos_r + northing_offset,
        "z": point["z"] + height_offset,
    }


def transform_points(config):
    coord_config = config.get("coordConfig") or {}
    source_geodetic = resolve_effective_source_geodetic(
        config.get("sourceGeodetic") or coord_config.get("sourceGeodetic"),
        config,
        coord_config,
    )
    source_context = build_source_crs_context(source_geodetic)
    resolved = config.get("resolvedCoordinateSystem") or {}
    grid_registry = load_grid_registry(config.get("gridRegistryPath"))
    geo_info = config.get("geoInfo") or None
    local_points = config.get("localPoints") or []
    points_wgs84 = config.get("pointsWgs84") or []
    origin_wgs84 = config.get("originWgs84") or None
    transform_kind = resolved.get("kind") or "local"

    source_points = []
    source_origin = None

    if local_points and geo_info:
        for point in local_points:
            ecef_x, ecef_y, ecef_z = local_to_ecef_arrays(
                float(point["x"]), float(point["y"]), float(point["z"]), geo_info
            )
            lon, lat, alt = source_context["ecef_to_geographic"].transform(ecef_x, ecef_y, ecef_z)
            source_points.append({"lon": lon, "lat": lat, "alt": alt})
        ecef_origin = geo_info.get("origin") or {}
        if ecef_origin:
            lon0, lat0, alt0 = source_context["ecef_to_geographic"].transform(
                float(ecef_origin.get("x") or 0.0),
                float(ecef_origin.get("y") or 0.0),
                float(ecef_origin.get("z") or 0.0),
            )
            source_origin = {"lon": lon0, "lat": lat0, "alt": alt0}
    elif points_wgs84:
        if origin_wgs84:
            lon0, lat0, alt0 = Transformer.from_crs(
                WGS84_3D, source_context["geographic3d"], always_xy=True
            ).transform(
                float(origin_wgs84["lon"]), float(origin_wgs84["lat"]), float(origin_wgs84["alt"])
            )
            source_origin = {"lon": lon0, "lat": lat0, "alt": alt0}
        legacy_transformer = Transformer.from_crs(WGS84_3D, source_context["geographic3d"], always_xy=True)
        for point in points_wgs84:
            lon, lat, alt = legacy_transformer.transform(
                float(point["lon"]), float(point["lat"]), float(point["alt"])
            )
            source_points.append({"lon": lon, "lat": lat, "alt": alt})

    if transform_kind == "local":
      return {
          "ok": True,
          "kind": "local",
          "points": [{"kind": "local"} for _ in (local_points or points_wgs84)],
          "attachedServerGrids": [],
      }

    if transform_kind == "geographic":
        proj_ref, attached = augment_proj_ref_with_server_grids(resolved.get("proj") or "EPSG:4326", coord_config, grid_registry)
        output_crs = CRS.from_user_input(proj_ref)
        transformer = Transformer.from_crs(source_context["geographic3d"], output_crs, always_xy=True)
        points = []
        for point in source_points:
            lon, lat, alt = transformer.transform(float(point["lon"]), float(point["lat"]), float(point["alt"]))
            points.append({
                "kind": "geographic",
                "lon": lon,
                "lat": lat,
                "alt": alt,
            })
        return {
            "ok": True,
            "kind": "geographic",
            "points": points,
            "attachedServerGrids": attached,
        }

    proj_ref = resolved.get("proj")
    if not proj_ref:
        raise ValueError("目标坐标系缺少可用于原生变换的投影定义。")

    proj_ref, attached = augment_proj_ref_with_server_grids(proj_ref, coord_config, grid_registry)
    output_crs = CRS.from_user_input(proj_ref)
    transformer = Transformer.from_crs(source_context["geographic3d"], output_crs, always_xy=True)
    xy_unit = normalize_linear_unit_key(
        ((resolved.get("xyUnitSpec") or {}).get("key")) or ""
    )

    raw_origin = None
    if source_origin:
        ox, oy, oz = transformer.transform(float(source_origin["lon"]), float(source_origin["lat"]), float(source_origin["alt"]))
        raw_origin = (ox, oy, oz)

    points = []
    for point in source_points:
        x, y, z = transformer.transform(float(point["lon"]), float(point["lat"]), float(point["alt"]))
        transformed = {"kind": "projected", "x": x, "y": y, "z": z}
        if raw_origin is not None:
            transformed = apply_manual_projected_adjustment(transformed, raw_origin, coord_config)
        transformed["xyUnitSpec"] = {"key": xy_unit or "m"}
        points.append(transformed)

    return {
        "ok": True,
        "kind": "projected",
        "points": points,
        "attachedServerGrids": attached,
        "xyUnitSpec": {"key": xy_unit or "m"},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Path to transform config JSON")
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    result = transform_points(config)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
