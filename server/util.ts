import fs from 'node:fs';

const cnDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 北京时间的今天（YYYY-MM-DD） */
export function todayCN(offsetDays = 0): string {
  return cnDate.format(new Date(Date.now() + offsetDays * 86400000));
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
