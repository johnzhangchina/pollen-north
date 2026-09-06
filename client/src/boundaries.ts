import * as L from 'leaflet';
import type { City, CityLatest, LatestResponse, SeasonLevel } from '../../shared/types.ts';
import { levelColor, levelIndexFor, levelName } from '../../shared/levels.ts';
import { concAt, type ModelResult } from './dispersion.ts';
import { pointInPolygon, wgs84ToGcj02 } from './geo.ts';
import { fmtCN } from './geo.ts';

export interface BoundaryProps {
  adcode: number;
  name: string;
  center: [number, number];
  centroid: [number, number];
  province: string;
  provinceAdcode: number;
}
export type BoundaryFC = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon, BoundaryProps>;

/** 站点城市名 → 行政区名（去掉"市/盟"等后缀后比较） */
const ALIASES: Record<string, string> = { 乌兰浩特: '兴安盟' };
export function normalizeName(n: string): string {
  return n.replace(/(市|盟|地区|自治州|自治区|特别行政区)$/, '');
}

/**
 * 地级市边界层：有站点的城市按实测等级填色并标名；其余城市只画细边，悬停显示推算等级。
 * 边界数据为 GCJ-02（与高德底图一致）。
 */
export class BoundaryLayer {
  private map: L.Map;
  private group = L.layerGroup();
  private labelsStation = L.layerGroup();
  private labelsStationMinor = L.layerGroup(); // 非重点站，缩得很小时隐藏
  private labelsOther = L.layerGroup();
  private geo: L.GeoJSON | null = null;
  private cityByAdcode = new Map<number, City>();
  private features: GeoJSON.Feature<GeoJSON.Geometry, BoundaryProps>[] = [];
  private layerByAdcode = new Map<number, L.Layer>();
  private latest = new Map<string, CityLatest>();
  private levels: SeasonLevel[];
  private model: ModelResult | null = null;
  private tIdx = 0;
  private today = '';
  private visible = true;
  private onCityClick: (code: string) => void;

  constructor(map: L.Map, levels: SeasonLevel[], onCityClick: (code: string) => void) {
    this.map = map;
    this.levels = levels;
    this.onCityClick = onCityClick;
    this.group.addTo(map);
    this.labelsStation.addTo(this.group);
    map.on('zoomend', this.updateLabelVisibility, this);
  }

  setData(fc: BoundaryFC, cities: City[]) {
    this.cityByAdcode.clear();
    for (const f of fc.features) {
      const n = normalizeName(f.properties.name);
      const c = cities.find((x) => (ALIASES[x.name] ?? x.name) === n);
      if (c) this.cityByAdcode.set(f.properties.adcode, c);
    }
    this.features = fc.features as GeoJSON.Feature<GeoJSON.Geometry, BoundaryProps>[];
    this.layerByAdcode.clear();
    if (this.geo) this.group.removeLayer(this.geo);
    this.labelsStation.clearLayers();
    this.labelsStationMinor.clearLayers();
    this.labelsOther.clearLayers();
    this.geo = L.geoJSON(fc as GeoJSON.GeoJsonObject, {
      style: (f) => this.styleFor(f as GeoJSON.Feature<GeoJSON.Geometry, BoundaryProps>),
      onEachFeature: (f, layer) => {
        const feat = f as GeoJSON.Feature<GeoJSON.Geometry, BoundaryProps>;
        this.layerByAdcode.set(feat.properties.adcode, layer);
        layer.bindTooltip(() => this.tooltipFor(feat), { sticky: true, direction: 'top', className: 'bd-tip' });
        layer.on('click', () => {
          const c = this.cityByAdcode.get(feat.properties.adcode);
          if (c) this.onCityClick(c.code);
        });
        const [lng, lat] = feat.properties.centroid ?? feat.properties.center;
        const c = this.cityByAdcode.get(feat.properties.adcode);
        const label = L.marker([lat, lng], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: c ? 'city-label' : 'city-label other',
            html: `<span>${feat.properties.name.replace(/市$/, '')}</span>`, // 标注只去掉"市"，保留"盟/自治州"
            iconSize: [0, 0],
          }),
        });
        (c ? (c.core ? this.labelsStation : this.labelsStationMinor) : this.labelsOther).addLayer(label);
      },
    });
    this.group.addLayer(this.geo);
    this.updateLabelVisibility();
  }

  update(resp: LatestResponse) {
    this.today = resp.today;
    for (const c of resp.cities) this.latest.set(c.city, c);
    this.restyle();
  }

  setLevels(levels: SeasonLevel[]) {
    this.levels = levels;
    this.restyle();
  }

  setModel(m: ModelResult | null) {
    this.model = m;
  }

  setTime(t: number) {
    this.tIdx = t;
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.group.addTo(this.map);
    else this.group.remove();
  }

  /** 没有监测站的地级市列表（供搜索） */
  otherCities(): { name: string; adcode: number; province: string; center: [number, number] }[] {
    return this.features
      .filter((f) => !this.cityByAdcode.has(f.properties.adcode))
      .map((f) => ({ name: f.properties.name, adcode: f.properties.adcode, province: f.properties.province, center: f.properties.centroid ?? f.properties.center }));
  }

  /** WGS84 经纬度落在哪个地级市面里（边界是 GCJ-02，先做同向偏移） */
  findAt(lat: number, lng: number): { name: string; adcode: number; province: string; city: City | null } | null {
    const [glat, glng] = wgs84ToGcj02(lat, lng);
    for (const f of this.features) {
      const g = f.geometry;
      const polys: number[][][][] = g.type === 'Polygon' ? [g.coordinates as number[][][]] : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]) : [];
      for (const poly of polys) {
        if (pointInPolygon(glng, glat, poly[0] as [number, number][])) {
          return { name: f.properties.name, adcode: f.properties.adcode, province: f.properties.province, city: this.cityByAdcode.get(f.properties.adcode) ?? null };
        }
      }
    }
    return null;
  }

  /** 飞到某个地级市并弹出它的推算/实测说明 */
  focusFeature(adcode: number) {
    const layer = this.layerByAdcode.get(adcode) as (L.Layer & { getBounds?: () => L.LatLngBounds }) | undefined;
    const feat = this.features.find((f) => f.properties.adcode === adcode);
    if (!layer || !feat) return;
    if (layer.getBounds) this.map.flyToBounds(layer.getBounds(), { maxZoom: 8, duration: 0.6, padding: [30, 30] });
    const [lng, lat] = feat.properties.centroid ?? feat.properties.center;
    setTimeout(() => L.popup({ maxWidth: 300 }).setLatLng([lat, lng]).setContent(this.tooltipFor(feat)).openOn(this.map), 650);
  }

  private updateLabelVisibility() {
    const z = this.map.getZoom();
    if (z >= 7) this.group.addLayer(this.labelsOther);
    else this.group.removeLayer(this.labelsOther);
    // 全国视野（手机上约 3 级）只标重点站，否则京津冀一带的名字叠成一团
    if (z >= 4) this.group.addLayer(this.labelsStationMinor);
    else this.group.removeLayer(this.labelsStationMinor);
  }

  private restyle() {
    this.geo?.setStyle((f) => this.styleFor(f as GeoJSON.Feature<GeoJSON.Geometry, BoundaryProps>));
  }

  private styleFor(f: GeoJSON.Feature<GeoJSON.Geometry, BoundaryProps>): L.PathOptions {
    const c = this.cityByAdcode.get(f.properties.adcode);
    if (c) {
      const lc = this.latest.get(c.code)?.latest?.levelCode ?? null;
      return { color: '#ffffff', weight: 1.6, fillColor: levelColor(lc, this.levels), fillOpacity: lc == null ? 0.12 : 0.55 };
    }
    return { color: 'rgba(60,60,60,0.45)', weight: 0.8, dashArray: '3 3', fill: true, fillOpacity: 0 };
  }

  private tooltipFor(f: GeoJSON.Feature<GeoJSON.Geometry, BoundaryProps>): string {
    const c = this.cityByAdcode.get(f.properties.adcode);
    const name = f.properties.name;
    if (c) {
      const l = this.latest.get(c.code)?.latest;
      if (!l) return `<b>${name}</b><br/>有监测站，近期暂无数据`;
      return `<b>${name}</b> · 实测 <b>${levelName(l.levelCode, this.levels)}</b><br/><span class="muted">${l.date}${l.date !== this.today ? '（最近有值）' : ''} · 点击看详情</span>`;
    }
    if (this.model) {
      const [lng, lat] = f.properties.centroid ?? f.properties.center;
      const conc = concAt(this.model, this.tIdx, lng, lat);
      if (conc != null) {
        const lvl = levelIndexFor(conc, this.levels);
        return `<b>${name}</b> · 推算 <b>${levelName(lvl, this.levels)}</b><br/><span class="muted">${fmtCN(this.model.times[Math.min(this.model.times.length - 1, Math.max(0, Math.round(this.tIdx)))])} · 无监测站 · 24 h 均值推算，仅供参考</span>`;
      }
    }
    return `<b>${name}</b><br/><span class="muted">无监测站，超出推算范围</span>`;
  }
}
