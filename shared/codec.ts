import type { WindGrid } from './types.ts';

/**
 * 传输编码：把体积最大的两份数据压小，浏览器端解码后与原格式完全一致。
 *  - 风场 u/v/降水按 0.1 量化成整数（brotli 后约省 35%）
 *  - 地级市边界坐标按 1e-3° 量化并做差分（brotli 后约省 60%）
 */
export const WIND_SCALE = 10;

export function encodeWind(w: WindGrid): WindGrid {
  if (w.scale) return w;
  const s = WIND_SCALE;
  const q = (a: number[][]) => a.map((r) => r.map((x) => Math.round(x * s)));
  return { ...w, scale: s, u: q(w.u), v: q(w.v), precip: q(w.precip) };
}

export function decodeWind(w: WindGrid): WindGrid {
  if (!w.scale) return w;
  const s = w.scale;
  const d = (a: number[][]) => a.map((r) => r.map((x) => x / s));
  const { scale: _scale, ...rest } = w;
  return { ...rest, u: d(w.u), v: d(w.v), precip: d(w.precip) };
}

/** 最小化的 GeoJSON 结构（服务端与浏览器端共用，避免依赖 @types/geojson） */
export interface PlainFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
export interface PlainFC {
  type: 'FeatureCollection';
  features: PlainFeature[];
}
export interface QuantizedFC {
  type: 'QuantizedFeatureCollection';
  q: number;
  /** polys[polygon][ring] = 扁平差分整数 [x0, y0, dx1, dy1, ...] */
  features: { properties: Record<string, unknown>; geom: 'Polygon' | 'MultiPolygon'; polys: number[][][] }[];
}

export function encodeBoundaries(fc: PlainFC, q = 1000): QuantizedFC {
  const encRing = (ring: number[][]): number[] => {
    const out: number[] = [];
    let px = NaN;
    let py = NaN;
    for (const [lng, lat] of ring) {
      const x = Math.round(lng * q);
      const y = Math.round(lat * q);
      if (x === px && y === py) continue; // 量化后重合的点丢掉
      if (out.length === 0) out.push(x, y);
      else out.push(x - px, y - py);
      px = x;
      py = y;
    }
    return out;
  };
  return {
    type: 'QuantizedFeatureCollection',
    q,
    features: fc.features.map((f) => {
      const g = f.geometry;
      const polys = (g.type === 'Polygon' ? [g.coordinates] : (g.coordinates as number[][][][])) as number[][][][];
      return { properties: f.properties, geom: g.type as 'Polygon' | 'MultiPolygon', polys: polys.map((p) => p.map(encRing)) };
    }),
  };
}

export function decodeBoundaries(qfc: QuantizedFC): PlainFC {
  const q = qfc.q;
  const decRing = (flat: number[]): number[][] => {
    const ring: number[][] = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      ring.push([x / q, y / q]);
    }
    // 保证闭合
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a && b && (a[0] !== b[0] || a[1] !== b[1])) ring.push([a[0], a[1]]);
    return ring;
  };
  return {
    type: 'FeatureCollection',
    features: qfc.features.map((f) => {
      const polys = f.polys.map((p) => p.map(decRing));
      return {
        type: 'Feature',
        properties: f.properties,
        geometry: f.geom === 'Polygon' ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys },
      };
    }),
  };
}
