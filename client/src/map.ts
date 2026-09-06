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
    minZoom: 4, // 再缩小就只剩一小块中国和大片境外，没有信息
    maxZoom: 11,
    maxBounds: [
      [8, 62],
      [60, 148],
    ], // 允许拖动的范围：中国周边一圈
    maxBoundsViscosity: 0.7,
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
  requestAnimationFrame(() => map.invalidateSize());
  return map;
}
