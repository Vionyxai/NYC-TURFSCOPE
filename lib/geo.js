// Minimal geometry helpers (lon/lat order, GeoJSON conventions).

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(pt, rings) {
  if (!pointInRing(pt, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(pt, rings[k])) return false; // holes
  return true;
}

export function pointInGeometry(pt, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolygon(pt, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((p) => pointInPolygon(pt, p));
  return false;
}

export function pointInFeatureCollection(pt, fc) {
  return fc.features.some((f) => pointInGeometry(pt, f.geometry));
}

export function roundGeometry(geom, digits = 5) {
  const f = 10 ** digits;
  const r = (a) => (typeof a[0] === 'number' ? [Math.round(a[0] * f) / f, Math.round(a[1] * f) / f] : a.map(r));
  return { ...geom, coordinates: r(geom.coordinates) };
}

export function bbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (a) => {
    if (typeof a[0] === 'number') {
      if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0];
      if (a[1] < minY) minY = a[1]; if (a[1] > maxY) maxY = a[1];
    } else a.forEach(walk);
  };
  walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// Approximate share of `geom` covered by `other`, by sampling an n×n grid over geom's bbox.
// Good enough for "is most of this tract inside the village?" without a geometry library.
export function shareInside(geom, other, n = 16) {
  const a = bbox(geom);
  if (!overlaps(a, bbox(other))) return 0;
  let inside = 0, both = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const pt = [a[0] + ((i + 0.5) / n) * (a[2] - a[0]), a[1] + ((j + 0.5) / n) * (a[3] - a[1])];
      if (!pointInGeometry(pt, geom)) continue;
      inside++;
      if (pointInGeometry(pt, other)) both++;
    }
  }
  return inside ? both / inside : 0;
}
