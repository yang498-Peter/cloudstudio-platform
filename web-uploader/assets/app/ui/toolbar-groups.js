export const toolbarGroups = [
  {
    title: 'DATA',
    titleKey: 'viewer.toolbar.dataGroup',
    tone: 'data',
    items: [
      { id: 'tb-open', labelKey: 'viewer.toolbar.openLabel', label: 'Open', titleKey: 'viewer.toolbar.openTitle', title: 'Open Point Cloud', icon: 'open', action: 'open' },
      { id: 'tb-export-las', labelKey: 'viewer.toolbar.exportLabel', label: 'Export', titleKey: 'viewer.toolbar.exportTitle', title: 'Export Point Cloud', icon: 'export', action: 'export', capability: 'export' },
      { id: 'tb-ortho-image', labelKey: 'viewer.toolbar.orthoLabel', label: 'Ortho', titleKey: 'viewer.toolbar.orthoTitle', title: 'Export Ortho Image', icon: 'orthographic', action: 'ortho-image', capability: 'orthoImage' },
      { id: 'tb-coordinate-convert', labelKey: 'viewer.toolbar.coordinateConvertLabel', label: 'CRS', titleKey: 'viewer.toolbar.coordinateConvertTitle', title: 'Coordinate Convert', icon: 'crs-convert', action: 'coordinate-convert', capability: 'crs' },
      { id: 'tb-metacam-solver', labelKey: 'viewer.toolbar.metacamLabel', label: 'MVP', titleKey: 'viewer.toolbar.metacamTitle', title: 'MVP S1 Raw Data Solve', icon: 'mvp-s1', action: 'mvp-s1', capability: 'mvpSolver' },
      { id: 'tb-screenshot', labelKey: 'viewer.toolbar.screenshotLabel', label: 'Screenshot', titleKey: 'viewer.toolbar.screenshotTitle', title: 'Screenshot', icon: 'screenshot', action: 'screenshot', capability: 'capture' },
    ],
  },
  {
    title: 'NAVIGATE',
    titleKey: 'viewer.toolbar.navigateGroup',
    tone: 'navigate',
    items: [
      { id: 'tb-orbit', labelKey: 'viewer.toolbar.orbitLabel', label: 'Pick Orbit', titleKey: 'viewer.toolbar.orbitTitle', title: 'Orbit Navigation', icon: 'orbit-pick', action: 'orbit', active: true },
      { id: 'tb-fly', labelKey: 'viewer.toolbar.flyLabel', label: 'Fly', titleKey: 'viewer.toolbar.flyTitle', title: 'Fly Navigation', icon: 'fly', action: 'fly' },
    ],
  },
  {
    title: 'MEASURE',
    titleKey: 'viewer.toolbar.measureGroup',
    tone: 'measure',
    items: [
      { id: 'tb-point', labelKey: 'viewer.toolbar.pointLabel', label: 'Point', titleKey: 'viewer.toolbar.pointTitle', title: 'Point Coordinate Measure', icon: 'point', action: 'measure-point', tool: 'point', capability: 'measurement' },
      { id: 'tb-dist', labelKey: 'viewer.toolbar.distanceLabel', label: 'Distance', titleKey: 'viewer.toolbar.distanceTitle', title: 'Distance Measure', icon: 'distance', action: 'measure-distance', tool: 'distance', capability: 'measurement' },
      { id: 'tb-height', labelKey: 'viewer.toolbar.heightLabel', label: 'Height', titleKey: 'viewer.toolbar.heightTitle', title: 'Height Measure', icon: 'height', action: 'measure-height', tool: 'height', capability: 'measurement' },
      { id: 'tb-area', labelKey: 'viewer.toolbar.areaLabel', label: 'Area', titleKey: 'viewer.toolbar.areaTitle', title: 'Area Measure', icon: 'area', action: 'measure-area', tool: 'area', capability: 'measurement' },
      { id: 'tb-angle', labelKey: 'viewer.toolbar.angleLabel', label: 'Angle', titleKey: 'viewer.toolbar.angleTitle', title: 'Angle Measure', icon: 'angle', action: 'measure-angle', tool: 'angle', capability: 'measurement' },
    ],
  },
  {
    title: 'ANNOTATE',
    titleKey: 'viewer.toolbar.annotateGroup',
    tone: 'annotate',
    items: [
      { id: 'tb-volume', labelKey: 'viewer.toolbar.volumeLabel', label: 'Volume', titleKey: 'viewer.toolbar.volumeTitle', title: 'Volume Measure', icon: 'volume', action: 'volume', tool: 'volume', capability: 'volumeJobs' },
      { id: 'tb-capture', labelKey: 'viewer.capture.toolLabel', label: 'Capture', titleKey: 'viewer.toolbar.captureTitle', title: 'Point Capture', icon: 'capture', action: 'capture', tool: 'capture', capability: 'capture' },
    ],
  },
  {
    title: 'CLIP & REGION',
    titleKey: 'viewer.toolbar.clipRegionGroup',
    tone: 'clip',
    items: [
      { id: 'tb-clipbox', labelKey: 'viewer.toolbar.clipBoxLabel', label: 'Clip Box', titleKey: 'viewer.toolbar.clipBoxTitle', title: 'Clip Box', icon: 'clip-box', action: 'clip-box', tool: 'clipbox', capability: 'clipBox' },
      { id: 'tb-delete-poly', labelKey: 'viewer.toolbar.deleteRegionLabel', label: 'Delete Region', titleKey: 'viewer.toolbar.deleteRegionTitle', title: 'Delete Region', icon: 'delete-region', action: 'delete-region', tool: 'polygon-delete', capability: 'deleteRegion' },
      { id: 'tb-profile', labelKey: 'viewer.toolbar.profileLabel', label: 'Profile', titleKey: 'viewer.toolbar.profileTitle', title: 'Section / Profile', icon: 'profile', action: 'profile', tool: 'profile', capability: 'profile' },
      { id: 'tb-clearclip', labelKey: 'viewer.toolbar.clearClipLabel', label: 'Clear Clip', titleKey: 'viewer.toolbar.clearClipTitle', title: 'Clear Clipping', icon: 'clear', action: 'clear-clip', capability: 'clipBox' },
    ],
  },
  {
    title: 'PROCESS',
    titleKey: 'viewer.toolbar.processGroup',
    tone: 'process',
    items: [
      { id: 'tb-terrain-gc', labelKey: 'viewer.terrainToolbar.gcLabel', label: 'Ground', titleKey: 'viewer.terrainToolbar.gcTitle', title: 'Ground Classification', icon: 'ground', action: 'terrain-gc', terrainTab: 'gc', capability: 'terrainProcessing' },
    ],
  },
  {
    title: 'LEGACY',
    titleKey: 'viewer.toolbar.legacyGroup',
    tone: 'legacy',
    hidden: true,
    items: [
      { id: 'tb-edl', labelKey: 'viewer.toolbar.edlLabel', label: 'EDL', titleKey: 'viewer.toolbar.edlTitle', title: 'Eye-Dome Lighting', icon: 'edl', action: 'edl', active: true },
      { id: 'tb-fit', labelKey: 'viewer.toolbar.fitLabel', label: 'Fit', titleKey: 'viewer.toolbar.fitTitle', title: 'Fit View', icon: 'fit', action: 'fit', shortcut: 'F' },
      { id: 'tb-col-rgb', labelKey: 'viewer.toolbar.rgbLabel', label: 'RGB', titleKey: 'viewer.toolbar.rgbTitle', title: 'RGB Color', icon: 'rgb', action: 'color-rgb', attr: 'rgba', active: true, className: 'color-btn' },
      { id: 'tb-col-elev', labelKey: 'viewer.toolbar.elevationLabel', label: 'Elevation', titleKey: 'viewer.toolbar.elevationTitle', title: 'Elevation Coloring', icon: 'elevation', action: 'color-elevation', attr: 'elevation', className: 'color-btn' },
      { id: 'tb-col-int', labelKey: 'viewer.toolbar.intensityLabel', label: 'Intensity', titleKey: 'viewer.toolbar.intensityTitle', title: 'Intensity Coloring', icon: 'intensity', action: 'color-intensity', attr: 'intensity', className: 'color-btn' },
      { id: 'tb-col-cls', labelKey: 'viewer.toolbar.classificationLabel', label: 'Classification', titleKey: 'viewer.toolbar.classificationTitle', title: 'Classification Coloring', icon: 'classification', action: 'color-classification', attr: 'classification', className: 'color-btn' },
      { id: 'tb-terrain-dtm', labelKey: 'viewer.terrainToolbar.dtmLabel', label: 'Elevation Model', titleKey: 'viewer.terrainToolbar.dtmTitle', title: 'Elevation Model', icon: 'model', action: 'terrain-dtm', terrainTab: 'dtm', capability: 'terrainProcessing' },
      { id: 'tb-terrain-contour', labelKey: 'viewer.terrainToolbar.contourLabel', label: 'Contours', titleKey: 'viewer.terrainToolbar.contourTitle', title: 'Contours', icon: 'contour', action: 'terrain-contour', terrainTab: 'contour', capability: 'terrainProcessing' },
    ],
  },
];
