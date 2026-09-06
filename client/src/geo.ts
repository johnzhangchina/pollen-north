export const M_PER_DEG_LAT = 110540;
export function mPerDegLng(lat: number): number {
  return Math.max(1000, 111320 * Math.cos((lat * Math.PI) / 180));
}

/** 射线法，polygon 为 [lng, lat] 数组 */
export function pointInPolygon(lng: number, lat: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

const CN_OFFSET = 8 * 3600;

/** 北京时间的年内日序（含小数） */
export function dayOfYearCN(epochSec: number): number {
  const d = new Date((epochSec + CN_OFFSET) * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return (d.getTime() - start) / 86400000 + 1;
}

/** 北京时间的小时（含小数） */
export function hourCN(epochSec: number): number {
  return (((epochSec + CN_OFFSET) % 86400) + 86400) % 86400 / 3600;
}

/** 'YYYY-MM-DD' 的北京时间 08:00 → unix 秒（医院镜检读数时刻） */
export function epochAt08CN(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0) / 1000; // 08:00 CST == 00:00 UTC
}

const fmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
export function fmtCN(epochSec: number): string {
  return fmt.format(new Date(epochSec * 1000));
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- WGS84 → GCJ-02（高德/DataV 使用的坐标系），标准公式 ----
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;
function outOfChina(lat: number, lng: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function tLat(x: number, y: number) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}
function tLng(x: number, y: number) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = tLat(lng - 105.0, lat - 35.0);
  let dLng = tLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

/** 两点球面距离（km） */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR;
  const dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 风的来向（气象习惯）：u 向东、v 向北的风速分量 → "西北风" 这类文字 */
export function windFromName(u: number, v: number): string {
  const deg = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360; // 0 = 北风（从北吹来）
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return names[Math.round(deg / 45) % 8] + '风';
}
