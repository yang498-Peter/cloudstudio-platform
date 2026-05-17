#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from pathlib import Path

from pyproj import CRS, Transformer


WGS84_2D = CRS.from_epsg(4326)
WGS84_3D = CRS.from_epsg(4979)


def try_horizontal_grid(path_str):
    transformer = Transformer.from_pipeline(f"+proj=hgridshift +grids={path_str}")
    transformer.transform(0.0, 0.0, errcheck=False)
    return {
        "capability": "horizontal",
        "usageHint": "nadgrids",
        "browserCompatible": True,
        "engine": "proj-hgridshift",
    }


def try_vertical_grid(path_str):
    target = CRS.from_user_input(f"+proj=longlat +datum=WGS84 +geoidgrids={path_str} +type=crs")
    transformer = Transformer.from_crs(WGS84_3D, target, always_xy=True)
    transformer.transform(0.0, 0.0, 0.0, errcheck=False)
    return {
        "capability": "vertical",
        "usageHint": "geoidgrids",
        "browserCompatible": False,
        "engine": "proj-geoidgrids",
    }


def try_general_grid(path_str):
    transformer = Transformer.from_pipeline(f"+proj=gridshift +grids={path_str}")
    transformer.transform(0.0, 0.0, 0.0, errcheck=False)
    return {
        "capability": "general",
        "usageHint": "grids",
        "browserCompatible": False,
        "engine": "proj-gridshift",
    }


def inspect_grid_file(path_str):
    path = Path(path_str).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Grid file not found: {path}")
    if not path.is_file():
        raise ValueError(f"Not a file: {path}")

    ext = path.suffix.lower().lstrip(".")
    candidates = []
    if ext == "gsb":
        candidates = [try_horizontal_grid]
    elif ext == "gtx":
        candidates = [try_vertical_grid]
    elif ext in {"tif", "tiff"}:
        candidates = [try_vertical_grid, try_horizontal_grid, try_general_grid]
    elif ext in {"ggf", "grd"}:
        candidates = [try_vertical_grid, try_horizontal_grid, try_general_grid]
    else:
        raise ValueError(f"Unsupported grid file extension: .{ext}")

    filename = path.name.lower()

    successes = []
    failures = []
    for tester in candidates:
        try:
            successes.append(tester(str(path)))
        except Exception as error:
            failures.append(f"{tester.__name__}: {error}")

    if not successes:
        raise ValueError(
            "PROJ could not validate this grid file. "
            + ("; ".join(failures) if failures else "Unknown validation failure.")
        )

    capabilities = []
    usage_hint = None
    browser_compatible = False
    engines = []
    for result in successes:
        capability = result["capability"]
        if capability not in capabilities:
            capabilities.append(capability)
        usage_hint = usage_hint or result["usageHint"]
        browser_compatible = browser_compatible or bool(result.get("browserCompatible"))
        engines.append(result["engine"])

    # Some NOAA GeoTIFF grids validate through multiple PROJ paths.
    # Prefer the capability that matches the known family of the file
    # instead of blindly picking vertical first for every TIFF.
    if "nadcon" in filename or "hpgn" in filename:
        preferred_order = ["horizontal", "general", "vertical"]
    elif (
        "geoid" in filename
        or "egm" in filename
        or "sageoid" in filename
        or "hbg" in filename
        or "raf" in filename
        or re.search(r"g(?:1999|2003|2009|2012|2018)[a-z0-9]+", filename)
    ):
        preferred_order = ["vertical", "general", "horizontal"]
    else:
        preferred_order = ["vertical", "horizontal", "general"]
    capabilities.sort(key=lambda item: preferred_order.index(item) if item in preferred_order else 99)
    primary = capabilities[0]
    if primary == "general":
        usage_hint = "grids"
    elif primary == "horizontal":
        usage_hint = "nadgrids"
    elif primary == "vertical":
        usage_hint = "geoidgrids"

    return {
        "ok": True,
        "fileName": path.name,
        "ext": ext,
        "sizeBytes": path.stat().st_size,
        "capabilities": capabilities,
        "primaryCapability": primary,
        "usageHint": usage_hint,
        "browserCompatible": browser_compatible,
        "engines": engines,
        "note": "Validated with native PROJ/pyproj.",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True, help="Grid file path")
    args = parser.parse_args()

    result = inspect_grid_file(args.path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
