import path from 'node:path';

function parseBbox(s: string): [number, number, number, number] {
  const p = s.split(',').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new Error(`WIND_BBOX 格式错误: ${s}`);
  return [p[0], p[1], p[2], p[3]];
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  dataDir: path.resolve(env.DATA_DIR ?? 'data'),
  scrapeIntervalHours: Number(env.SCRAPE_INTERVAL_HOURS ?? 24),
  scrapeDelayMs: Number(env.SCRAPE_DELAY_MS ?? 400),
  scrapeHistoryDays: Number(env.SCRAPE_HISTORY_DAYS ?? 7),
  windRefreshHours: Number(env.WIND_REFRESH_HOURS ?? 24),
  windBbox: parseBbox(env.WIND_BBOX ?? '73,18,135,54'),
  windStepDeg: Number(env.WIND_STEP_DEG ?? 1),
  windModel: env.WIND_MODEL ?? 'best_match',
  windPastDays: Number(env.WIND_PAST_DAYS ?? 1),
  windForecastDays: Number(env.WIND_FORECAST_DAYS ?? 3),
  windChunkSize: Number(env.WIND_CHUNK_SIZE ?? 100),
  landcoverStepDeg: Number(env.LANDCOVER_STEP_DEG ?? 0.1),
  landcoverServeStep: Number(env.LANDCOVER_SERVE_STEP ?? 0.2), // 下发给浏览器时聚合到的格子（模型步长 ≥0.25°，0.2° 足够，体积只有 1/4）
  landcoverConcurrency: Number(env.LANDCOVER_CONCURRENCY ?? 1),
  landcoverRpm: Number(env.LANDCOVER_RPM ?? 60),
  adminToken: env.ADMIN_TOKEN ?? '',
  userAgent: env.USER_AGENT ?? 'pollen-north/0.1 (personal, non-commercial research)',
};
