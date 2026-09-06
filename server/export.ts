import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import { cities } from './cities.ts';
import { buildLatest, db, lastScrape } from './db.ts';
import { seasonLevelsFile } from './scraper.ts';
import { loadWind } from './wind.ts';
import { loadBoundaries } from './boundaries.ts';
import { loadLandcover } from './landcover.ts';
import { log, nowIso, readJson, todayCN } from './util.ts';
import { defaultSeasonLevels } from '../shared/levels.ts';
import type { EmissionPrior, OfficialAlert, SeasonLevel, StatusResponse, WindGrid } from '../shared/types.ts';
import { encodeBoundaries, encodeWind, type PlainFC, type QuantizedFC } from '../shared/codec.ts';

let windEnc: { fetchedAt: string; data: WindGrid } | null = null;
/** 传输编码后的风场（按 fetchedAt 缓存） */
export function encodedWind(): WindGrid | null {
  const w = loadWind();
  if (!w) return null;
  if (!windEnc || windEnc.fetchedAt !== w.fetchedAt) windEnc = { fetchedAt: w.fetchedAt, data: encodeWind(w) };
  return windEnc.data;
}

let bdEnc: { src: unknown; data: QuantizedFC } | null = null;
/** 量化差分编码后的边界（按对象身份缓存，loadBoundaries 本身按 mtime 缓存） */
export function encodedBoundaries(): QuantizedFC | null {
  const fc = loadBoundaries();
  if (!fc) return null;
  if (!bdEnc || bdEnc.src !== fc) bdEnc = { src: fc, data: encodeBoundaries(fc as unknown as PlainFC) };
  return bdEnc.data;
}

export function buildStatus(scheduler: StatusResponse['scheduler'] = { scraping: false, winding: false }): StatusResponse {
  const w = loadWind();
  const g = loadLandcover();
  return {
    now: nowIso(),
    today: todayCN(),
    cityCount: cities.length,
    lastScrape: lastScrape(),
    wind: w ? { fetchedAt: w.fetchedAt, model: w.model, nx: w.nx, ny: w.ny, hours: w.times.length } : null,
    landcover: g ? { fetchedAt: g.fetchedAt, nx: g.nx, ny: g.ny, step: g.step, source: g.source } : null,
    scheduler,
    config: {
      scrapeIntervalHours: config.scrapeIntervalHours,
      windRefreshHours: config.windRefreshHours,
      windBbox: config.windBbox,
      windStepDeg: config.windStepDeg,
      windModel: config.windModel,
    },
  };
}

/**
 * 把所有只读接口导出成静态 JSON（路径与 /api/* 一一对应，多一个 .json 后缀），
 * 供 Cloudflare Pages / GitHub Pages 这类纯静态托管使用；前端以 VITE_STATIC_API=1 构建即可直接读取。
 * 返回写出的文件列表。缺少风场或植被时对应文件不写出，前端会给出提示。
 */
export function exportStatic(outDir: string): string[] {
  const written: string[] = [];
  const put = (rel: string, value: unknown) => {
    const f = path.join(outDir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(value));
    written.push(rel);
  };

  put('cities.json', cities);
  const { season, cities: list } = buildLatest(
    cities.map((x) => x.code),
    7,
  );
  put('pollen/latest.json', { today: todayCN(), season, cities: list });
  put('alerts.json', readJson<OfficialAlert[]>(path.join(config.dataDir, 'official_alerts.json'), []));
  put('priors.json', readJson<EmissionPrior[]>(path.join(config.dataDir, 'emission_prior.json'), []));
  put('season-levels.json', readJson<SeasonLevel[]>(seasonLevelsFile(), defaultSeasonLevels));
  put('boundaries.json', encodedBoundaries() ?? { type: 'QuantizedFeatureCollection', q: 1000, features: [] });
  const wind = encodedWind();
  if (wind) put('wind.json', wind);
  else log('export: 没有风场文件，跳过 wind.json');
  const lc = loadLandcover();
  if (lc) put('landcover.json', lc);
  else log('export: 没有植被文件，跳过 landcover.json');
  put('status.json', buildStatus());

  // 把 WAL 合并回主文件，方便直接把 pollen.sqlite 提交进仓库保存历史
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return written;
}
