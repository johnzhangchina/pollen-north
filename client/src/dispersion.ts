import type { EmissionPrior, LandcoverGrid, SeasonLevel } from '../../shared/types.ts';
import { levelIndexFor, midConcForLevel } from '../../shared/levels.ts';
import type { WindField, WindSample } from './windfield.ts';
import { M_PER_DEG_LAT, dayOfYearCN, epochAt08CN, hourCN, mPerDegLng, median, pointInPolygon } from './geo.ts';

/**
 * 简化的花粉扩散趋势推算（不是官方预报）：
 *   浓度(t+1) = 平流(浓度(t), 风) × (1 − 沉降 − 降水清除) + 排放(先验 × 物候 × 日变化 × 站点校准)
 * 排放先验是手工圈定的植被区，站点实测只用来标定排放强度（全局系数 + 反距离加权的局地修正）。
 */

export interface StationObs {
  code: string;
  name: string;
  lat: number;
  lng: number;
  levelCode: number;
  date: string; // YYYY-MM-DD，早 8 点镜检读数
}

export interface ModelParams {
  stepDeg: number; // 模型网格步长（度）
  transportFactor: number; // 10 m 风 → 输送层风的放大系数
  depositionPerHour: number; // 干沉降比例 / 小时
  washoutPerMm: number; // 每毫米降水的清除比例
  diffusion: number; // 数值扩散强度 0..0.5
  backgroundEmission: number; // 先验之外的底噪排放权重（让校准能补上先验漏掉的源）
  emissionUnit: number; // 排放尺度（任意单位，校准后无关）
}

export const defaultParams: ModelParams = {
  stepDeg: 0.25,
  transportFactor: 1.4,
  depositionPerHour: 0.08,
  washoutPerMm: 0.35,
  diffusion: 0.15,
  backgroundEmission: 0.03,
  emissionUnit: 40,
};

export interface StationFit {
  code: string;
  name: string;
  obsLevel: number;
  obsDate: string;
  modelConc: number;
  modelLevel: number;
  calibrated: boolean;
}

export interface ModelResult {
  nx: number;
  ny: number;
  step: number;
  bbox: [number, number, number, number];
  lons: Float64Array;
  lats: Float64Array;
  times: number[];
  conc: Float32Array[]; // [t] → 逐小时网格浓度（粒/千平方毫米 当量）
  daily: Float32Array[]; // [t] → 截至 t 的 24 h 均值，与实测日值同尺度（地图默认显示这个）
  emissionNow: Float32Array;
  calibration: Float32Array;
  nudge: Float32Array; // 浓度场局地修正系数
  globalFactor: number;
  stationFit: StationFit[];
  refEpoch: number | null;
  params: ModelParams;
  landcoverUsed: boolean;
}

/**
 * 物候（随纬度变化的粗略经验）：以北纬 40° 为基准，春季柏科/杨柳/榆以 4 月 6 日为中心，
 * 每往南 1° 提前约 2.2 天（广州约 2 月下旬）；秋季蒿属/藜科以 8 月 28 日为中心，往南略推后且拖得更长（葎草/豚草）。
 */
export function seasonWeights(epochSec: number, lat = 40): { autumn: number; spring: number } {
  const doy = dayOfYearCN(epochSec);
  const d = 40 - lat;
  const springC = Math.min(110, Math.max(45, 96 - 2.2 * d));
  const springS = d > 0 ? 16 + 0.3 * d : 16;
  const autumnC = Math.min(262, Math.max(232, 240 + 0.8 * d));
  const autumnS = d > 0 ? 14 + 0.4 * d : 14;
  const g = (c: number, s: number) => Math.exp(-0.5 * ((doy - c) / s) ** 2);
  return { autumn: g(autumnC, autumnS), spring: g(springC, springS) };
}

/** 日变化：上午 10 点前后释放最多 */
export function diurnalFactor(hour: number): number {
  return 0.3 + 0.7 * Math.exp(-(((hour - 10) / 4) ** 2));
}

export function runModel(
  field: WindField,
  priors: EmissionPrior[],
  stations: StationObs[],
  params: ModelParams,
  levels: SeasonLevel[],
  landcover: LandcoverGrid | null = null,
): ModelResult {
  const bbox = field.grid.bbox;
  const [lon0, lat0, lon1, lat1] = bbox;
  const step = params.stepDeg;
  const nx = Math.max(2, Math.floor((lon1 - lon0) / step + 1e-9) + 1);
  const ny = Math.max(2, Math.floor((lat1 - lat0) / step + 1e-9) + 1);
  const N = nx * ny;
  const lons = new Float64Array(nx);
  const lats = new Float64Array(ny);
  for (let ix = 0; ix < nx; ix++) lons[ix] = lon0 + ix * step;
  for (let iy = 0; iy < ny; iy++) lats[iy] = lat0 + iy * step;

  // ---- 排放源 ----
  // 有植被数据时：排放 = 植被当量 × (0.3 + 手工先验权重)。植被决定"哪里有草/树"，
  // 手工圈定的蒿属/藜科集中区只做放大，圈外仍按植被给底值；没有植被数据时退回只用多边形。
  const lcAt = landcover ? makeLandcoverSampler(landcover, step) : null;
  const EA = new Float32Array(N);
  const ES = new Float32Array(N);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iy * nx + ix;
      let pa = 0;
      let ps = 0;
      for (const p of priors) {
        if (!pointInPolygon(lons[ix], lats[iy], p.polygon)) continue;
        if (p.season === 'autumn') pa = Math.max(pa, p.weight);
        else ps = Math.max(ps, p.weight);
      }
      if (lcAt) {
        const f = lcAt(lons[ix], lats[iy]);
        // 秋季蒿属/藜科：草地为主，荒漠草原（稀疏植被）、灌丛、收后农田次之
        const vegA = f.grass + 0.6 * f.shrub + 0.45 * f.bare + 0.5 * f.crops + 0.05 * f.tree;
        // 春季柏/杨柳/榆：林地和城市绿化
        const vegS = f.tree + 0.7 * f.builtup + 0.3 * f.shrub + 0.1 * f.grass;
        EA[i] = vegA * (0.3 + pa) + params.backgroundEmission * 0.5;
        ES[i] = vegS * (0.3 + ps) + params.backgroundEmission * 0.5;
      } else {
        EA[i] = Math.max(params.backgroundEmission, pa);
        ES[i] = Math.max(params.backgroundEmission, ps);
      }
    }
  }

  const times = field.grid.times;
  const nT = times.length;

  const sampleGrid = (C: Float32Array, lng: number, lat: number): number => {
    const fx = (lng - lon0) / step;
    const fy = (lat - lat0) / step;
    if (!(fx >= 0 && fy >= 0 && fx <= nx - 1 && fy <= ny - 1)) return 0;
    let ix = Math.floor(fx);
    let iy = Math.floor(fy);
    if (ix >= nx - 1) ix = nx - 2;
    if (iy >= ny - 1) iy = ny - 2;
    const tx = fx - ix;
    const ty = fy - iy;
    const i00 = iy * nx + ix;
    return (C[i00] * (1 - tx) + C[i00 + 1] * tx) * (1 - ty) + (C[i00 + nx] * (1 - tx) + C[i00 + nx + 1] * tx) * ty;
  };

  const k = params.diffusion / 4;
  const diffuse = (C: Float32Array): Float32Array => {
    const D = new Float32Array(N);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix;
        const c = C[i];
        const l = ix > 0 ? C[i - 1] : c;
        const r = ix < nx - 1 ? C[i + 1] : c;
        const d = iy > 0 ? C[i - nx] : c;
        const u = iy < ny - 1 ? C[i + nx] : c;
        D[i] = (1 - 4 * k) * c + k * (l + r + d + u);
      }
    }
    return D;
  };

  const integrate = (cal: Float32Array | null): Float32Array[] => {
    const out: Float32Array[] = [];
    let C: Float32Array = new Float32Array(N);
    {
      // 起始场：用 t0 的排放 / 沉降 做无输送平衡态，避免前十几个小时从 0 慢慢爬升的假象
      const di0 = 0.55; // 日变化的日均值近似
      for (let iy = 0; iy < ny; iy++) {
        const sw0 = seasonWeights(times[0] + 1800, lats[iy]);
        for (let ix = 0; ix < nx; ix++) {
          const i = iy * nx + ix;
          C[i] = ((EA[i] * sw0.autumn + ES[i] * sw0.spring) * di0 * params.emissionUnit * (cal ? cal[i] : 1)) / params.depositionPerHour;
        }
      }
    }
    const smp: WindSample = { u: 0, v: 0, p: 0, speed: 0 };
    for (let t = 0; t < nT; t++) {
      out.push(C);
      if (t === nT - 1) break;
      const epochMid = times[t] + 1800;
      const di = diurnalFactor(hourCN(epochMid));
      const tMid = t + 0.5;
      const next = new Float32Array(N);
      for (let iy = 0; iy < ny; iy++) {
        const lat = lats[iy];
        const mLng = mPerDegLng(lat);
        const sw = seasonWeights(epochMid, lat);
        for (let ix = 0; ix < nx; ix++) {
          const i = iy * nx + ix;
          const lng = lons[ix];
          const w = field.sample(lat, lng, tMid, smp);
          let adv: number;
          if (w) {
            const dx = (w.u * params.transportFactor * 3600) / mLng;
            const dy = (w.v * params.transportFactor * 3600) / M_PER_DEG_LAT;
            adv = sampleGrid(C, lng - dx, lat - dy);
            const loss = Math.min(0.95, params.depositionPerHour + params.washoutPerMm * Math.max(0, w.p));
            adv *= 1 - loss;
          } else {
            adv = C[i] * (1 - params.depositionPerHour);
          }
          const e = (EA[i] * sw.autumn + ES[i] * sw.spring) * di * params.emissionUnit * (cal ? cal[i] : 1);
          next[i] = adv + e;
        }
      }
      C = k > 0 ? diffuse(next) : next;
    }
    return out;
  };

  const pass1 = integrate(null);

  // ---- 站点校准：实测 08:00 读数 ≈ 前 24 小时模型均值 ----
  interface Ref {
    st: StationObs;
    tIdx: number[];
    T: number;
  }
  const refs: Ref[] = [];
  let refEpoch: number | null = null;
  for (const st of stations) {
    if (!field.inBounds(st.lat, st.lng) || st.levelCode <= 0) continue;
    const ref = epochAt08CN(st.date);
    const idx: number[] = [];
    for (let t = 0; t < nT; t++) if (times[t] > ref - 24 * 3600 && times[t] <= ref) idx.push(t);
    if (idx.length < 6) continue;
    refs.push({ st, tIdx: idx, T: midConcForLevel(st.levelCode, levels) });
    refEpoch = Math.max(refEpoch ?? 0, ref);
  }
  const meanAt = (pass: Float32Array[], r: Ref) => {
    let s = 0;
    for (const t of r.tIdx) s += sampleGrid(pass[t], r.st.lng, r.st.lat);
    return s / r.tIdx.length;
  };
  const m1 = refs.map((r) => meanAt(pass1, r));
  const ratios: number[] = [];
  refs.forEach((r, j) => {
    if (m1[j] > 1e-6) ratios.push(r.T / m1[j]);
  });
  let g = ratios.length ? median(ratios) : 1;
  g = Math.min(1e4, Math.max(1e-4, g));
  const LNMAX = Math.log(6); // 局地修正最多 ×6 / ÷6
  const pts = refs.map((r, j) => ({
    lng: r.st.lng,
    lat: r.st.lat,
    r: m1[j] > 1e-6 ? Math.min(LNMAX, Math.max(-LNMAX, Math.log(r.T / (g * m1[j])))) : LNMAX,
  }));
  const cal = new Float32Array(N);
  const w0 = 1 / (2.5 * 2.5); // 远离站点处回归先验
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      let num = 0;
      let den = w0;
      for (const p of pts) {
        const d2 = (p.lng - lons[ix]) ** 2 + (p.lat - lats[iy]) ** 2;
        const w = 1 / (d2 + 0.05);
        num += w * p.r;
        den += w;
      }
      cal[iy * nx + ix] = g * Math.exp(num / den);
    }
  }

  const pass2 = integrate(cal);

  // ---- 第三步：浓度场局地修正 ----
  // 排放校准只能调源强；站点若处在大源的下风向（比如被内蒙古中西部包围的银川），浓度仍会被邻区顶高。
  // 这里按站点实测对浓度本身再做一次反距离加权的乘性修正（作用半径约 1°），保证站点处的 24 h 均值落回实测等级。
  const LN_NUDGE = Math.log(3);
  const pts2 = refs.map((r) => {
    const mc = meanAt(pass2, r);
    return { lng: r.st.lng, lat: r.st.lat, r: mc > 1e-6 ? Math.min(LN_NUDGE, Math.max(-LN_NUDGE, Math.log(r.T / mc))) : 0 };
  });
  const nudge = new Float32Array(N);
  const w0n = 1 / (1.2 * 1.2);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      let num = 0;
      let den = w0n;
      for (const p of pts2) {
        const d2 = (p.lng - lons[ix]) ** 2 + (p.lat - lats[iy]) ** 2;
        const w = 1 / (d2 + 0.02);
        num += w * p.r;
        den += w;
      }
      nudge[iy * nx + ix] = Math.exp(num / den);
    }
  }
  const conc = pass2.map((C) => {
    const o = new Float32Array(N);
    for (let i = 0; i < N; i++) o[i] = C[i] * nudge[i];
    return o;
  });

  // ---- 24 h 滑动均值：实测是"日值"，地图默认显示同尺度的量，避免午后瞬时峰值把"高"画成"很高" ----
  const daily: Float32Array[] = [];
  const acc = new Float64Array(N);
  for (let t = 0; t < nT; t++) {
    const Ct = conc[t];
    for (let i = 0; i < N; i++) acc[i] += Ct[i];
    if (t >= 24) {
      const Co = conc[t - 24];
      for (let i = 0; i < N; i++) acc[i] -= Co[i];
    }
    const n = Math.min(t + 1, 24);
    const D = new Float32Array(N);
    for (let i = 0; i < N; i++) D[i] = acc[i] / n;
    daily.push(D);
  }

  const stationFit: StationFit[] = refs.map((r, j) => {
    const mc = meanAt(conc, r);
    return {
      code: r.st.code,
      name: r.st.name,
      obsLevel: r.st.levelCode,
      obsDate: r.st.date,
      modelConc: mc,
      modelLevel: levelIndexFor(mc, levels),
      calibrated: m1[j] > 1e-6,
    };
  });

  const emissionNow = new Float32Array(N);
  for (let iy = 0; iy < ny; iy++) {
    const swNow = seasonWeights(Date.now() / 1000, lats[iy]);
    for (let ix = 0; ix < nx; ix++) emissionNow[iy * nx + ix] = EA[iy * nx + ix] * swNow.autumn + ES[iy * nx + ix] * swNow.spring;
  }

  return { nx, ny, step, bbox, lons, lats, times, conc, daily, emissionNow, calibration: cal, nudge, globalFactor: g, stationFit, refEpoch, params, landcoverUsed: !!lcAt };
}

export type ConcKind = 'daily' | 'hourly';

/** bbox 内网格均值浓度（默认 24 h 均值） */
export function meanConcInBbox(m: ModelResult, t: number, bbox: [number, number, number, number], kind: ConcKind = 'daily'): number | null {
  const tt = Math.min(m.conc.length - 1, Math.max(0, Math.round(t)));
  const C = kind === 'daily' ? m.daily[tt] : m.conc[tt];
  let s = 0;
  let n = 0;
  for (let iy = 0; iy < m.ny; iy++) {
    if (m.lats[iy] < bbox[1] || m.lats[iy] > bbox[3]) continue;
    for (let ix = 0; ix < m.nx; ix++) {
      if (m.lons[ix] < bbox[0] || m.lons[ix] > bbox[2]) continue;
      s += C[iy * m.nx + ix];
      n++;
    }
  }
  return n ? s / n : null;
}

/** 某时刻某点的推算浓度（双线性，默认 24 h 均值）；点在网格外返回 null */
export function concAt(m: ModelResult, t: number, lng: number, lat: number, kind: ConcKind = 'daily'): number | null {
  const tt = Math.min(m.conc.length - 1, Math.max(0, Math.round(t)));
  const fx = (lng - m.bbox[0]) / m.step;
  const fy = (lat - m.bbox[1]) / m.step;
  if (!(fx >= 0 && fy >= 0 && fx <= m.nx - 1 && fy <= m.ny - 1)) return null;
  let ix = Math.floor(fx);
  let iy = Math.floor(fy);
  if (ix >= m.nx - 1) ix = m.nx - 2;
  if (iy >= m.ny - 1) iy = m.ny - 2;
  const tx = fx - ix;
  const ty = fy - iy;
  const C = kind === 'daily' ? m.daily[tt] : m.conc[tt];
  const i00 = iy * m.nx + ix;
  return (C[i00] * (1 - tx) + C[i00 + 1] * tx) * (1 - ty) + (C[i00 + m.nx] * (1 - tx) + C[i00 + m.nx + 1] * tx) * ty;
}

type LcFractions = { grass: number; shrub: number; crops: number; builtup: number; bare: number; tree: number; wetland: number; other: number };

/** 模型格点处的土地覆盖占比（0..1）：取以格点为中心、边长 = 模型步长的方框内所有植被格子的平均 */
function makeLandcoverSampler(lc: LandcoverGrid, modelStep: number): (lng: number, lat: number) => LcFractions {
  const keys = ['grass', 'shrub', 'crops', 'builtup', 'bare', 'tree', 'wetland', 'other'] as const;
  const half = modelStep / 2;
  return (lng, lat) => {
    const ix0 = Math.max(0, Math.floor((lng - half - lc.bbox[0]) / lc.step));
    const ix1 = Math.min(lc.nx - 1, Math.floor((lng + half - lc.bbox[0] - 1e-9) / lc.step));
    const iy0 = Math.max(0, Math.floor((lat - half - lc.bbox[1]) / lc.step));
    const iy1 = Math.min(lc.ny - 1, Math.floor((lat + half - lc.bbox[1] - 1e-9) / lc.step));
    const out: LcFractions = { grass: 0, shrub: 0, crops: 0, builtup: 0, bare: 0, tree: 0, wetland: 0, other: 0 };
    if (ix1 < ix0 || iy1 < iy0) return out;
    let n = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iy * lc.nx + ix;
        for (const k of keys) out[k] += lc.fractions[k][i];
        n++;
      }
    }
    for (const k of keys) out[k] = out[k] / (100 * n);
    return out;
  };
}
