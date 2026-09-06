import type { BoundaryFC } from './boundaries.ts';
import type {
  City,
  EmissionPrior,
  LandcoverGrid,
  LatestResponse,
  OfficialAlert,
  SeasonLevel,
  StatusResponse,
  WindGrid,
} from '../../shared/types.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/**
 * VITE_STATIC_API=1：纯静态部署（Cloudflare Pages 等），接口是 `npm run export` 导出的 /api/xxx.json，查询参数被忽略；
 * VITE_API_BASE：接口挂在别的域名时的前缀（默认同源）。
 */
const STATIC = import.meta.env.VITE_STATIC_API === '1';
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
function url(p: string, query?: Record<string, string | number>): string {
  if (STATIC) return `${BASE}/api/${p}.json`;
  const qs = query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : '';
  return `${BASE}/api/${p}${qs}`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new HttpError(r.status, `${url} → ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  /** 静态模式下没有实时抓取，前端据此调整等待提示 */
  isStatic: STATIC,
  cities: () => getJson<City[]>(url('cities')),
  latest: (days = 7) => getJson<LatestResponse>(url('pollen/latest', { days })),
  wind: () => getJson<WindGrid>(url('wind')),
  alerts: () => getJson<OfficialAlert[]>(url('alerts')),
  priors: () => getJson<EmissionPrior[]>(url('priors')),
  seasonLevels: () => getJson<SeasonLevel[]>(url('season-levels')),
  status: () => getJson<StatusResponse>(url('status')),
  boundaries: () => getJson<BoundaryFC>(url('boundaries')),
  landcover: () => getJson<LandcoverGrid>(url('landcover')),
};

/** 反复尝试直到成功（服务刚启动时风场 / 实测可能还没就绪） */
export async function retry<T>(fn: () => Promise<T>, onWait: (attempt: number, err: unknown) => void, delayMs = 8000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      onWait(attempt, e);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
