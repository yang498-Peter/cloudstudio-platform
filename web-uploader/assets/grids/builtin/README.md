# Built-In CRS Grid Assets

This directory is reserved for optional CRS grid files used by CloudStudio coordinate transformation tools.

Large `.tif` and `.tiff` grid files are intentionally ignored by Git. Provision them separately on each deployment target when CRS features require them. Small grid files such as `.gsb` and `.gtx` may remain in the repository when they are part of the default runtime package.

Use `../catalog.json` and `../BUILTIN_GRID_SOURCES.md` as the source of truth for expected file names, data providers, and licensing notes.
