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
