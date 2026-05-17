export function normalizeVolumeHoleFillMode(mode = 'interpolate') {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'leave' || normalized === 'ignore') return 'ignore';
  if (normalized === 'reference' || normalized === 'fixed') return 'reference';
  return 'interpolate';
}

export function normalizeSurfaceBuildHoleMode(mode = 'interpolate') {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'reference' || normalized === 'fixed') return 'fixed';
  if (normalized === 'ignore' || normalized === 'leave') return 'leave';
  return 'interpolate';
}

export function resolveVolumeSurfaceProfile(surfaceType = 'stockpile', aggregateMode = 'p80') {
  const normalizedType = String(surfaceType || 'stockpile').trim().toLowerCase();
  const normalizedAggregate = String(aggregateMode || 'p80').trim().toLowerCase();

  if (normalizedType === 'dsm') {
    return { profile: 'max', usesGroundOnly: false };
  }

  if (normalizedType === 'dtm') {
    return { profile: 'ground', usesGroundOnly: true };
  }

  if (['p80', 'p85', 'median', 'max', 'min'].includes(normalizedAggregate)) {
    return { profile: normalizedAggregate, usesGroundOnly: false };
  }

  return { profile: 'p80', usesGroundOnly: false };
}

export function computeNetVolume(cutVolume, fillVolume) {
  if (!Number.isFinite(cutVolume) || !Number.isFinite(fillVolume)) return null;
  return Number(fillVolume) - Number(cutVolume);
}

function exactQuantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const t = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * t;
}

function createP2QuantileEstimator(q) {
  return {
    q,
    count: 0,
    initial: [],
    heights: null,
    positions: null,
    desiredPositions: null,
    increments: [0, q / 2, q, (1 + q) / 2, 1],
  };
}

function addP2Sample(estimator, value) {
  if (!Number.isFinite(value)) return;

  if (estimator.count < 5) {
    estimator.initial.push(value);
    estimator.count += 1;
    if (estimator.count === 5) {
      estimator.initial.sort((a, b) => a - b);
      estimator.heights = estimator.initial.slice();
      estimator.positions = [1, 2, 3, 4, 5];
      estimator.desiredPositions = [
        1,
        1 + 2 * estimator.q,
        1 + 4 * estimator.q,
        3 + 2 * estimator.q,
        5,
      ];
    }
    return;
  }

  estimator.count += 1;
  const heights = estimator.heights;
  const positions = estimator.positions;
  const desired = estimator.desiredPositions;

  let k = 0;
  if (value < heights[0]) {
    heights[0] = value;
    k = 0;
  } else if (value < heights[1]) {
    k = 0;
  } else if (value < heights[2]) {
    k = 1;
  } else if (value < heights[3]) {
    k = 2;
  } else if (value <= heights[4]) {
    k = 3;
  } else {
    heights[4] = value;
    k = 3;
  }

  for (let i = k + 1; i < 5; i += 1) {
    positions[i] += 1;
  }
  for (let i = 0; i < 5; i += 1) {
    desired[i] += estimator.increments[i];
  }

  for (let i = 1; i <= 3; i += 1) {
    const delta = desired[i] - positions[i];
    const canIncrease = delta >= 1 && positions[i + 1] - positions[i] > 1;
    const canDecrease = delta <= -1 && positions[i - 1] - positions[i] < -1;
    if (!canIncrease && !canDecrease) continue;

    const direction = Math.sign(delta);
    const prevPosition = positions[i - 1];
    const currentPosition = positions[i];
    const nextPosition = positions[i + 1];
    const prevHeight = heights[i - 1];
    const currentHeight = heights[i];
    const nextHeight = heights[i + 1];

    const parabolic = currentHeight + direction / (nextPosition - prevPosition) * (
      (currentPosition - prevPosition + direction) * (nextHeight - currentHeight) / (nextPosition - currentPosition) +
      (nextPosition - currentPosition - direction) * (currentHeight - prevHeight) / (currentPosition - prevPosition)
    );

    if (parabolic > prevHeight && parabolic < nextHeight) {
      heights[i] = parabolic;
    } else {
      heights[i] = currentHeight + direction * (heights[i + direction] - currentHeight) / (positions[i + direction] - currentPosition);
    }
    positions[i] += direction;
  }
}

function getP2Estimate(estimator) {
  if (!estimator || estimator.count === 0) return null;
  if (estimator.count <= 5 || !estimator.heights) {
    return exactQuantile(estimator.initial, estimator.q);
  }
  return estimator.heights[2];
}

export function createVolumeCellAccumulator({ profile = 'p80' } = {}) {
  const needsQuantile = ['p80', 'p85', 'median', 'ground'].includes(profile);
  return {
    count: 0,
    sumX: 0,
    sumY: 0,
    sumZ: 0,
    minZ: Infinity,
    maxZ: -Infinity,
    groundCount: 0,
    allQuantileEstimator: needsQuantile
      ? createP2QuantileEstimator(profile === 'p85' ? 0.85 : profile === 'median' ? 0.5 : profile === 'ground' ? 0.2 : 0.8)
      : null,
    groundQuantileEstimator: profile === 'ground'
      ? createP2QuantileEstimator(0.2)
      : null,
  };
}

export function addVolumeCellSample(cell, { x, y, z, isGround = false }) {
  cell.count += 1;
  cell.sumX += x;
  cell.sumY += y;
  cell.sumZ += z;
  cell.minZ = Math.min(cell.minZ, z);
  cell.maxZ = Math.max(cell.maxZ, z);
  if (cell.allQuantileEstimator) addP2Sample(cell.allQuantileEstimator, z);
  if (isGround && cell.groundQuantileEstimator) {
    cell.groundCount += 1;
    addP2Sample(cell.groundQuantileEstimator, z);
  } else if (isGround) {
    cell.groundCount += 1;
  }
}

export function getVolumeCellSurfaceElevation(cell, { profile = 'p80', useGroundSamples = false } = {}) {
  if (!cell || cell.count <= 0) return null;

  if (profile === 'ground') {
    if (useGroundSamples && cell.groundCount > 0) {
      return getP2Estimate(cell.groundQuantileEstimator);
    }
    if (useGroundSamples) return null;
    return getP2Estimate(cell.allQuantileEstimator);
  }

  if (profile === 'max') return cell.maxZ;
  if (profile === 'min') return cell.minZ;
  if (profile === 'median' || profile === 'p80' || profile === 'p85') {
    return getP2Estimate(cell.allQuantileEstimator);
  }

  return cell.sumZ / cell.count;
}

export function resolveVolumeRegionPointCloud(region, pointclouds = [], primaryPointCloud = null) {
  if (region?.pointcloud) return region.pointcloud;
  if (region?.pointcloudRef) return region.pointcloudRef;
  if (region?.pointcloudUuid) {
    const match = pointclouds.find(pointcloud => pointcloud?.uuid === region.pointcloudUuid);
    if (match) return match;
  }
  return primaryPointCloud || pointclouds[0] || null;
}

export function resolveVolumeRegionAttachObject(region, {
  pointcloud = null,
  scenePointCloud = null,
  scene = null,
  findObjectByUuid = null,
} = {}) {
  if (region?.attachObject) return region.attachObject;
  if (region?.attachObjectRef) return region.attachObjectRef;
  if (region?.attachParentUuid && typeof findObjectByUuid === 'function') {
    const matched = findObjectByUuid(region.attachParentUuid);
    if (matched) return matched;
  }
  return pointcloud?.parent || pointcloud || scenePointCloud || scene || null;
}
