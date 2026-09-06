export type Region = 'northwest' | 'neimeng' | 'north' | 'northeast' | 'east' | 'central' | 'south' | 'southwest';

export interface City {
  code: string; // weatherdt 接口的 city 参数（拼音）
  name: string;
  lat: number;
  lng: number;
  region: Region;
  core: boolean; // 用户重点：银川 / 兰州 / 内蒙
}

export type DayKind = 'obs' | 'forecast';

export interface PollenDay {
  date: string; // YYYY-MM-DD（北京时间）
  levelCode: number | null; // 1..5，null = 上游"暂无"
  level: string;
  color: string | null;
  msg: string;
  kind: DayKind;
}

export interface CityLatest {
  city: string;
  latest: PollenDay | null; // 最近一条有值的实测
  forecast: PollenDay | null; // 上游给的"明天"预报
  history: PollenDay[]; // 最近 N 天实测（含缺测）
}

export interface LatestResponse {
  today: string;
  season: string | null;
  cities: CityLatest[];
}

export interface SeasonLevel {
  level: string;
  levelMsg: string;
  color: string;
  minNum: number;
  maxNum?: number; // 上游最高档没有 maxNum
  desc?: string;
}

export interface WindGrid {
  fetchedAt: string;
  model: string;
  source: string;
  bbox: [number, number, number, number];
  step: number;
  nx: number;
  ny: number;
  lons: number[];
  lats: number[];
  times: number[]; // unix 秒，逐小时
  u: number[][]; // [t][iy*nx+ix]，m/s，向东为正
  v: number[][]; // 向北为正
  precip: number[][]; // mm/h
}

export interface OfficialAlertRegion {
  name: string;
  level: number; // 官方 1..5
  bbox: [number, number, number, number];
}

export interface OfficialAlert {
  issued: string;
  period: [string, string];
  season: 'spring' | 'autumn';
  source: string;
  url?: string;
  pollenType: string;
  thresholds: string;
  regions: OfficialAlertRegion[];
  note?: string;
}

export interface EmissionPrior {
  season: 'spring' | 'autumn';
  name: string;
  taxa: string;
  weight: number; // 0..1
  polygon: [number, number][]; // [lng, lat]
}

export interface ScrapeSummary {
  startedAt: string;
  finishedAt: string;
  ok: number;
  failed: string[];
  season: string | null;
}

export type LandcoverKey = 'grass' | 'shrub' | 'crops' | 'builtup' | 'bare' | 'tree' | 'wetland' | 'other';

/** 土地覆盖占比格网：每类 0–100（%），行主序，格子 (ix, iy) 覆盖 [lon0+ix*step, +step) × [lat0+iy*step, +step) */
export interface LandcoverGrid {
  source: string;
  url: string;
  fetchedAt: string;
  bbox: [number, number, number, number];
  step: number;
  nx: number;
  ny: number;
  fractions: Record<LandcoverKey, number[]>;
}

export interface StatusResponse {
  now: string;
  today: string;
  cityCount: number;
  lastScrape: { started_at: string; finished_at: string | null; ok_cities: number; failed_cities: number; note: string | null } | null;
  wind: { fetchedAt: string; model: string; nx: number; ny: number; hours: number } | null;
  landcover: { fetchedAt: string; nx: number; ny: number; step: number; source: string } | null;
  scheduler: { scraping: boolean; winding: boolean };
  config: { scrapeIntervalHours: number; windRefreshHours: number; windBbox: number[]; windStepDeg: number; windModel: string };
}
