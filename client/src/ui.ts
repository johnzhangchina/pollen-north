import type { City, CityLatest, OfficialAlert, Region, SeasonLevel } from '../../shared/types.ts';
import { levelColor, levelIndexFor, levelName } from '../../shared/levels.ts';
import { fmtCN } from './geo.ts';
import { meanConcInBbox, type ModelResult } from './dispersion.ts';

export type RegionKey = 'core' | Region | 'all';
export const REGION_LABELS: Record<RegionKey, string> = {
  core: '重点',
  northwest: '西北',
  neimeng: '内蒙',
  north: '华北',
  northeast: '东北',
  east: '华东',
  central: '华中',
  south: '华南',
  southwest: '西南',
  all: '全部',
};
export function regionPred(key: RegionKey): (c: City) => boolean {
  if (key === 'all') return () => true;
  if (key === 'core') return (c) => c.core;
  return (c) => c.region === key;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

export function setStatus(html: string) {
  $('#status').innerHTML = html;
}

export function initTabs() {
  const nav = $('#tabs');
  nav.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const tab = b.dataset.tab!;
    nav.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll<HTMLElement>('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  });
}

export function renderLegend(levels: SeasonLevel[], season: string | null) {
  $('#legend').innerHTML =
    `<span class="legend-title">${season ?? ''}花粉等级</span>` +
    levels
      .slice(1)
      .map(
        (l) =>
          `<span class="legend-item" title="${l.desc ?? ''}"><i style="background:${l.color}"></i>${l.level}<small>${l.minNum}${l.maxNum == null || l.maxNum >= 9000 ? '+' : `–${l.maxNum}`}</small></span>`,
      )
      .join('') +
    `<span class="legend-unit">粒/千平方毫米 · 城市填色/圆点=实测日值 · 底层色块=推算的 24 h 均值（同一尺度）</span>`;
}

export interface LayerState {
  boundaries: boolean;
  stations: boolean;
  particles: boolean;
  heat: boolean;
  hourly: boolean;
  priors: boolean;
}

export function renderLayerToggles(state: LayerState, onChange: (k: keyof LayerState, v: boolean) => void) {
  const labels: Record<keyof LayerState, string> = {
    boundaries: '城市边界',
    stations: '站点实测',
    particles: '风粒子',
    heat: '花粉推算',
    hourly: '显示逐小时瞬时值',
    priors: '来源先验',
  };
  const el = $('#layers');
  el.innerHTML = (Object.keys(labels) as (keyof LayerState)[])
    .map((k) => `<label><input type="checkbox" data-k="${k}" ${state[k] ? 'checked' : ''}/> ${labels[k]}</label>`)
    .join('');
  el.addEventListener('change', (e) => {
    const i = e.target as HTMLInputElement;
    onChange(i.dataset.k as keyof LayerState, i.checked);
  });
}

export interface TimeControl {
  set(idx: number): void;
  get(): number;
}

export function initTime(times: number[], initial: number, onChange: (idx: number) => void): TimeControl {
  const input = $<HTMLInputElement>('#time');
  const label = $('#time-label');
  const play = $<HTMLButtonElement>('#play');
  input.min = '0';
  input.max = String(times.length - 1);
  const nowIdx = initial;
  const update = (idx: number, fire = true) => {
    input.value = String(idx);
    const rel = idx - nowIdx;
    const relTxt = rel === 0 ? '现在' : rel > 0 ? `+${rel}h` : `${rel}h`;
    label.textContent = `${fmtCN(times[idx])}（${relTxt}）`;
    if (fire) onChange(idx);
  };
  input.addEventListener('input', () => update(Number(input.value)));
  let timer: number | null = null;
  play.addEventListener('click', () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      play.textContent = '▶';
      return;
    }
    play.textContent = '⏸';
    timer = window.setInterval(() => {
      let i = Number(input.value) + 1;
      if (i > times.length - 1) i = 0;
      update(i);
    }, 450);
  });
  update(initial, false);
  return { set: (i) => update(i), get: () => Number(input.value) };
}

export function renderRegionFilter(current: RegionKey, onChange: (k: RegionKey) => void) {
  const el = $('#region-filter');
  const keys: RegionKey[] = ['core', 'northwest', 'neimeng', 'north', 'northeast', 'east', 'central', 'south', 'southwest', 'all'];
  el.innerHTML = keys.map((k) => `<button data-k="${k}" class="${k === current ? 'active' : ''}">${REGION_LABELS[k]}</button>`).join('');
  el.onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    onChange(b.dataset.k as RegionKey);
  };
}

/** 7 天等级小方块（最早在左，今天在右） */
function historyBars(history: CityLatest['history'] | undefined, levels: SeasonLevel[]): string {
  if (!history?.length) return '';
  return `<span class="bars" title="近 7 天">${history
    .slice(-7)
    .map((d) => `<i style="background:${d.levelCode == null ? '#e5e7eb' : levelColor(d.levelCode, levels)}" title="${d.date.slice(5)} ${d.level}"></i>`)
    .join('')}</span>`;
}

function trendArrow(today: number | null, tomorrow: number | null): string {
  if (today == null || tomorrow == null) return '';
  if (tomorrow > today) return '<span class="trend up" title="明日升高">↑</span>';
  if (tomorrow < today) return '<span class="trend down" title="明日降低">↓</span>';
  return '<span class="trend flat" title="明日持平">→</span>';
}

export function renderCityList(
  cities: City[],
  latest: Map<string, CityLatest>,
  levels: SeasonLevel[],
  pred: (c: City) => boolean,
  onClick: (code: string) => void,
) {
  const el = $('#city-list');
  const rows = cities
    .filter(pred)
    .map((c) => ({ c, l: latest.get(c.code) }))
    .sort((a, b) => (b.l?.latest?.levelCode ?? -1) - (a.l?.latest?.levelCode ?? -1) || a.c.name.localeCompare(b.c.name, 'zh'));
  el.innerHTML =
    rows
      .map(({ c, l }) => {
        const lc = l?.latest?.levelCode ?? null;
        const fc = l?.forecast;
        const color = levelColor(lc, levels);
        return `<li data-code="${c.code}" style="--lc:${color}">
<span class="bar"></span>
<span class="name">${c.name}${c.core ? ' <em>重点</em>' : ''}<small class="region">${REGION_LABELS[c.region]}</small></span>
<span class="chip" style="background:${color}">${levelName(lc, levels)}</span>
<span class="meta">${l?.latest ? `实测 ${l.latest.date.slice(5)}` : '暂无数据'}${fc ? ` · 明日 ${fc.level}` : ''}${trendArrow(lc, fc?.levelCode ?? null)}</span>
${historyBars(l?.history, levels)}
</li>`;
      })
      .join('') || '<li class="empty">暂无数据</li>';
  el.onclick = (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (li?.dataset.code) onClick(li.dataset.code);
  };
}

// ---------------- 搜索 ----------------
export interface SearchItem {
  kind: 'station' | 'other';
  name: string;
  sub: string; // 区域 / 省份
  key: string; // 站点：pinyin code；其他：adcode
  levelCode?: number | null;
}

export function renderSearch(items: () => SearchItem[], levels: () => SeasonLevel[], onPick: (item: SearchItem) => void) {
  const input = $<HTMLInputElement>('#search');
  const list = $<HTMLUListElement>('#search-results');
  let current: SearchItem[] = [];
  const close = () => {
    list.hidden = true;
    list.innerHTML = '';
    current = [];
  };
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return close();
    const norm = (s: string) => s.replace(/(市|地区|自治州|盟|特别行政区)$/, '').toLowerCase();
    const scored = items()
      .map((it) => {
        const n = norm(it.name);
        let score = -1;
        if (n === q || it.key === q) score = 0;
        else if (n.startsWith(q) || it.key.startsWith(q)) score = 1;
        else if (n.includes(q) || it.name.includes(q)) score = 2;
        return { it, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || (a.it.kind === 'station' ? -1 : 1) - (b.it.kind === 'station' ? -1 : 1) || a.it.name.localeCompare(b.it.name, 'zh'))
      .slice(0, 8);
    current = scored.map((x) => x.it);
    if (!current.length) {
      list.innerHTML = '<li class="empty">没有匹配的城市</li>';
      list.hidden = false;
      return;
    }
    const lv = levels();
    list.innerHTML = current
      .map(
        (it, i) =>
          `<li data-i="${i}"><span class="name">${it.name}</span><small>${it.sub}</small>${
            it.kind === 'station'
              ? `<span class="chip" style="background:${levelColor(it.levelCode, lv)}">${levelName(it.levelCode, lv)}</span>`
              : '<span class="tag">无监测站 · 看推算</span>'
          }</li>`,
      )
      .join('');
    list.hidden = false;
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && current[0]) {
      onPick(current[0]);
      input.blur();
      close();
    } else if (e.key === 'Escape') {
      input.value = '';
      close();
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (!li?.dataset.i) return;
    e.preventDefault();
    onPick(current[Number(li.dataset.i)]);
    input.value = '';
    close();
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.search-box')) close();
  });
}

// ---------------- 我的位置 ----------------
export type LocateState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ok';
      lat: number;
      lng: number;
      area: string | null; // 所在地级市
      nearest: { city: City; km: number; latest: CityLatest | undefined };
      modelLevel: number | null;
      wind: { name: string; speed: number } | null;
      updatedAt: string;
    };

export function renderLocate(state: LocateState, levels: SeasonLevel[], onLocate: () => void, onShow: () => void, onCity: (code: string) => void) {
  const el = $('#locate-card');
  if (state.kind === 'idle' || state.kind === 'error') {
    el.innerHTML = `<div class="loc-row"><span class="loc-icon">📍</span><div class="loc-body"><b>我的位置</b><div class="muted small">${
      state.kind === 'error' ? state.message : '定位后告诉你所在城市的实测等级和周边推算'
    }</div></div><button class="btn" data-act="locate">${state.kind === 'error' ? '重试' : '定位'}</button></div>`;
  } else if (state.kind === 'locating') {
    el.innerHTML = `<div class="loc-row"><span class="loc-icon">📍</span><div class="loc-body"><b>正在定位…</b><div class="muted small">浏览器会询问是否允许获取位置</div></div></div>`;
  } else {
    const n = state.nearest;
    const nl = n.latest?.latest ?? null;
    const nf = n.latest?.forecast ?? null;
    const mlColor = levelColor(state.modelLevel, levels);
    el.innerHTML = `<div class="loc-head"><span class="loc-icon">📍</span><b>${state.area ?? '我的位置'}</b><span class="muted small">${state.updatedAt}</span><button class="btn ghost" data-act="show">在地图上看</button></div>
<div class="loc-grid">
  <div class="loc-cell"><span class="lbl">周边推算</span><span class="chip big" style="background:${mlColor}">${levelName(state.modelLevel, levels)}</span><span class="muted small">24 h 均值，参考用</span></div>
  <div class="loc-cell clickable" data-act="city" data-code="${n.city.code}"><span class="lbl">最近监测站 · ${n.city.name}${n.km >= 1 ? ` ${n.km.toFixed(0)} km` : ''}</span><span class="chip big" style="background:${levelColor(nl?.levelCode, levels)}">${levelName(nl?.levelCode, levels)}</span><span class="muted small">${
      nl ? `实测 ${nl.date.slice(5)}${nf ? ` · 明日 ${nf.level}` : ''}` : '近期暂无数据'
    }</span></div>
</div>
${state.wind ? `<div class="loc-wind muted small">此刻 ${state.wind.name} ${state.wind.speed.toFixed(1)} m/s${state.wind.speed >= 3 ? '，上风向的花粉更容易被吹过来' : '，风弱，以本地来源为主'}</div>` : ''}`;
  }
  el.onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'locate') onLocate();
    else if (t.dataset.act === 'show') onShow();
    else if (t.dataset.act === 'city' && t.dataset.code) onCity(t.dataset.code);
  };
}

export function renderCompare(
  alerts: OfficialAlert[],
  cities: City[],
  latest: Map<string, CityLatest>,
  model: ModelResult | null,
  tIdx: number,
  levels: SeasonLevel[],
) {
  const el = $('#tab-compare');
  const chip = (code: number | null | undefined, text?: string) =>
    `<span class="chip" style="background:${levelColor(code, levels)}">${text ?? levelName(code, levels)}</span>`;
  const alertHtml = alerts.length
    ? alerts
        .map((a) => {
          const rows = a.regions
            .map((r) => {
              const inBox = cities.filter((c) => c.lng >= r.bbox[0] && c.lng <= r.bbox[2] && c.lat >= r.bbox[1] && c.lat <= r.bbox[3]);
              const obs = inBox.map((c) => latest.get(c.code)?.latest?.levelCode).filter((x): x is number => x != null);
              const obsMean = obs.length ? obs.reduce((s, x) => s + x, 0) / obs.length : null;
              const mc = model ? meanConcInBbox(model, tIdx, r.bbox) : null;
              const ml = mc == null ? null : levelIndexFor(mc, levels);
              return `<tr><td>${r.name}</td><td>${chip(r.level, `${r.level} 级`)}</td><td>${
                obsMean == null ? '—' : `${chip(Math.round(obsMean))} <small>${obsMean.toFixed(1)} · ${obs.length} 站</small>`
              }</td><td>${ml == null ? '—' : `${chip(ml)} <small>≈${mc!.toFixed(0)}</small>`}</td></tr>`;
            })
            .join('');
          return `<article class="card"><h3>${a.source}</h3><p class="muted small">发布 ${a.issued.slice(0, 16).replace('T', ' ')} · 时段 ${a.period[0]} ~ ${a.period[1]} · ${a.pollenType}</p>
<table class="cmp"><thead><tr><th>区域</th><th>官方</th><th>站点实测</th><th>推算(24 h 均值)</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted small">${a.thresholds}</p>${a.note ? `<p class="muted small">${a.note}</p>` : ''}${a.url ? `<p class="small"><a href="${a.url}" target="_blank" rel="noopener">原文</a></p>` : ''}</article>`;
        })
        .join('')
    : '<p class="muted">还没有录入官方预报。把每周发布的《花粉浓度预报服务提示》整理进 data/official_alerts.json 即可对照。</p>';

  const fitHtml = model
    ? `<article class="card"><h3>模型校准诊断</h3><p class="muted small">全局系数 ${model.globalFactor.toPrecision(3)} · 参与校准 ${
        model.stationFit.filter((f) => f.calibrated).length
      }/${model.stationFit.length} 站 · 参考时刻 ${model.refEpoch ? fmtCN(model.refEpoch) : '—'}</p>
<table class="cmp"><thead><tr><th>站点</th><th>实测</th><th>推算</th><th>偏差</th></tr></thead><tbody>${model.stationFit
        .map((f) => {
          const d = f.modelLevel - f.obsLevel;
          return `<tr><td>${f.name}</td><td>${chip(f.obsLevel)}</td><td>${chip(f.modelLevel)}</td><td class="${d === 0 ? 'ok' : Math.abs(d) === 1 ? 'warn' : 'bad'}">${d > 0 ? '+' : ''}${d}</td></tr>`;
        })
        .join('')}</tbody></table></article>`
    : '';
  el.innerHTML = alertHtml + fitHtml;
}

export function renderAbout() {
  $('#tab-about').innerHTML = `
<article class="card">
<h3>这是什么</h3>
<p>全国 53 个花粉监测城市的等级地图，叠加风场和一个简化的扩散趋势推算。重点城市：银川、兰州、呼和浩特、包头、鄂尔多斯、乌海、赤峰、乌兰浩特。</p>
<h3>数据来源</h3>
<ul>
<li><b>站点实测</b>：中国天气网 × 北京同仁医院"花粉过敏指数"。各地医院每天早 8 点显微镜计数，上游只公开 5 档等级（分级单位 粒/千平方毫米），本站每 6 小时抓一次并保留历史。</li>
<li><b>植被/土地覆盖</b>：Copernicus Global Land Service LC100（2019，100 m，CC BY 4.0），聚合到 0.1° 的草地、灌丛、农田、稀疏植被、林地、建成区占比，作为推算的排放底图。</li>
<li><b>风场</b>：Open-Meteo（CC BY 4.0，非商用免费）。10 米风速风向、降水，逐小时，含昨日和未来 3 天。</li>
<li><b>官方对照</b>：国家卫健委、中国气象局每周一期的《花粉浓度预报服务提示》，手工录入。</li>
</ul>
<h3>推算是怎么算的</h3>
<p>以土地覆盖占比为排放底图：秋季按草地、稀疏植被（荒漠草原）、灌丛、收后农田加权，春季按林地和城市绿化加权；手工圈定的蒿属/藜科集中区只作放大权重，没有植被数据时退回手工多边形。排放乘物候曲线和日变化，用风场逐小时平流，扣掉沉降和降水清除，再用站点实测标定排放强度。最后再按站点实测对浓度场做一次局地修正，让有监测站的城市及其周边和实测等级一致。地图默认画的是<b>截至所选时刻的 24 小时均值</b>，与实测日值同尺度；勾选"显示逐小时瞬时值"可看到午后峰值、夜间低谷的起伏。它表达的是"花粉大概从哪来、往哪去"，<b>不是浓度预报</b>。</p>
<h3>请注意</h3>
<ul>
<li>内容仅供个人防护参考，不构成医疗建议，也不是气象部门的官方预报。</li>
<li>本项目不拥有上游数据版权；上游接口未公开，随时可能变化。</li>
<li>站点是一城一点的日值，推算层在远离站点的地方只有示意意义。</li>
</ul>
</article>`;
}
