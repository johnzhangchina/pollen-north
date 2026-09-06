import path from 'node:path';
import { statSync } from 'node:fs';
import { config } from './config.ts';
import { ensureDir, log, readJson, sleep, writeJsonAtomic } from './util.ts';

/**
 * 地级市行政边界：阿里云 DataV GeoAtlas（数据源为高德，GCJ-02 坐标，仅供学习研究）。
 * 全国各省的地级市；直辖市和港澳台取整体一个面。文件生成一次即可，缺失时服务启动会自动补。
 */
const PROVINCES: { adcode: number; name: string; full: boolean }[] = [
  { adcode: 150000, name: '内蒙古', full: true },
  { adcode: 640000, name: '宁夏', full: true },
  { adcode: 620000, name: '甘肃', full: true },
  { adcode: 630000, name: '青海', full: true },
  { adcode: 650000, name: '新疆', full: true },
  { adcode: 610000, name: '陕西', full: true },
  { adcode: 140000, name: '山西', full: true },
  { adcode: 130000, name: '河北', full: true },
  { adcode: 370000, name: '山东', full: true },
  { adcode: 410000, name: '河南', full: true },
  { adcode: 210000, name: '辽宁', full: true },
  { adcode: 220000, name: '吉林', full: true },
  { adcode: 230000, name: '黑龙江', full: true },
  { adcode: 110000, name: '北京', full: false },
  { adcode: 120000, name: '天津', full: false },
  { adcode: 310000, name: '上海', full: false },
  { adcode: 500000, name: '重庆', full: false },
  { adcode: 320000, name: '江苏', full: true },
  { adcode: 330000, name: '浙江', full: true },
  { adcode: 340000, name: '安徽', full: true },
  { adcode: 350000, name: '福建', full: true },
  { adcode: 360000, name: '江西', full: true },
  { adcode: 420000, name: '湖北', full: true },
  { adcode: 430000, name: '湖南', full: true },
  { adcode: 440000, name: '广东', full: true },
  { adcode: 450000, name: '广西', full: true },
  { adcode: 460000, name: '海南', full: true },
  { adcode: 510000, name: '四川', full: true },
  { adcode: 520000, name: '贵州', full: true },
  { adcode: 530000, name: '云南', full: true },
  { adcode: 540000, name: '西藏', full: true },
  { adcode: 710000, name: '台湾', full: false },
  { adcode: 810000, name: '香港', full: false },
  { adcode: 820000, name: '澳门', full: false },
];

export interface BoundaryProps {
  adcode: number;
  name: string;
  center: [number, number];
  centroid: [number, number];
  province: string;
  provinceAdcode: number;
}
interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}

export const boundariesFile = () => path.join(config.dataDir, 'boundaries', 'cities.json');
let cache: { mtime: number; fc: FC } | null = null;

/** 按文件修改时间缓存，`npm run boundaries` 重新生成后服务不用重启 */
export function loadBoundaries(): FC | null {
  try {
    const st = statSync(boundariesFile());
    if (cache && cache.mtime === st.mtimeMs) return cache.fc;
    const fc = readJson<FC | null>(boundariesFile(), null);
    if (fc) cache = { mtime: st.mtimeMs, fc };
    return fc;
  } catch {
    return null;
  }
}

function roundCoords(c: unknown): unknown {
  if (typeof c === 'number') return Math.round(c * 1e4) / 1e4;
  if (Array.isArray(c)) return c.map(roundCoords);
  return c;
}

export async function refreshBoundaries(): Promise<number> {
  const out: Feature[] = [];
  for (const p of PROVINCES) {
    const url = `https://geo.datav.aliyun.com/areas_v3/bound/${p.adcode}${p.full ? '_full' : ''}.json`;
    const res = await fetch(url, { headers: { 'User-Agent': config.userAgent }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}`);
    const fc = (await res.json()) as FC;
    for (const f of fc.features) {
      const pr = f.properties as { adcode?: number; name?: string; center?: number[]; centroid?: number[] };
      if (!pr.adcode || !pr.name || !f.geometry) continue;
      const center = (pr.center ?? pr.centroid ?? [0, 0]) as [number, number];
      const centroid = (pr.centroid ?? pr.center ?? [0, 0]) as [number, number];
      out.push({
        type: 'Feature',
        properties: {
          adcode: pr.adcode,
          name: pr.name,
          center,
          centroid,
          province: p.name,
          provinceAdcode: p.adcode,
        } satisfies BoundaryProps,
        geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
      });
    }
    log(`boundaries: ${p.name} ${fc.features.length} features`);
    await sleep(300);
  }
  ensureDir(path.dirname(boundariesFile()));
  const fc: FC = { type: 'FeatureCollection', features: out };
  writeJsonAtomic(boundariesFile(), fc);
  cache = null;
  return out.length;
}
