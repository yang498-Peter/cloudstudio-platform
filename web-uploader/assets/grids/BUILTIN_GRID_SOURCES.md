# Built-in Grid Sources

This folder contains grid resources bundled with the product so region-specific workflows do not require customers to manually find and import their own files.

## Germany

- `de_adv_BETA2007.tif`
  - Horizontal deformation/support grid for Germany workflows.
  - Bundled from the project asset set already shipped with CloudStudio.

- `de_bkg_GCG2016v2023.gtx`
  - Vertical geoid grid for Germany height conversion workflows.
  - Stored in the product as a PROJ-compatible `GTX` file so the backend can attach it through `+geoidgrids=...`.
  - Source lineage:
    - validated from `GCG2016v2023.GGF`
    - converted to `GTX` as `GCG2016v2023_from_GGF.gtx`
  - Runtime reason:
    - raw `GGF` is not reliably importable by PROJ/pyproj
    - `GTX` is directly supported by the existing backend native PROJ pipeline
