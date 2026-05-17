#!/usr/bin/env python3
import argparse
import copy
import json
import math
import os
import re
import sys
from pathlib import Path

import laspy
import numpy as np
from pyproj import CRS, Transformer


WGS84 = CRS.from_epsg(4326)
WGS84_3D = CRS.from_epsg(4979)
DEFAULT_SOURCE_GEODETIC = {
    "query": "WGS84",
    "code": "EPSG:4326",
    "name": "WGS 84",
    "kind": "geographic",
    "proj4": "EPSG:4326",
    "summary": {
        "kind": "geographic",
        "units": "deg",
        "datum": "World Geodetic System 1984 ensemble",
        "ellipsoid": "WGS 84",
        "semiMajorAxis": 6378137.0,
        "inverseFlattening": 298.257223563,
        "semiMinorAxis": 6356752.314245179,
    },
    "source": {"type": "bootstrap", "provider": "default"},
    "geographic3D": {"code": "EPSG:4979", "name": "EPSG:4979"},
    "geocentric": {"proj4": "+proj=geocent +datum=WGS84 +units=m +no_defs +type=crs"},
}
CRS_VLR_RECORD_IDS = {2111, 2112, 34735, 34736, 34737}
LINEAR_UNITS = {
    "m": {"symbol": "m", "meters_per_unit": 1.0},
    "us-ft": {"symbol": "us-ft", "meters_per_unit": 1200.0 / 3937.0},
    "ft": {"symbol": "ft", "meters_per_unit": 0.3048},
    "km": {"symbol": "km", "meters_per_unit": 1000.0},
    "yd": {"symbol": "yd", "meters_per_unit": 0.9144},
    "in": {"symbol": "in", "meters_per_unit": 0.0254},
    "cm": {"symbol": "cm", "meters_per_unit": 0.01},
    "mm": {"symbol": "mm", "meters_per_unit": 0.001},
}


def normalize_source_geodetic_config(source_config):
    normalized = copy.deepcopy(DEFAULT_SOURCE_GEODETIC)
    if isinstance(source_config, dict):
        for key, value in source_config.items():
            if key == "summary" and isinstance(value, dict):
                normalized["summary"] = {
                    **normalized.get("summary", {}),
                    **value,
                }
            elif key == "source" and isinstance(value, dict):
                normalized["source"] = {
                    **normalized.get("source", {}),
                    **value,
                }
            elif key == "geographic3D" and isinstance(value, dict):
                normalized["geographic3D"] = {
                    **(normalized.get("geographic3D") or {}),
                    **value,
                }
            elif key == "geocentric" and isinstance(value, dict):
                normalized["geocentric"] = {
                    **(normalized.get("geocentric") or {}),
                    **value,
                }
            elif value not in (None, ""):
                normalized[key] = value
    normalized["query"] = str(normalized.get("query") or normalized.get("code") or "WGS84").strip() or "WGS84"
    normalized["code"] = str(normalized.get("code") or "EPSG:4326").strip() or "EPSG:4326"
    normalized["name"] = str(normalized.get("name") or normalized["code"]).strip() or normalized["code"]
    normalized["kind"] = "geographic"
    normalized["proj4"] = str(normalized.get("proj4") or normalized["code"]).strip() or normalized["code"]
    return normalized


def source_geodetic_override_enabled(*configs):
    for config in configs:
        if isinstance(config, dict) and bool(
            config.get("enableSourceGeodeticOverride")
            or config.get("useSourceGeodeticOverride")
        ):
            return True
    return False


def resolve_effective_source_geodetic(source_config=None, *configs):
    if source_geodetic_override_enabled(source_config, *configs):
        return normalize_source_geodetic_config(source_config)
    return normalize_source_geodetic_config(DEFAULT_SOURCE_GEODETIC)


def _safe_float(value):
    try:
        parsed = float(value)
    except Exception:
        return None
    return parsed if math.isfinite(parsed) else None


def build_geocentric_proj4_from_summary(summary):
    if not isinstance(summary, dict):
        summary = {}
    semi_major = _safe_float(summary.get("semiMajorAxis"))
    inverse_flattening = _safe_float(summary.get("inverseFlattening"))
    semi_minor = _safe_float(summary.get("semiMinorAxis"))
    if not semi_major:
        semi_major = DEFAULT_SOURCE_GEODETIC["summary"]["semiMajorAxis"]
    parts = ["+proj=geocent", f"+a={semi_major}"]
    if inverse_flattening:
        parts.append(f"+rf={inverse_flattening}")
    elif semi_minor:
        parts.append(f"+b={semi_minor}")
    else:
        parts.append(f"+rf={DEFAULT_SOURCE_GEODETIC['summary']['inverseFlattening']}")
    parts.extend(["+units=m", "+no_defs", "+type=crs"])
    return " ".join(parts)


def build_source_crs_context(source_config):
    source = normalize_source_geodetic_config(source_config)
    geographic_ref = source.get("code") or source.get("proj4") or "EPSG:4326"
    geographic = CRS.from_user_input(geographic_ref)
    if not geographic.is_geographic and source.get("proj4") and source.get("proj4") != geographic_ref:
        geographic = CRS.from_user_input(source.get("proj4"))
    if not geographic.is_geographic:
        raise ValueError(f"Source CRS must be geographic, got: {source.get('code') or source.get('proj4')}")
    geographic3d = None
    geographic3d_ref = ((source.get("geographic3D") or {}).get("code") or "").strip()
    if geographic3d_ref:
        try:
            geographic3d = CRS.from_user_input(geographic3d_ref)
        except Exception:
            geographic3d = None
    try:
        geographic3d = geographic3d or geographic.to_3d()
    except Exception:
        geographic3d = geographic3d or geographic
    geocentric_ref = ((source.get("geocentric") or {}).get("proj4") or "").strip()
    geocentric = CRS.from_user_input(
        geocentric_ref or build_geocentric_proj4_from_summary(source.get("summary") or {})
    )
    return {
        "config": source,
        "geographic": geographic,
        "geographic3d": geographic3d,
        "geocentric": geocentric,
        "ecef_to_geographic": Transformer.from_crs(geocentric, geographic3d, always_xy=True),
        "geographic_to_ecef": Transformer.from_crs(geographic3d, geocentric, always_xy=True),
    }


def is_wgs84_like_source(source_config):
    source = normalize_source_geodetic_config(source_config)
    code = str(source.get("code") or "").strip().upper()
    return code in {"EPSG:4326", "EPSG:4979"} or str(source.get("query") or "").strip().upper() in {"WGS84", "WGS 84"}


def normalize_linear_unit_key(value, default="m"):
    raw = str(value or "").strip().lower().replace("_", "-")
    if not raw:
        return default

    alias_map = {
        "meter": "m",
        "meters": "m",
        "metre": "m",
        "metres": "m",
        "us survey foot": "us-ft",
        "us-survey-foot": "us-ft",
        "us survey feet": "us-ft",
        "survey foot": "us-ft",
        "survey feet": "us-ft",
        "foot us": "us-ft",
        "foot-us": "us-ft",
        "feet": "ft",
        "foot": "ft",
        "international foot": "ft",
        "international feet": "ft",
    }
    return alias_map.get(raw, raw if raw in LINEAR_UNITS else default)


def meters_per_unit(unit_key):
    return LINEAR_UNITS[normalize_linear_unit_key(unit_key)]["meters_per_unit"]


def parse_geo_info_csv(path):
    text = Path(path).read_text(encoding="utf-8").strip().splitlines()
    if len(text) < 2:
      raise ValueError("geo_info.csv 内容不足")
    vals = [float(v) for v in text[1].split(",")]
    if len(vals) < 7:
      raise ValueError("geo_info.csv 字段不足")
    return {
        "origin": {"x": vals[0], "y": vals[1], "z": vals[2]},
        "rotation": {"qx": vals[3], "qy": vals[4], "qz": vals[5], "qw": vals[6]},
    }


def quat_rotate_arrays(q, x, y, z):
    qx = q["qx"]
    qy = q["qy"]
    qz = q["qz"]
    qw = q["qw"]

    ix = qw * x + qy * z - qz * y
    iy = qw * y + qz * x - qx * z
    iz = qw * z + qx * y - qy * x
    iw = -qx * x - qy * y - qz * z

    rx = ix * qw + iw * -qx + iy * -qz - iz * -qy
    ry = iy * qw + iw * -qy + iz * -qx - ix * -qz
    rz = iz * qw + iw * -qz + ix * -qy - iy * -qx
    return rx, ry, rz


def local_to_ecef_arrays(x, y, z, geo_info):
    rx, ry, rz = quat_rotate_arrays(geo_info["rotation"], x, y, z)
    origin = geo_info["origin"]
    return rx + origin["x"], ry + origin["y"], rz + origin["z"]


def is_crs_vlr(vlr):
    return getattr(vlr, "record_id", None) in CRS_VLR_RECORD_IDS or getattr(vlr, "user_id", "") == "LASF_Projection"


def choose_linear_scale(unit_key):
    return 0.001 / meters_per_unit(unit_key)


def choose_output_scales(transform_kind, output_linear_unit):
    if transform_kind == "geographic":
        return np.array([1e-8, 1e-8, choose_linear_scale(output_linear_unit)], dtype=np.float64)
    linear_scale = choose_linear_scale(output_linear_unit)
    return np.array([linear_scale, linear_scale, linear_scale], dtype=np.float64)


def infer_horizontal_unit_key_from_crs(crs, fallback="m"):
    if crs is None:
        return fallback

    axis_info = getattr(crs, "axis_info", None) or []
    for axis in axis_info:
        unit_name = getattr(axis, "unit_name", None)
        key = normalize_linear_unit_key(unit_name, default="")
        if key in LINEAR_UNITS:
            return key

    try:
        proj4 = crs.to_proj4()
    except Exception:
        proj4 = ""

    if "+units=us-ft" in proj4:
        return "us-ft"
    if "+units=ft" in proj4:
        return "ft"
    if "+units=km" in proj4:
        return "km"
    if "+units=yd" in proj4:
        return "yd"
    if "+units=in" in proj4:
        return "in"
    if "+units=cm" in proj4:
        return "cm"
    if "+units=mm" in proj4:
        return "mm"
    return fallback


def manual_adjustment_active(coord_config):
    keys = ("eastingOffset", "northingOffset", "heightOffset", "rotationDeg", "scalePpm")
    return any(abs(float(coord_config.get(key) or 0.0)) > 1e-12 for key in keys)


def load_grid_registry(grid_registry_path):
    if not grid_registry_path:
        return {}
    path = Path(grid_registry_path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def materialize_proj_string(proj_ref):
    if not proj_ref:
        raise ValueError("目标坐标系缺少投影定义。")
    if str(proj_ref).strip().startswith("+"):
        return str(proj_ref).strip()
    return CRS.from_user_input(proj_ref).to_proj4()


def inject_proj_param(proj_text, key, value):
    if value is None or value == "":
        return proj_text
    token = f"+{key}={value}"
    pattern = rf"\+{key}=\S+"
    if key in {"nadgrids", "geoidgrids", "grids"} and re.search(pattern, proj_text):
        return re.sub(pattern, token, proj_text)
    if re.search(pattern, proj_text):
        return re.sub(pattern, token, proj_text)
    return f"{proj_text} {token}".strip()


def augment_proj_ref_with_server_grids(proj_ref, coord_config, grid_registry):
    server_grid_refs = coord_config.get("serverGridRefs") or []
    if not server_grid_refs:
        return proj_ref, []

    proj_text = materialize_proj_string(proj_ref)
    attached = []
    nadgrids = []
    geoidgrids = []

    for grid_id in server_grid_refs:
        record = grid_registry.get(grid_id) if isinstance(grid_registry, dict) else None
        if not isinstance(record, dict):
            continue
        abs_path = record.get("absPath")
        if not abs_path or not os.path.exists(abs_path):
            continue
        usage = str(record.get("usageHint") or "").strip().lower()
        attached.append({"id": grid_id, "name": record.get("name") or grid_id, "usageHint": usage, "path": abs_path})
        if usage == "nadgrids":
            nadgrids.append(abs_path)
        elif usage == "geoidgrids":
            geoidgrids.append(abs_path)

    if nadgrids:
        proj_text = inject_proj_param(proj_text, "nadgrids", ",".join(nadgrids))
    if geoidgrids:
        proj_text = inject_proj_param(proj_text, "geoidgrids", ",".join(geoidgrids))
    return proj_text, attached


def sanitize_export_summary(summary):
    return json.dumps(summary, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def matrix_from_config(values, default_identity=False):
    if isinstance(values, list) and len(values) == 16:
        return np.asarray(values, dtype=np.float64).reshape(4, 4, order="F")
    if default_identity:
        return np.eye(4, dtype=np.float64)
    raise ValueError("delete region matrix 格式错误")


def normalize_delete_regions(config_regions):
    regions = []
    for index, region in enumerate(config_regions or []):
        markers = region.get("markers") if isinstance(region, dict) else None
        if not isinstance(markers, list) or len(markers) < 3:
          continue
        vertices = []
        for marker in markers[:8]:
            try:
                vertices.append((float(marker["x"]), float(marker["y"])))
            except Exception:
                vertices = []
                break
        if len(vertices) < 3:
            continue

        regions.append({
            "id": str(region.get("id") or f"delete-region-{index + 1}"),
            "name": str(region.get("name") or f"删除区域 {index + 1}"),
            "vertices": np.asarray(vertices, dtype=np.float64),
            "view_matrix": matrix_from_config(region.get("viewMatrix")),
            "proj_matrix": matrix_from_config(region.get("projMatrix")),
        })
    return regions


def normalize_clip_boxes(config_boxes):
    boxes = []
    for index, box in enumerate(config_boxes or []):
        if not isinstance(box, dict):
            continue
        try:
            inverse_local_matrix = matrix_from_config(box.get("inverseLocalMatrix"))
        except Exception:
            continue
        boxes.append({
            "id": str(box.get("id") or f"clip-box-{index + 1}"),
            "name": str(box.get("name") or f"Clip Box {index + 1}"),
            "inverse_local_matrix": inverse_local_matrix,
        })
    return boxes


def points_inside_polygon(px, py, vertices):
    inside = np.zeros(px.shape, dtype=bool)
    vx = vertices[:, 0]
    vy = vertices[:, 1]
    j = len(vertices) - 1

    for i in range(len(vertices)):
        yi = vy[i]
        yj = vy[j]
        crosses = (yi > py) != (yj > py)
        denom = yj - yi
        intersect_x = np.full(px.shape, np.inf, dtype=np.float64)
        valid = np.abs(denom) > 1e-12
        if np.any(valid):
            intersect_x[valid] = (vx[j] - vx[i]) * (py[valid] - yi) / denom + vx[i]
        inside ^= crosses & (px < intersect_x)
        j = i
    return inside


def build_delete_mask(x, y, z, delete_regions):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    z = np.asarray(z, dtype=np.float64)
    if not delete_regions:
        return np.zeros(x.shape, dtype=bool)

    base_points = np.stack([x, y, z, np.ones_like(x, dtype=np.float64)], axis=1)
    delete_mask = np.zeros(x.shape, dtype=bool)

    for region in delete_regions:
        clip_points = base_points @ (region["view_matrix"].T @ region["proj_matrix"].T)

        w = clip_points[:, 3]
        valid = np.isfinite(w) & (np.abs(w) > 1e-12)
        if not np.any(valid):
            continue

        ndc_x = np.empty_like(x, dtype=np.float64)
        ndc_y = np.empty_like(y, dtype=np.float64)
        ndc_x.fill(np.inf)
        ndc_y.fill(np.inf)
        ndc_x[valid] = clip_points[valid, 0] / w[valid]
        ndc_y[valid] = clip_points[valid, 1] / w[valid]

        inside = np.zeros_like(delete_mask)
        inside[valid] = points_inside_polygon(ndc_x[valid], ndc_y[valid], region["vertices"])
        delete_mask |= inside

    return delete_mask


def build_clip_box_mask(x, y, z, clip_boxes, clip_mode="inside"):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    z = np.asarray(z, dtype=np.float64)
    if not clip_boxes:
        return np.ones(x.shape, dtype=bool)

    points = np.stack([x, y, z, np.ones_like(x, dtype=np.float64)], axis=1)
    inside_all = np.ones(x.shape, dtype=bool)

    for box in clip_boxes:
        local_points = points @ box["inverse_local_matrix"].T
        w = local_points[:, 3]
        valid = np.isfinite(w) & (np.abs(w) > 1e-12)
        if not np.any(valid):
            continue

        local_xyz = np.empty((len(x), 3), dtype=np.float64)
        local_xyz.fill(np.inf)
        local_xyz[valid, 0] = local_points[valid, 0] / w[valid]
        local_xyz[valid, 1] = local_points[valid, 1] / w[valid]
        local_xyz[valid, 2] = local_points[valid, 2] / w[valid]

        inside = (
            np.abs(local_xyz[:, 0]) <= 0.5
        ) & (
            np.abs(local_xyz[:, 1]) <= 0.5
        ) & (
            np.abs(local_xyz[:, 2]) <= 0.5
        )
        inside_all &= inside

    return ~inside_all if str(clip_mode or "inside").strip().lower() == "outside" else inside_all


def build_keep_mask(x, y, z, transformer):
    delete_mask = build_delete_mask(x, y, z, transformer.delete_regions)
    clip_keep_mask = build_clip_box_mask(x, y, z, transformer.clip_boxes, transformer.clip_mode)
    keep_mask = (~delete_mask) & clip_keep_mask
    return keep_mask, delete_mask, clip_keep_mask


class ExportTransformer:
    def __init__(self, config, source_header):
        self.dataset_context = config["datasetContext"]
        self.coord_config = config["coordConfig"]
        self.source_geodetic = resolve_effective_source_geodetic(
            config.get("sourceGeodetic") or self.coord_config.get("sourceGeodetic"),
            config,
            self.coord_config,
        )
        self.source_crs_context = build_source_crs_context(self.source_geodetic)
        self.resolved = config["resolvedCoordinateSystem"]
        self.export_options = config["exportOptions"]
        self.transform_mode = self.export_options["transformMode"]
        self.output_linear_unit = normalize_linear_unit_key(self.export_options["outputLinearUnit"])
        self.include_crs_requested = bool(self.export_options.get("includeCrsMetadata", True))
        self.include_export_vlr = bool(self.export_options.get("includeExportMetadataVlr", True))
        self.source_header_crs = source_header.parse_crs()
        self.source_linear_unit = infer_horizontal_unit_key_from_crs(self.source_header_crs, fallback="m")
        self.delete_regions = normalize_delete_regions(config.get("deleteRegions"))
        self.clip_boxes = normalize_clip_boxes(config.get("clipBoxes"))
        self.clip_mode = str(self.export_options.get("clipMode") or "inside").strip().lower()
        self.grid_registry = load_grid_registry(config.get("gridRegistryPath"))
        self.server_grid_refs = list(self.coord_config.get("serverGridRefs") or [])
        self.attached_server_grids = []
        self.geo_info = None
        self.projected_transformer = None
        self.output_crs = None
        self.target_xy_unit = self.source_linear_unit
        self.transform_kind = "local"
        self.standard_crs_allowed = False
        self.crs_omit_reason = ""
        self.export_summary = {
            "datasetContext": self.dataset_context,
            "transformMode": self.transform_mode,
            "resolvedCoordinateSystem": {
                "kind": self.resolved.get("kind"),
                "label": self.resolved.get("label"),
                "source": self.resolved.get("source"),
            },
            "coordConfig": {
                "mode": self.coord_config.get("mode"),
                "code": self.coord_config.get("code"),
                "manualAdjustments": {
                    "eastingOffset": float(self.coord_config.get("eastingOffset") or 0.0),
                    "northingOffset": float(self.coord_config.get("northingOffset") or 0.0),
                    "heightOffset": float(self.coord_config.get("heightOffset") or 0.0),
                    "rotationDeg": float(self.coord_config.get("rotationDeg") or 0.0),
                    "scalePpm": float(self.coord_config.get("scalePpm") or 0.0),
                },
            },
            "outputLinearUnit": self.output_linear_unit,
            "sourceLinearUnit": self.source_linear_unit,
            "sourceGeodetic": {
                "query": self.source_geodetic.get("query"),
                "code": self.source_geodetic.get("code"),
                "name": self.source_geodetic.get("name"),
                "summary": self.source_geodetic.get("summary"),
            },
            "deleteRegionCount": len(self.delete_regions),
            "clipBoxCount": len(self.clip_boxes),
            "clipMode": self.clip_mode,
            "serverGridRefs": self.server_grid_refs,
            "attachedServerGrids": [],
        }

        if self.transform_mode == "local":
            self.transform_kind = "local"
            if self.include_crs_requested and self.source_header_crs is not None and self.output_linear_unit == self.source_linear_unit:
                self.output_crs = self.source_header_crs
                self.standard_crs_allowed = True
            elif self.include_crs_requested and self.source_header_crs is not None:
                self.crs_omit_reason = "原始 LAS 自带 CRS，但导出单位已改变，未写入标准 CRS 以避免错误声明。"
            return

        if self.dataset_context["type"] != "scanner":
            raise ValueError("当前数据没有 geo_info.csv，无法把原始 LAS 转换到目标坐标系。请切换为本地导出。")

        geo_info_path = self.dataset_context.get("geoInfoPath")
        if not geo_info_path or not os.path.exists(geo_info_path):
            raise ValueError("缺少 geo_info.csv，无法执行坐标转换导出。")

        self.geo_info = parse_geo_info_csv(geo_info_path)
        self.transform_kind = self.resolved.get("kind") or "local"

        if self.transform_kind == "local":
            self.target_xy_unit = "m"
            return

        if self.transform_kind == "geographic":
            proj_ref, attached = augment_proj_ref_with_server_grids(self.resolved.get("proj") or "EPSG:4326", self.coord_config, self.grid_registry)
            self.output_crs = CRS.from_user_input(proj_ref)
            self.attached_server_grids = attached
            self.export_summary["attachedServerGrids"] = attached
            self.target_xy_unit = None
            if self.attached_server_grids and self.include_crs_requested:
                self.crs_omit_reason = "当前导出叠加了外部格网文件，已省略标准 CRS 写入，避免把本地格网路径误写入 LAS 元数据。"
                return
            self.standard_crs_allowed = self.include_crs_requested
            return

        proj_ref = self.resolved.get("proj")
        if not proj_ref:
            raise ValueError("目标坐标系缺少可用于导出的投影定义。")

        proj_ref, attached = augment_proj_ref_with_server_grids(proj_ref, self.coord_config, self.grid_registry)
        self.output_crs = CRS.from_user_input(proj_ref)
        self.attached_server_grids = attached
        self.export_summary["attachedServerGrids"] = attached
        self.projected_transformer = Transformer.from_crs(self.source_crs_context["geographic3d"], self.output_crs, always_xy=True)
        self.target_xy_unit = normalize_linear_unit_key(
            self.resolved.get("xyUnitSpec", {}).get("key") or infer_horizontal_unit_key_from_crs(self.output_crs, fallback="m")
        )

        if not self.include_crs_requested:
            return

        if self.attached_server_grids:
            self.crs_omit_reason = "当前导出叠加了外部格网文件，已省略标准 CRS 写入，避免把本地格网路径误写入 LAS 元数据。"
            return

        if manual_adjustment_active(self.coord_config):
            self.crs_omit_reason = "当前导出叠加了额外平移/旋转/尺度改正，已省略标准 CRS 写入。"
            return

        if self.output_linear_unit != self.target_xy_unit:
            self.crs_omit_reason = "导出单位已改成非坐标系原生单位，已省略标准 CRS 写入。"
            return

        self.standard_crs_allowed = True

    def transform_xyz(self, x, y, z):
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        z = np.asarray(z, dtype=np.float64)

        if self.transform_mode == "local" or self.transform_kind == "local":
            if self.output_linear_unit != self.source_linear_unit:
                factor = meters_per_unit(self.source_linear_unit) / meters_per_unit(self.output_linear_unit)
                return x * factor, y * factor, z * factor
            return x, y, z

        ecef_x, ecef_y, ecef_z = local_to_ecef_arrays(x, y, z, self.geo_info)
        lon, lat, alt = self.source_crs_context["ecef_to_geographic"].transform(ecef_x, ecef_y, ecef_z)

        if self.transform_kind == "geographic":
            out_lon, out_lat, out_z = Transformer.from_crs(
                self.source_crs_context["geographic3d"], self.output_crs, always_xy=True
            ).transform(lon, lat, alt)
            if self.output_linear_unit != "m":
                out_z = out_z * meters_per_unit("m") / meters_per_unit(self.output_linear_unit)
            return out_lon, out_lat, out_z

        out_x, out_y, out_z = self.projected_transformer.transform(lon, lat, alt)

        raw_origin = self._project_origin_no_adjust()
        out_x, out_y, out_z = self._apply_manual_adjustment(out_x, out_y, out_z, raw_origin)

        if self.output_linear_unit != self.target_xy_unit:
            xy_factor = meters_per_unit(self.target_xy_unit) / meters_per_unit(self.output_linear_unit)
            out_x = out_x * xy_factor
            out_y = out_y * xy_factor

        if self.output_linear_unit != "m":
            z_factor = meters_per_unit("m") / meters_per_unit(self.output_linear_unit)
            out_z = out_z * z_factor

        return out_x, out_y, out_z

    def _project_origin_no_adjust(self):
        origin = self.geo_info["origin"]
        lon, lat, alt = self.source_crs_context["ecef_to_geographic"].transform(origin["x"], origin["y"], origin["z"])
        x0, y0 = self.projected_transformer.transform(lon, lat)
        return x0, y0, alt

    def _apply_manual_adjustment(self, x, y, z, origin_point):
        easting_offset = float(self.coord_config.get("eastingOffset") or 0.0)
        northing_offset = float(self.coord_config.get("northingOffset") or 0.0)
        height_offset = float(self.coord_config.get("heightOffset") or 0.0)
        rotation_deg = float(self.coord_config.get("rotationDeg") or 0.0)
        scale_ppm = float(self.coord_config.get("scalePpm") or 0.0)

        if not any(abs(v) > 1e-12 for v in (easting_offset, northing_offset, height_offset, rotation_deg, scale_ppm)):
            return x, y, z

        origin_x, origin_y, _origin_z = origin_point
        scale = 1.0 + scale_ppm * 1e-6
        rot = math.radians(rotation_deg)
        cos_r = math.cos(rot)
        sin_r = math.sin(rot)

        dx = (x - origin_x) * scale
        dy = (y - origin_y) * scale

        adjusted_x = origin_x + dx * cos_r - dy * sin_r + easting_offset
        adjusted_y = origin_y + dx * sin_r + dy * cos_r + northing_offset
        adjusted_z = z + height_offset
        return adjusted_x, adjusted_y, adjusted_z


def prepare_output_header(source_header, transformer):
    out_header = copy.deepcopy(source_header)
    out_header.version = laspy.header.Version(1, 4)
    out_header.scales = choose_output_scales(transformer.transform_kind, transformer.output_linear_unit)
    out_header.offsets = np.array([0.0, 0.0, 0.0], dtype=np.float64)
    out_header.vlrs = [copy.deepcopy(vlr) for vlr in source_header.vlrs if not is_crs_vlr(vlr)]

    if transformer.standard_crs_allowed and transformer.output_crs is not None:
        out_header.add_crs(transformer.output_crs, keep_compatibility=False)

    if transformer.include_export_vlr:
        summary = {
            **transformer.export_summary,
            "standardCrsWritten": transformer.standard_crs_allowed,
            "crsOmitReason": transformer.crs_omit_reason,
        }
        out_header.vlrs.append(
            laspy.VLR(
                user_id="potree-local",
                record_id=1,
                description="Export transform summary",
                record_data=sanitize_export_summary(summary),
            )
        )

    return out_header


def compute_bounds(input_path, transformer, chunk_size):
    min_x = min_y = min_z = None
    max_x = max_y = max_z = None
    deleted_points = 0
    clip_filtered_points = 0
    kept_points = 0

    with laspy.open(input_path) as reader:
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, delete_mask, clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            deleted_points += int(np.count_nonzero(delete_mask))
            clip_filtered_points += int(np.count_nonzero((~clip_keep_mask) & (~delete_mask)))
            if not np.any(keep_mask):
                continue
            src_x = chunk.x[keep_mask]
            src_y = chunk.y[keep_mask]
            src_z = chunk.z[keep_mask]
            if len(src_x) == 0:
                continue
            kept_points += len(src_x)
            x, y, z = transformer.transform_xyz(src_x, src_y, src_z)
            cx_min = float(np.min(x))
            cy_min = float(np.min(y))
            cz_min = float(np.min(z))
            cx_max = float(np.max(x))
            cy_max = float(np.max(y))
            cz_max = float(np.max(z))

            min_x = cx_min if min_x is None else min(min_x, cx_min)
            min_y = cy_min if min_y is None else min(min_y, cy_min)
            min_z = cz_min if min_z is None else min(min_z, cz_min)
            max_x = cx_max if max_x is None else max(max_x, cx_max)
            max_y = cy_max if max_y is None else max(max_y, cy_max)
            max_z = cz_max if max_z is None else max(max_z, cz_max)

    if min_x is None:
        raise ValueError("当前删除区域和裁剪盒过滤掉了全部点，无法导出空 LAS。请调整范围后重试。")

    return (
        np.array([min_x, min_y, min_z], dtype=np.float64),
        np.array([max_x, max_y, max_z], dtype=np.float64),
        deleted_points,
        clip_filtered_points,
        kept_points,
    )


def quantized_offsets(mins, scales):
    return np.floor(mins / scales) * scales


def write_output(input_path, output_path, transformer, out_header, chunk_size):
    written_points = 0
    with laspy.open(input_path) as reader, laspy.open(output_path, mode="w", header=out_header) as writer:
        for chunk in reader.chunk_iterator(chunk_size):
            keep_mask, _delete_mask, _clip_keep_mask = build_keep_mask(chunk.x, chunk.y, chunk.z, transformer)
            if not np.any(keep_mask):
                continue
            chunk_array = chunk.array[keep_mask].copy()
            if len(chunk_array) == 0:
                continue
            out_points = laspy.ScaleAwarePointRecord(chunk_array, out_header.point_format, out_header.scales, out_header.offsets)
            x, y, z = transformer.transform_xyz(chunk.x[keep_mask], chunk.y[keep_mask], chunk.z[keep_mask])
            out_points.x = x
            out_points.y = y
            out_points.z = z
            writer.write_points(out_points)
            written_points += len(chunk_array)
    return written_points


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Path to export config JSON")
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    input_path = config["inputPath"]
    output_path = config["outputPath"]
    chunk_size = int(config.get("chunkSize") or 500000)

    with laspy.open(input_path) as reader:
        source_header = reader.header
        transformer = ExportTransformer(config, source_header)
        out_header = prepare_output_header(source_header, transformer)

    mins, maxs, deleted_points, clip_filtered_points, kept_points = compute_bounds(input_path, transformer, chunk_size)
    out_header.offsets = quantized_offsets(mins, out_header.scales)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    written_points = write_output(input_path, output_path, transformer, out_header, chunk_size)

    result = {
        "ok": True,
        "outputPath": output_path,
        "standardCrsWritten": transformer.standard_crs_allowed,
        "crsOmitReason": transformer.crs_omit_reason,
        "outputLinearUnit": transformer.output_linear_unit,
        "transformKind": transformer.transform_kind,
        "mins": mins.tolist(),
        "maxs": maxs.tolist(),
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
