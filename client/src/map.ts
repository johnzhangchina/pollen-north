import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { wgs84ToGcj02 } from './geo.ts';

/**
 * 底图预设（VITE_TILE_PRESET）：
 *  amap     高德栅格瓦片，中文、国内快、免 key；GCJ-02 坐标（默认）。注意其服务条款未开放第三方直连，个人研究用。
 *  tianditu 天地图，中文、官方、WGS84；需 VITE_TIANDITU_KEY（个人免费申请）。上线的正规选择。
 *  osm      OpenStreetMap 标准图，中国境内中文，境外为当地语言；国内访问慢。
 *  esri     Esri 浅灰底图，英文。
 * 站点、先验区等 WGS84 数据在 GCJ-02 底图上显示时做同向偏移；风场和推算色块（25 km 格）不做转换，误差 <1 km。
 */
export type BasemapCrs = 'wgs84' | 'gcj02';
let basemapCrs: BasemapCrs = 'wgs84';

export function getBasemapCrs(): BasemapCrs {
  return basemapCrs;
}

/** WGS84 → 当前底图坐标系（用于叠加 WGS84 数据） */
export function displayLatLng(lat: number, lng: number): [number, number] {
  return basemapCrs === 'gcj02' ? wgs84ToGcj02(lat, lng) : [lat, lng];
}

export function createMap(el: HTMLElement): L.Map {
  const map = L.map(el, {
    center: [36.5, 105.5],
    zoom: 4,
    minZoom: 3,
    maxZoom: 11,
    zoomSnap: 0.5,
    maxBoundsViscosity: 0.7, // 拖动范围见 updateMaxBounds
    preferCanvas: true,
    worldCopyJump: false,
    fadeAnimation: false, // 瓦片不做淡入，避免 rAF 被节流时瓦片停在透明态
  });

  const preset = import.meta.env.VITE_TILE_PRESET ?? 'amap';
  const tk = import.meta.env.VITE_TIANDITU_KEY ?? '';

  if (preset === 'tianditu' && tk) {
    L.tileLayer(`https://t{s}.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk=${tk}`, {
      subdomains: '01234567',
      attribution: '© 天地图',
      maxZoom: 18,
    }).addTo(map);
    L.tileLayer(`https://t{s}.tianditu.gov.cn/DataServer?T=cva_w&x={x}&y={y}&l={z}&tk=${tk}`, {
      subdomains: '01234567',
      maxZoom: 18,
      pane: 'shadowPane',
    }).addTo(map);
  } else if (preset === 'osm') {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
  } else if (preset === 'esri') {
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri',
      maxZoom: 16,
    }).addTo(map);
  } else if (preset === 'carto') {
    // CARTO 公共瓦片现已要求 API key
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      attribution: '© OpenStreetMap contributors © CARTO',
      maxZoom: 19,
    }).addTo(map);
  } else {
    basemapCrs = 'gcj02';
    el.classList.add('basemap-amap');
    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: '1234',
      attribution: '© 高德地图（GCJ-02）',
      maxZoom: 18,
    }).addTo(map);
  }
  // 用 setTimeout 而不是 rAF：页面在后台标签页打开时 rAF 不会触发，取景就永远不执行
  setTimeout(() => {
    map.invalidateSize();
    fitChina(map);
  }, 0);
  map.on('resize', () => fitChina(map, false));
  map.on('zoomend', () => updateMaxBounds(map));
  return map;
}

/**
 * 允许拖动的范围：中国外扩半个视口。maxBounds 必须不小于视口，
 * 否则窄屏（手机）上 Leaflet 会把视野硬推到一侧。
 */
function updateMaxBounds(map: L.Map) {
  const z = map.getZoom();
  const half = map.getSize().divideBy(2);
  const nw = map.unproject(map.project(CHINA_BOUNDS.getNorthWest(), z).subtract(half), z);
  const se = map.unproject(map.project(CHINA_BOUNDS.getSouthEast(), z).add(half), z);
  map.setMaxBounds(L.latLngBounds([Math.max(-85, se.lat), nw.lng], [Math.min(85, nw.lat), se.lng]));
}

/** 全国范围（WGS84，含少量余量） */
export const CHINA_BOUNDS = L.latLngBounds([17, 72], [54.5, 136]);

/**
 * 按容器大小决定最小缩放：刚好放下整个中国的级别（手机约 3，桌面宽屏约 4），
 * 再缩小就只剩一小块中国和大片境外。首次加载把视野对准全国。
 */
export function fitChina(map: L.Map, reset = true) {
  // 手机上底部抽屉盖在地图上，取景时把这段高度留出来
  const panel = document.getElementById('panel');
  const covered = panel && getComputedStyle(panel).position === 'absolute' ? panel.offsetHeight : 0;
  const z = Math.max(3, Math.floor(map.getBoundsZoom(CHINA_BOUNDS, false, L.point(0, covered)) * 2) / 2);
  map.setMinZoom(z);
  if (reset) map.fitBounds(CHINA_BOUNDS, { animate: false, paddingBottomRight: [0, covered] });
  else if (map.getZoom() < z) map.setZoom(z, { animate: false });
  updateMaxBounds(map);
}
