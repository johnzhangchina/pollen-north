import path from 'node:path';
import { statSync } from 'node:fs';
import { BaseClient, BaseResponse, fromCustomClient } from 'geotiff';
import { config } from './config.ts';
import { ensureDir, log, nowIso, readJson, sleep, writeJsonAtomic } from './util.ts';
import type { LandcoverGrid, LandcoverKey } from '../shared/types.ts';

/**
 * 植被 / 土地覆盖：Copernicus Global Land Service LC100 v3.0.1（2019，100 m，CC BY 4.0）。
 * 直接对 Zenodo 上的全球 GeoTIFF 做 HTTP Range 读取（内部 256×256 分块），只取 WIND_BBOX 范围，
 * 按 LANDCOVER_STEP_DEG 的格子统计各类占比，结果落到 data/landcover/fractions.json（约 1 MB）。
 * 用离散分类图而不是逐类覆盖度层：一个文件（全球 1.7 GB）代替五六个（每个 3–7 GB），聚到 10 km 后精度足够。
 */
export const LANDCOVER_URL =
  process.env.LANDCOVER_URL ??
  'https://zenodo.org/records/3939050/files/PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif';

class FetchResp extends BaseResponse {
  private r: Response;
  constructor(r: Response) {
    super();
    this.r = r;
  }
  get status() {
    return this.r.status;
  }
  getHeader(name: string) {
    return this.r.headers.get(name) ?? undefined;
  }
  async getData() {
    return this.r.arrayBuffer();
  }
}

/** Zenodo 限每分钟约 130 次请求：滑动窗口限速，429/503 时按 Retry-After 等待后重发 */
class ThrottledClient extends BaseClient {
  private stamps: number[] = [];
  private perMinute: number;
  private extraHeaders: Record<string, string>;
  requests = 0;
  constructor(url: string, perMinute: number, extraHeaders: Record<string, string>) {
    super(url);
    this.perMinute = perMinute;
    this.extraHeaders = extraHeaders;
  }
  private async acquire() {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(now);
        return;
      }
      await sleep(this.stamps[0] + 60_000 - now + 50);
    }
  }
  async request({ headers, signal }: RequestInit = {}) {
    for (let attempt = 1; ; attempt++) {
      await this.acquire();
      this.requests++;
      const t0 = Date.now();
      const timeout = AbortSignal.timeout(120_000);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const r = await fetch(this.url, { headers: { ...this.extraHeaders, ...((headers as Record<string, string>) ?? {}) }, signal: sig });
      if ((r.status === 429 || r.status === 503) && attempt < 6) {
        const ra = Number(r.headers.get('retry-after') ?? 60);
        log('landcover', `HTTP ${r.status}, waiting ${ra}s (attempt ${attempt})`);
        await sleep((Number.isFinite(ra) ? ra + 1 : 61) * 1000);
        continue;
      }
      if (this.requests % 10 === 0) log('landcover', `${this.requests} requests, last ${r.status} ${r.headers.get('content-range') ?? ''} ${(Date.now() - t0) / 1000}s`);
      return new FetchResp(r);
    }
  }
}

export const LANDCOVER_KEYS: LandcoverKey[] = ['grass', 'shrub', 'crops', 'builtup', 'bare', 'tree', 'wetland', 'other'];

/** LC100 离散分类值 → 我们的 8 类；返回 -1 表示无数据（海洋 / nodata） */
function classIndex(v: number): number {
  switch (v) {
    case 30:
      return 0; // herbaceous vegetation
    case 20:
      return 1; // shrubs
    case 40:
      return 2; // cultivated
    case 50:
      return 3; // urban / built-up
    case 60:
      return 4; // bare / sparse vegetation
    case 90:
      return 6; // herbaceous wetland
    case 0:
    case 200:
    case 255:
      return -1;
    default:
      return v >= 111 && v <= 126 ? 5 : 7; // forests → tree；snow/water/moss → other
  }
}

export function landcoverFile() {
  return path.join(config.dataDir, 'landcover', 'fractions.json');
}

/** 把 0.1° 的分类占比格子按整数倍聚合（均值），减小下发体积 */
export function coarsenLandcover(g: LandcoverGrid, factor: number): LandcoverGrid {
  if (factor <= 1) return g;
  const nx = Math.floor(g.nx / factor);
  const ny = Math.floor(g.ny / factor);
  const fractions = {} as LandcoverGrid['fractions'];
  for (const k of LANDCOVER_KEYS) {
    const src = g.fractions[k];
    const out = new Array<number>(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += src[(y * factor + dy) * g.nx + x * factor + dx];
        out[y * nx + x] = Math.round(sum / (factor * factor));
      }
    }
    fractions[k] = out;
  }
  const step = g.step * factor;
  return { ...g, step, nx, ny, bbox: [g.bbox[0], g.bbox[1], g.bbox[0] + nx * step, g.bbox[1] + ny * step], fractions };
}

let cache: { mtime: number; data: LandcoverGrid } | null = null;
/** 读取并按 LANDCOVER_SERVE_STEP 聚合后的格子（按文件修改时间缓存） */
export function loadLandcover(): LandcoverGrid | null {
  const f = landcoverFile();
  try {
    const st = statSync(f);
    if (cache && cache.mtime === st.mtimeMs) return cache.data;
    const raw = readJson<LandcoverGrid | null>(f, null);
    if (!raw) return null;
    const factor = Math.max(1, Math.round(config.landcoverServeStep / raw.step));
    const data = coarsenLandcover(raw, factor);
    cache = { mtime: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

export async function refreshLandcover(): Promise<LandcoverGrid> {
  const [lon0, lat0, lon1, lat1] = config.windBbox;
  const step = config.landcoverStepDeg;
  const nx = Math.round((lon1 - lon0) / step);
  const ny = Math.round((lat1 - lat0) / step);
  const N = nx * ny;
  const K = LANDCOVER_KEYS.length;
  const counts = new Uint32Array(N * K);
  const valid = new Uint32Array(N);

  log('landcover', `open ${LANDCOVER_URL}`);
  const client = new ThrottledClient(LANDCOVER_URL, config.landcoverRpm, { 'User-Agent': config.userAgent });
  // 8 MB 的块：一条 256 px 行带（约 1–2 MB 压缩数据）一次请求读完，把请求数从上千压到一百左右
  const tiff = await fromCustomClient(client, { allowFullFile: false, blockSize: 8 * 1024 * 1024, cacheSize: 64 } as Parameters<typeof fromCustomClient>[1]);
  const img = await tiff.getImage();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution(); // ry < 0
  const W = img.getWidth();
  const H = img.getHeight();
  const tileH = img.getTileHeight() || 256;
  const px0 = Math.max(0, Math.floor((lon0 - ox) / rx));
  const px1 = Math.min(W, Math.ceil((lon1 - ox) / rx));
  const py0 = Math.max(0, Math.floor((lat1 - oy) / ry)); // 上边（纬度大）
  const py1 = Math.min(H, Math.ceil((lat0 - oy) / ry));
  log('landcover', `window x ${px0}-${px1} y ${py0}-${py1} (${px1 - px0}×${py1 - py0} px, ${rx.toFixed(6)}°/px) → grid ${nx}×${ny} @ ${step}°`);

  // 每个像素列 / 行对应的格子索引（预先算好，内层循环只查表）
  const colCell = new Int32Array(px1 - px0);
  for (let x = px0; x < px1; x++) {
    const lng = ox + (x + 0.5) * rx;
    const ix = Math.floor((lng - lon0) / step);
    colCell[x - px0] = ix >= 0 && ix < nx ? ix : -1;
  }
  const rowCell = new Int32Array(py1 - py0);
  for (let y = py0; y < py1; y++) {
    const lat = oy + (y + 0.5) * ry;
    const iy = Math.floor((lat - lat0) / step);
    rowCell[y - py0] = iy >= 0 && iy < ny ? iy : -1;
  }

  // 按分块行带读取，几个带并行
  const bands: [number, number][] = [];
  const firstBand = Math.floor(py0 / tileH) * tileH;
  for (let y = firstBand; y < py1; y += tileH) bands.push([Math.max(py0, y), Math.min(py1, y + tileH)]);
  let done = 0;
  const t0 = Date.now();
  const readBand = async ([y0, y1]: [number, number]) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const r = (await img.readRasters({ window: [px0, y0, px1, y1] })) as unknown as Uint8Array[];
        const a = r[0];
        const w = px1 - px0;
        for (let y = y0; y < y1; y++) {
          const iy = rowCell[y - py0];
          if (iy < 0) continue;
          const rowOff = (y - y0) * w;
          const cellRow = iy * nx;
          for (let x = 0; x < w; x++) {
            const ix = colCell[x];
            if (ix < 0) continue;
            const k = classIndex(a[rowOff + x]);
            if (k < 0) continue;
            const cell = cellRow + ix;
            counts[cell * K + k]++;
            valid[cell]++;
          }
        }
        done++;
        if (done % 8 === 0 || done === bands.length) {
          const el = (Date.now() - t0) / 1000;
          log('landcover', `${done}/${bands.length} bands, ${el.toFixed(0)} s, eta ${((el / done) * (bands.length - done)).toFixed(0)} s`);
        }
        return;
      } catch (e) {
        lastErr = e;
        log('landcover', `band ${y0}-${y1} attempt ${attempt} failed: ${(e as Error).message}`);
        await sleep(Math.min(60_000, 5000 * attempt));
      }
    }
    throw lastErr;
  };
  const concurrency = config.landcoverConcurrency;
  let next = 0;
  // geotiff 的分块源在并发取块失败时会在内部再抛一次未被 await 的拒绝，这里兜住，让 readBand 的重试接管
  const swallow = (e: unknown) => log('landcover', `ignored internal rejection: ${(e as Error)?.message ?? e}`);
  process.on('unhandledRejection', swallow);
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < bands.length) {
          const b = bands[next++];
          await readBand(b);
        }
      }),
    );
  } finally {
    process.off('unhandledRejection', swallow);
  }

  const fractions = {} as Record<LandcoverKey, number[]>;
  for (let k = 0; k < K; k++) {
    const arr = new Array<number>(N);
    for (let i = 0; i < N; i++) arr[i] = valid[i] ? Math.round((100 * counts[i * K + k]) / valid[i]) : 0;
    fractions[LANDCOVER_KEYS[k]] = arr;
  }
  const grid: LandcoverGrid = {
    source: 'Copernicus Global Land Service LC100 v3.0.1, epoch 2019, 100 m discrete classification (CC BY 4.0)',
    url: LANDCOVER_URL,
    fetchedAt: nowIso(),
    bbox: [lon0, lat0, lon0 + nx * step, lat0 + ny * step],
    step,
    nx,
    ny,
    fractions,
  };
  ensureDir(path.dirname(landcoverFile()));
  writeJsonAtomic(landcoverFile(), grid);
  cache = null;
  log('landcover', `saved ${landcoverFile()} in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${client.requests} HTTP requests`);
  return grid;
}
