import path from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.ts';
import { cities, cityByCode } from './cities.ts';
import { buildLatest, history } from './db.ts';
import { seasonLevelsFile } from './scraper.ts';
import { loadLandcover } from './landcover.ts';
import { buildStatus, encodedBoundaries, encodedWind } from './export.ts';
import { runScrape, runWind, schedulerStatus, startScheduler } from './scheduler.ts';
import { log, readJson, todayCN } from './util.ts';
import { defaultSeasonLevels } from '../shared/levels.ts';
import type { EmissionPrior, OfficialAlert, SeasonLevel } from '../shared/types.ts';

const app = new Hono();
app.use('/api/*', compress());

app.get('/api/cities', (c) => c.json(cities));

app.get('/api/pollen/latest', (c) => {
  const days = Math.min(60, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const { season, cities: list } = buildLatest(
    cities.map((x) => x.code),
    days,
  );
  return c.json({ today: todayCN(), season, cities: list });
});

app.get('/api/pollen/history', (c) => {
  const city = c.req.query('city') ?? '';
  if (!cityByCode.has(city)) return c.json({ error: 'unknown city' }, 400);
  const days = Math.min(400, Math.max(1, Number(c.req.query('days') ?? 90) || 90));
  return c.json({ city, days: history(city, days) });
});

app.get('/api/wind', (c) => {
  const w = encodedWind();
  if (!w) return c.json({ error: 'wind not ready' }, 503);
  return c.json(w);
});

app.get('/api/boundaries', (c) => {
  c.header('Cache-Control', 'public, max-age=86400');
  return c.json(encodedBoundaries() ?? { type: 'QuantizedFeatureCollection', q: 1000, features: [] });
});
app.get('/api/landcover', (c) => {
  const g = loadLandcover();
  if (!g) return c.json({ error: '植被数据尚未生成，运行 npm run landcover' }, 404);
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json(g);
});
app.get('/api/alerts', (c) => c.json(readJson<OfficialAlert[]>(path.join(config.dataDir, 'official_alerts.json'), [])));
app.get('/api/priors', (c) => c.json(readJson<EmissionPrior[]>(path.join(config.dataDir, 'emission_prior.json'), [])));
app.get('/api/season-levels', (c) => c.json(readJson<SeasonLevel[]>(seasonLevelsFile(), defaultSeasonLevels)));

app.get('/api/status', (c) => c.json(buildStatus(schedulerStatus())));

app.post('/api/admin/:task', async (c) => {
  if (!config.adminToken || c.req.query('token') !== config.adminToken) return c.json({ error: 'forbidden' }, 403);
  const task = c.req.param('task');
  if (task === 'scrape') return c.json({ result: await runScrape() });
  if (task === 'wind') {
    const w = await runWind();
    return c.json({ result: w ? { fetchedAt: w.fetchedAt, hours: w.times.length } : null });
  }
  return c.json({ error: 'unknown task' }, 400);
});

// 生产：托管 vite build 产物
app.use('/*', serveStatic({ root: './client/dist' }));
app.get('*', serveStatic({ path: './client/dist/index.html' }));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log(`pollen-north listening on http://localhost:${info.port}`);
});
if (process.env.NO_SCHEDULER === '1') log('scheduler disabled (NO_SCHEDULER=1)');
else startScheduler();
