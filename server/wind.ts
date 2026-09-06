import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { ensureDir, log, nowIso, readJson, sleep, writeJsonAtomic } from './util.ts';
import type { WindGrid } from '../shared/types.ts';

/**
 * 风场：Open-Meteo 免费接口（非商用、CC BY 4.0、<1 万次坐标/天）。
 * 每个网格点算一次调用；0.5° × [96,33,128,50] ≈ 2275 点，每 12 小时刷新一次约 4600 次/天。
 */
const OM = 'https://api.open-meteo.com/v1/forecast';

interface OmHourly {
  time: number[];
  wind_speed_10m: (number | null)[];
  wind_direction_10m: (number | null)[];
  precipitation: (number | null)[];
}
interface OmResp {
  latitude: number;
  longitude: number;
  hourly: OmHourly;
}

const windDir = () => path.join(config.dataDir, 'wind');
const latestFile = () => path.join(windDir(), 'latest.json');

let cache: WindGrid | null = null;

// Open-Meteo 免费额度按"坐标数"计：每分钟 600、每小时 5000、每天 10000。这里按分钟窗口节流。
const MINUTE_BUDGET = Number(process.env.OM_MINUTE_BUDGET ?? 550);
let windowStart = Date.now();
let sentInWindow = 0;
async function throttle(n: number) {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    sentInWindow = 0;
  }
  if (sentInWindow + n > MINUTE_BUDGET) {
    const wait = 60_000 - (now - windowStart) + 1500;
    log(`wind: 达到每分钟额度，等待 ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
    windowStart = Date.now();
    sentInWindow = 0;
  }
  sentInWindow += n;
}

export function loadWind(): WindGrid | null {
  if (cache) return cache;
  cache = readJson<WindGrid | null>(latestFile(), null);
  return cache;
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}

export async function refreshWind(): Promise<WindGrid> {
  const [lon0, lat0, lon1, lat1] = config.windBbox;
  const step = config.windStepDeg;
  const nx = Math.round((lon1 - lon0) / step) + 1;
  const ny = Math.round((lat1 - lat0) / step) + 1;
  const lons = Array.from({ length: nx }, (_, i) => round2(lon0 + i * step));
  const lats = Array.from({ length: ny }, (_, j) => round2(lat0 + j * step));
  const pts: { lat: number; lon: number }[] = [];
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) pts.push({ lat: lats[iy], lon: lons[ix] });

  log(`wind refresh: ${nx}x${ny}=${pts.length} points, model=${config.windModel}`);
  const results: OmResp[] = new Array(pts.length);
  const chunk = Math.max(1, config.windChunkSize);
  for (let s = 0; s < pts.length; s += chunk) {
    const part = pts.slice(s, s + chunk);
    const qs = new URLSearchParams({
      latitude: part.map((p) => p.lat).join(','),
      longitude: part.map((p) => p.lon).join(','),
      hourly: 'wind_speed_10m,wind_direction_10m,precipitation',
      wind_speed_unit: 'ms',
      timeformat: 'unixtime',
      timezone: 'Asia/Shanghai',
      past_days: String(config.windPastDays),
      forecast_days: String(config.windForecastDays),
      models: config.windModel,
    });
    let attempt = 0;
    for (;;) {
      try {
        await throttle(part.length);
        const res = await fetch(`${OM}?${qs}`, {
          headers: { 'User-Agent': config.userAgent },
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
        const body = (await res.json()) as OmResp | OmResp[];
        const arr = Array.isArray(body) ? body : [body];
        if (arr.length !== part.length) throw new Error(`返回点数 ${arr.length} != 请求 ${part.length}`);
        arr.forEach((r, i) => (results[s + i] = r));
        break;
      } catch (e) {
        attempt++;
        const msg = (e as Error).message;
        log(`wind chunk ${s} attempt ${attempt} failed:`, msg);
        if (attempt >= 5) throw e;
        if (msg.includes('429')) {
          await sleep(65_000);
          windowStart = Date.now();
          sentInWindow = 0;
        } else {
          await sleep(2000 * attempt);
        }
      }
    }
    await sleep(250);
  }

  const nT = Math.min(...results.map((r) => r.hourly.time.length));
  const times = results[0].hourly.time.slice(0, nT);
  const u: number[][] = [];
  const v: number[][] = [];
  const precip: number[][] = [];
  for (let t = 0; t < nT; t++) {
    const ut = new Array<number>(pts.length);
    const vt = new Array<number>(pts.length);
    const pt = new Array<number>(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const h = results[i].hourly;
      const spd = h.wind_speed_10m[t] ?? 0;
      const dir = ((h.wind_direction_10m[t] ?? 0) * Math.PI) / 180;
      // 气象风向 = 风的来向；u 向东为正，v 向北为正
      ut[i] = round2(-spd * Math.sin(dir));
      vt[i] = round2(-spd * Math.cos(dir));
      pt[i] = round2(h.precipitation[t] ?? 0);
    }
    u.push(ut);
    v.push(vt);
    precip.push(pt);
  }

  const grid: WindGrid = {
    fetchedAt: nowIso(),
    model: config.windModel,
    source: 'Open-Meteo.com (CC BY 4.0)',
    bbox: config.windBbox,
    step,
    nx,
    ny,
    lons,
    lats,
    times,
    u,
    v,
    precip,
  };
  ensureDir(windDir());
  writeJsonAtomic(latestFile(), grid);
  fs.writeFileSync(path.join(windDir(), `wind-${grid.fetchedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(grid));
  pruneOld(10);
  cache = grid;
  log(`wind refresh done: ${nT} hours`);
  return grid;
}

function pruneOld(keep: number) {
  const files = fs
    .readdirSync(windDir())
    .filter((f) => f.startsWith('wind-'))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(windDir(), f));
}
