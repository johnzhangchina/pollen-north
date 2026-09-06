import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { addDays, ensureDir, todayCN } from './util.ts';
import type { CityLatest, PollenDay } from '../shared/types.ts';

ensureDir(config.dataDir);
export const db = new DatabaseSync(path.join(config.dataDir, 'pollen.sqlite'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS pollen_daily (
  city        TEXT NOT NULL,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('obs','forecast')),
  level_code  INTEGER,
  level       TEXT,
  color       TEXT,
  msg         TEXT,
  season      TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (city, date, kind)
);
CREATE INDEX IF NOT EXISTS idx_pollen_date ON pollen_daily(date);
CREATE TABLE IF NOT EXISTS scrape_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  ok_cities     INTEGER DEFAULT 0,
  failed_cities INTEGER DEFAULT 0,
  note          TEXT
);
`);

// 有值不被"暂无"覆盖：上游有时早上先给 -1，下午才补数
const upsertStmt = db.prepare(`
INSERT INTO pollen_daily (city, date, kind, level_code, level, color, msg, season, fetched_at)
VALUES (@city, @date, @kind, @level_code, @level, @color, @msg, @season, @fetched_at)
ON CONFLICT(city, date, kind) DO UPDATE SET
  level_code = CASE WHEN excluded.level_code IS NULL THEN pollen_daily.level_code ELSE excluded.level_code END,
  level      = CASE WHEN excluded.level_code IS NULL THEN pollen_daily.level      ELSE excluded.level END,
  color      = CASE WHEN excluded.level_code IS NULL THEN pollen_daily.color      ELSE excluded.color END,
  msg        = CASE WHEN excluded.level_code IS NULL THEN pollen_daily.msg        ELSE excluded.msg END,
  season     = COALESCE(excluded.season, pollen_daily.season),
  fetched_at = excluded.fetched_at
`);

export function upsertDays(city: string, season: string | null, days: PollenDay[], fetchedAt: string) {
  db.exec('BEGIN');
  try {
    for (const d of days) {
      upsertStmt.run({
        city,
        date: d.date,
        kind: d.kind,
        level_code: d.levelCode,
        level: d.level,
        color: d.color,
        msg: d.msg,
        season,
        fetched_at: fetchedAt,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

interface Row {
  city: string;
  date: string;
  kind: 'obs' | 'forecast';
  level_code: number | null;
  level: string | null;
  color: string | null;
  msg: string | null;
  season: string | null;
}

const rowsSinceStmt = db.prepare(
  `SELECT city, date, kind, level_code, level, color, msg, season FROM pollen_daily WHERE date >= ? ORDER BY city, date`,
);
const historyStmt = db.prepare(
  `SELECT city, date, kind, level_code, level, color, msg, season FROM pollen_daily WHERE city = ? AND date >= ? ORDER BY date`,
);

function toDay(r: Row): PollenDay {
  return {
    date: r.date,
    levelCode: r.level_code,
    level: r.level ?? '暂无',
    color: r.color,
    msg: r.msg ?? '',
    kind: r.kind,
  };
}

/** 汇总每个城市：最近有值实测 / 明日预报 / 最近 N 天序列 */
export function buildLatest(codes: string[], days = 7): { season: string | null; cities: CityLatest[] } {
  const today = todayCN();
  const since = addDays(today, -(days + 2));
  const rows = rowsSinceStmt.all(since) as unknown as Row[];
  const byCity = new Map<string, Row[]>();
  let season: string | null = null;
  for (const r of rows) {
    if (!byCity.has(r.city)) byCity.set(r.city, []);
    byCity.get(r.city)!.push(r);
    if (r.season && r.date === today) season = r.season;
  }
  const out: CityLatest[] = codes.map((code) => {
    const rs = byCity.get(code) ?? [];
    const obs = rs.filter((r) => r.kind === 'obs' && r.date <= today);
    const history = obs.slice(-days).map(toDay);
    const latestRow = [...obs].reverse().find((r) => r.level_code != null);
    const fc = rs
      .filter((r) => r.kind === 'forecast' && r.date > today && r.level_code != null)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return {
      city: code,
      latest: latestRow ? toDay(latestRow) : null,
      forecast: fc ? toDay(fc) : null,
      history,
    };
  });
  return { season, cities: out };
}

export function history(city: string, days: number): PollenDay[] {
  const since = addDays(todayCN(), -days);
  return (historyStmt.all(city, since) as unknown as Row[]).map(toDay);
}

const insertLogStmt = db.prepare(`INSERT INTO scrape_log (started_at) VALUES (?)`);
const finishLogStmt = db.prepare(
  `UPDATE scrape_log SET finished_at = ?, ok_cities = ?, failed_cities = ?, note = ? WHERE id = ?`,
);
const lastLogStmt = db.prepare(`SELECT * FROM scrape_log ORDER BY id DESC LIMIT 1`);

export function startScrapeLog(startedAt: string): number {
  return Number(insertLogStmt.run(startedAt).lastInsertRowid);
}
export function finishScrapeLog(id: number, finishedAt: string, ok: number, failed: number, note: string) {
  finishLogStmt.run(finishedAt, ok, failed, note, id);
}
export function lastScrape() {
  return (lastLogStmt.get() as
    | { id: number; started_at: string; finished_at: string | null; ok_cities: number; failed_cities: number; note: string | null }
    | undefined) ?? null;
}
