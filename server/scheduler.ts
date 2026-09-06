import { config } from './config.ts';
import { lastScrape } from './db.ts';
import { scrapeAll } from './scraper.ts';
import { loadWind, refreshWind } from './wind.ts';
import { loadBoundaries, refreshBoundaries } from './boundaries.ts';
import { log } from './util.ts';

let scraping = false;
let winding = false;

export function schedulerStatus() {
  return { scraping, winding };
}

function scrapeDue(): boolean {
  const last = lastScrape();
  if (!last?.finished_at) return true;
  return Date.now() - Date.parse(last.finished_at) > config.scrapeIntervalHours * 3600e3;
}

function windDue(): boolean {
  const w = loadWind();
  if (!w) return true;
  if (w.bbox.join(',') !== config.windBbox.join(',') || w.step !== config.windStepDeg || w.model !== config.windModel) return true;
  return Date.now() - Date.parse(w.fetchedAt) > config.windRefreshHours * 3600e3;
}

export async function runScrape() {
  if (scraping) return null;
  scraping = true;
  try {
    return await scrapeAll();
  } finally {
    scraping = false;
  }
}

export async function runWind() {
  if (winding) return null;
  winding = true;
  try {
    return await refreshWind();
  } finally {
    winding = false;
  }
}

export async function tick() {
  if (!loadBoundaries()) await refreshBoundaries().catch((e) => log('boundaries error:', (e as Error).message));
  if (scrapeDue()) await runScrape().catch((e) => log('scrape error:', (e as Error).message));
  if (windDue()) await runWind().catch((e) => log('wind error:', (e as Error).message));
}

export function startScheduler() {
  void tick();
  setInterval(() => void tick(), 15 * 60 * 1000);
}
