import type { WindGrid } from '../../shared/types.ts';

export interface WindSample {
  u: number;
  v: number;
  p: number;
  speed: number;
}

/** 风场网格的时空双线性采样 */
export class WindField {
  readonly grid: WindGrid;
  readonly nT: number;

  constructor(grid: WindGrid) {
    this.grid = grid;
    this.nT = grid.times.length;
  }

  inBounds(lat: number, lng: number): boolean {
    const [x0, y0, x1, y1] = this.grid.bbox;
    return lng >= x0 && lng <= x1 && lat >= y0 && lat <= y1;
  }

  /** unix 秒 → 小数时间索引（夹在 0..nT-1） */
  timeIndex(epochSec: number): number {
    const t = this.grid.times;
    if (this.nT < 2 || epochSec <= t[0]) return 0;
    if (epochSec >= t[this.nT - 1]) return this.nT - 1;
    return (epochSec - t[0]) / (t[1] - t[0]);
  }

  sample(lat: number, lng: number, tIdx: number, out?: WindSample): WindSample | null {
    const g = this.grid;
    const fx = (lng - g.bbox[0]) / g.step;
    const fy = (lat - g.bbox[1]) / g.step;
    if (!(fx >= 0 && fy >= 0 && fx <= g.nx - 1 && fy <= g.ny - 1)) return null;
    let ix = Math.floor(fx);
    let iy = Math.floor(fy);
    if (ix >= g.nx - 1) ix = g.nx - 2;
    if (iy >= g.ny - 1) iy = g.ny - 2;
    const tx = fx - ix;
    const ty = fy - iy;
    let t0 = Math.floor(tIdx);
    if (t0 < 0) t0 = 0;
    if (t0 > this.nT - 1) t0 = this.nT - 1;
    const t1 = Math.min(t0 + 1, this.nT - 1);
    const ft = Math.min(1, Math.max(0, tIdx - t0));
    const i00 = iy * g.nx + ix;
    const i10 = i00 + 1;
    const i01 = i00 + g.nx;
    const i11 = i01 + 1;
    const bil = (a: number[]) => (a[i00] * (1 - tx) + a[i10] * tx) * (1 - ty) + (a[i01] * (1 - tx) + a[i11] * tx) * ty;
    const u = bil(g.u[t0]) * (1 - ft) + bil(g.u[t1]) * ft;
    const v = bil(g.v[t0]) * (1 - ft) + bil(g.v[t1]) * ft;
    const p = bil(g.precip[t0]) * (1 - ft) + bil(g.precip[t1]) * ft;
    const o = out ?? { u: 0, v: 0, p: 0, speed: 0 };
    o.u = u;
    o.v = v;
    o.p = p;
    o.speed = Math.hypot(u, v);
    return o;
  }
}
