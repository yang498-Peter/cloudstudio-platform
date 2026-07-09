function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizePoint2D(point = {}) {
  return {
    x: toFiniteNumber(point?.x ?? point?.[0]),
    y: toFiniteNumber(point?.y ?? point?.[1]),
  };
}

export function getStablePolygonOrigin2D(points = []) {
  const first = Array.isArray(points) && points.length ? normalizePoint2D(points[0]) : { x: 0, y: 0 };
  return { x: first.x, y: first.y };
}

export function computePolygonSignedArea2D(points = []) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const normalized = points.map(normalizePoint2D);
  const origin = getStablePolygonOrigin2D(normalized);
  let area2 = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[(index + 1) % normalized.length];
    const ax = current.x - origin.x;
    const ay = current.y - origin.y;
    const bx = next.x - origin.x;
    const by = next.y - origin.y;
    area2 += ax * by - bx * ay;
  }
  return area2 * 0.5;
}

export function computePolygonArea2D(points = []) {
  return Math.abs(computePolygonSignedArea2D(points));
}

export function computePolygonCentroid2D(points = []) {
  if (!Array.isArray(points) || !points.length) return { x: 0, y: 0 };
  const normalized = points.map(normalizePoint2D);
  const origin = getStablePolygonOrigin2D(normalized);
  let area2 = 0;
  let cx = 0;
  let cy = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[(index + 1) % normalized.length];
    const ax = current.x - origin.x;
    const ay = current.y - origin.y;
    const bx = next.x - origin.x;
    const by = next.y - origin.y;
    const cross = ax * by - bx * ay;
    area2 += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }

  if (Math.abs(area2) < 1e-18) {
    const sum = normalized.reduce((acc, point) => ({
      x: acc.x + point.x,
      y: acc.y + point.y,
    }), { x: 0, y: 0 });
    return {
      x: sum.x / normalized.length,
      y: sum.y / normalized.length,
    };
  }

  return {
    x: origin.x + cx / (3 * area2),
    y: origin.y + cy / (3 * area2),
  };
}

export function computePolygonBounds2D(points = []) {
  if (!Array.isArray(points) || !points.length) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  points.map(normalizePoint2D).forEach((point) => {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  });
  return bounds;
}
