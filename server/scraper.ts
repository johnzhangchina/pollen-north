import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.ts';
import { cities } from './cities.ts';
import { finishScrapeLog, startScrapeLog, upsertDays } from './db.ts';
import { addDays, ensureDir, log, nowIso, sleep, todayCN, writeJsonAtomic } from './util.ts';
import type { City, PollenDay, ScrapeSummary, SeasonLevel } from '../shared/types.ts';

/**
 * 上游：中国天气网花粉页面调用的第三方接口（北京天译科技 / WeatherDT）。
 * 无鉴权、无公开文档；只返回 5 档等级，不返回粒数。仅供个人研究，商用需另行授权。
 */
const BASE = 'https://graph.weatherdt.com/ty/pollen/v2/hfindex.html';

interface UpstreamEntry {
  addTime: string;
  levelCode?: number;
  level?: string;
  color?: string;
  levelMsg?: string;
  week?: string;
  city?: string;
  cityCode?: string;
}
interface Upstream {
  seasonLevelName?: string;
  seasonLevel?: SeasonLevel[];
  dataList?: UpstreamEntry[];
}

export interface CityFetch {
  raw: Upstream;
  season: string | null;
  levels: SeasonLevel[];
  days: PollenDay[];
}

export async function fetchCity(code: string, start: string, end: string): Promise<CityFetch> {
  const url = `${BASE}?eletype=1&city=${encodeURIComponent(code)}&start=${start}&end=${end}&predictFlag=true`;
  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent, Accept: '*/*' }, // 上游返回 text/plain，带 application/json 会 406
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = (await res.json()) as Upstream;
  const today = todayCN();
  const days: PollenDay[] = (raw.dataList ?? [])
    .filter((e) => typeof e.addTime === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.addTime))
    .map((e) => ({
      date: e.addTime,
      levelCode: typeof e.levelCode === 'number' && e.levelCode >= 0 ? e.levelCode : null,
      level: e.level ?? '暂无',
      color: e.color ?? null,
      msg: e.levelMsg ?? '',
      kind: e.addTime > today ? 'forecast' : 'obs',
    }));
  return { raw, season: raw.seasonLevelName ?? null, levels: raw.seasonLevel ?? [], days };
}

export const seasonLevelsFile = () => path.join(config.dataDir, 'season_levels.json');

export async function scrapeAll(list: City[] = cities): Promise<ScrapeSummary> {
  const startedAt = nowIso();
  const logId = startScrapeLog(startedAt);
  const today = todayCN();
  const start = addDays(today, -config.scrapeHistoryDays);
  const rawDir = path.join(config.dataDir, 'raw', today);
  ensureDir(rawDir);

  let ok = 0;
  const failed: string[] = [];
  let season: string | null = null;
  let savedLevels = false;

  log(`scrape start: ${list.length} cities, ${start}..${today}`);
  for (const c of list) {
    try {
      const r = await fetchCity(c.code, start, today);
      upsertDays(c.code, r.season, r.days, nowIso());
      fs.writeFileSync(path.join(rawDir, `${c.code}.json`), JSON.stringify(r.raw));
      if (!savedLevels && r.levels.length >= 6) {
        writeJsonAtomic(seasonLevelsFile(), r.levels);
        savedLevels = true;
      }
      season ??= r.season;
      ok++;
    } catch (e) {
      failed.push(c.code);
      log(`scrape ${c.code} failed:`, (e as Error).message);
    }
    await sleep(config.scrapeDelayMs);
  }
  const finishedAt = nowIso();
  finishScrapeLog(logId, finishedAt, ok, failed.length, failed.length ? `failed: ${failed.join(',')}` : 'ok');
  log(`scrape done: ok=${ok} failed=${failed.length}`);
  return { startedAt, finishedAt, ok, failed, season };
}
