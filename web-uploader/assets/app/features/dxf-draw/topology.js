export const DRAW_SNAP_THRESHOLD_PX = 14;
export const EDIT_SNAP_THRESHOLD_PX = 14;
export const ENDPOINT_LINK_EPSILON = 0.001;

export function computeLineEndpoints(lineType, pointA, pointB, draggedIndex = -1) {
  if (!pointA || !pointB) return null;

  if (lineType === 'vertical') {
    const src = draggedIndex < 0 ? pointA : (draggedIndex === 0 ? pointA : pointB);
    return {
      p1: { x: src.x, y: src.y, z: pointA.z },
      p2: { x: src.x, y: src.y, z: pointB.z },
    };
  }

  if (lineType === 'horizontal') {
    const src = draggedIndex < 0 ? pointA : (draggedIndex === 0 ? pointA : pointB);
    return {
      p1: { x: pointA.x, y: pointA.y, z: src.z },
      p2: { x: pointB.x, y: pointB.y, z: src.z },
    };
  }

  return {
    p1: { x: pointA.x, y: pointA.y, z: pointA.z },
    p2: { x: pointB.x, y: pointB.y, z: pointB.z },
  };
}

export function positionsCoincide(a, b, epsilon = ENDPOINT_LINK_EPSILON) {
  if (!a || !b) return false;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= epsilon;
}

export function dedupeLinkEntries(entries = []) {
  const bySphere = new Map();
  for (const entry of entries) {
    const sphereUuid = entry?.sphere?.uuid;
    if (!sphereUuid || bySphere.has(sphereUuid)) continue;
    bySphere.set(sphereUuid, entry);
  }
  return [...bySphere.values()];
}

export function clusterLinkEntries(entries = [], getPosition, epsilon = ENDPOINT_LINK_EPSILON) {
  const unique = dedupeLinkEntries(entries);
  const clusters = [];

  for (const entry of unique) {
    const entryPosition = getPosition(entry);
    let cluster = null;
    for (const candidate of clusters) {
      const candidatePosition = getPosition(candidate[0]);
      if (positionsCoincide(entryPosition, candidatePosition, epsilon)) {
        cluster = candidate;
        break;
      }
    }

    if (!cluster) {
      cluster = [];
      clusters.push(cluster);
    }
    cluster.push(entry);
  }

  return clusters;
}
