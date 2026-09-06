import * as L from 'leaflet';
import type { City, CityLatest, LatestResponse, PollenDay, SeasonLevel } from '../../shared/types.ts';
import { levelColor, levelName } from '../../shared/levels.ts';
import type { StationFit } from './dispersion.ts';
import { displayLatLng } from './map.ts';

export function sparklineSvg(history: PollenDay[], levels: SeasonLevel[]): string {
  const w = 26;
  const H = 46;
  const bars = history
    .map((d, i) => {
      const lc = d.levelCode;
      const h = lc == null ? 3 : 6 + lc * 7;
      const color = lc == null ? '#d0d0d0' : levelColor(lc, levels);
      return `<rect x="${i * w + 3}" y="${H - h}" width="${w - 6}" height="${h}" rx="2" fill="${color}"><title>${d.date} ${d.level}</title></rect>`;
    })
    .join('');
  const first = history[0]?.date.slice(5) ?? '';
  const last = history[history.length - 1]?.date.slice(5) ?? '';
  return `<svg class="spark" viewBox="0 0 ${history.length * w} ${H + 14}" width="${history.length * w}" height="${H + 14}">${bars}<text x="3" y="${H + 11}" font-size="9" fill="#777">${first}</text><text x="${history.length * w - 3}" y="${H + 11}" font-size="9" fill="#777" text-anchor="end">${last}</text></svg>`;
}

export class StationLayer {
  private map: L.Map;
  private cities: City[];
  private levels: SeasonLevel[];
  private markers = new Map<string, L.CircleMarker>();
  private group: L.LayerGroup;
  private latest = new Map<string, CityLatest>();
  private fit = new Map<string, StationFit>();
  private today = '';
  private highlight: (c: City) => boolean = () => true;

  constructor(map: L.Map, cities: City[], levels: SeasonLevel[]) {
    this.map = map;
    this.cities = cities;
    this.levels = levels;
    this.group = L.layerGroup().addTo(map);
    for (const c of cities) {
      const m = L.circleMarker(displayLatLng(c.lat, c.lng), {
        radius: c.core ? 8 : 6,
        weight: 2,
        color: '#ffffff',
        fillColor: '#bdbdbd',
        fillOpacity: 0.95,
      });
      m.bindTooltip(c.name, { direction: 'top', offset: [0, -8] });
      m.bindPopup(() => this.popupHtml(c), { maxWidth: 340 });
      m.addTo(this.group);
      this.markers.set(c.code, m);
    }
  }

  update(resp: LatestResponse) {
    this.today = resp.today;
    for (const cl of resp.cities) this.latest.set(cl.city, cl);
    this.restyle();
  }

  setLevels(levels: SeasonLevel[]) {
    this.levels = levels;
    this.restyle();
  }

  setFit(fits: StationFit[]) {
    this.fit = new Map(fits.map((f) => [f.code, f]));
  }

  setVisible(v: boolean) {
    if (v) this.group.addTo(this.map);
    else this.group.remove();
  }

  /** 边界面加载后把站点圆点提到最上层 */
  bringToFront() {
    for (const m of this.markers.values()) m.bringToFront();
  }

  setHighlight(pred: (c: City) => boolean) {
    this.highlight = pred;
    this.restyle();
  }

  focus(code: string) {
    const c = this.cities.find((x) => x.code === code);
    const m = this.markers.get(code);
    if (!c || !m) return;
    this.map.flyTo(displayLatLng(c.lat, c.lng), Math.max(this.map.getZoom(), 6), { duration: 0.6 });
    setTimeout(() => m.openPopup(), 650);
  }

  private restyle() {
    for (const c of this.cities) {
      const m = this.markers.get(c.code)!;
      const lc = this.latest.get(c.code)?.latest?.levelCode ?? null;
      const hl = this.highlight(c);
      m.setStyle({
        fillColor: levelColor(lc, this.levels),
        fillOpacity: hl ? 0.95 : 0.35,
        opacity: hl ? 1 : 0.4,
        radius: c.core ? 8 : 6,
      });
      if (hl) m.bringToFront();
    }
  }

  private popupHtml(c: City): string {
    const l = this.latest.get(c.code);
    const latest = l?.latest ?? null;
    const fc = l?.forecast ?? null;
    const fit = this.fit.get(c.code);
    const lv = this.levels;
    const head = `<div class="pop-head"><b>${c.name}</b>${c.core ? ' <em class="core">重点</em>' : ''} <span class="chip" style="background:${levelColor(latest?.levelCode, lv)}">${levelName(latest?.levelCode, lv)}</span></div>`;
    if (!latest) return `<div class="pop">${head}<p class="muted">最近 7 天上游都是"暂无"（非花粉季或医院未上报）。</p></div>`;
    const stale = latest.date !== this.today ? `<span class="muted">（今日暂无，显示最近有值）</span>` : '';
    return `<div class="pop">${head}
<div class="pop-date">实测 ${latest.date} 08:00 ${stale}</div>
<div class="pop-msg">${latest.msg}</div>
${fc ? `<div class="pop-fc">上游明日预报：<span class="chip" style="background:${levelColor(fc.levelCode, lv)}">${fc.level}</span> <span class="muted">${fc.date}</span></div>` : ''}
${l?.history?.length ? sparklineSvg(l.history, lv) : ''}
${fit ? `<div class="pop-fit">模型推算（校准后）：<span class="chip" style="background:${levelColor(fit.modelLevel, lv)}">${levelName(fit.modelLevel, lv)}</span> <span class="muted">≈ ${fit.modelConc.toFixed(0)} 粒/千mm² 当量</span></div>` : ''}
<div class="pop-src">来源：中国天气网 × 北京同仁医院 花粉过敏指数（仅等级）</div>
</div>`;
  }
}
