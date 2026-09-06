import * as L from 'leaflet';
import type { SeasonLevel } from '../../shared/types.ts';
import { levelIndexFor } from '../../shared/levels.ts';
import type { ModelResult } from './dispersion.ts';

/** 推算浓度的等级色块层（canvas 放在 overlayPane 里，拖动时随地图平移，moveend 后重绘） */
export class HeatLayer {
  private map: L.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private model: ModelResult | null = null;
  private levels: SeasonLevel[];
  private tIdx = 0;
  private visible = true;
  opacity = 0.45;
  /** 很低（1 级）只淡淡地画，免得整片区域都被染成绿色 */
  lowLevelAlpha = 0.35;

  constructor(map: L.Map, levels: SeasonLevel[]) {
    this.map = map;
    this.levels = levels;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pn-canvas pn-heat';
    this.ctx = this.canvas.getContext('2d')!;
    map.getPanes().overlayPane.appendChild(this.canvas);
    map.on('moveend zoomend resize', this.render, this);
    map.on('zoomstart', this.hide, this);
    this.render();
  }

  private hide() {
    this.canvas.style.visibility = 'hidden';
  }

  setLevels(levels: SeasonLevel[]) {
    this.levels = levels;
    this.parseColors();
    this.render();
  }

  setModel(m: ModelResult | null) {
    this.model = m;
    this.render();
  }

  setTime(t: number) {
    const r = Math.round(t);
    if (r !== this.tIdx) {
      this.tIdx = r;
      this.render();
    }
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.render();
  }

  /** 国界遮罩：各地级市外环投影到 zoom 0 的世界像素坐标，渲染时只做缩放平移 */
  private maskRings: Float64Array[] = [];

  /** 用地级市边界把色块裁到中国境内，境外和海上不画 */
  setMask(fc: GeoJSON.FeatureCollection | null) {
    this.maskRings = [];
    this.maskPath = null;
    if (fc) {
      for (const f of fc.features) {
        const g = f.geometry;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
        for (const poly of polys) {
          const ring = poly[0];
          const arr = new Float64Array(ring.length * 2);
          for (let i = 0; i < ring.length; i++) {
            const pt = this.map.project([ring[i][1], ring[i][0]], 0);
            arr[i * 2] = pt.x;
            arr[i * 2 + 1] = pt.y;
          }
          this.maskRings.push(arr);
        }
      }
    }
    this.render();
  }

  private maskPath: { zoom: number; path: Path2D } | null = null;

  private applyMask(ctx: CanvasRenderingContext2D) {
    if (!this.maskRings.length) return;
    const map = this.map;
    const zoom = map.getZoom();
    // 路径按缩放级别缓存（顶点已按像素抽稀），平移时只改 translate
    if (!this.maskPath || this.maskPath.zoom !== zoom) {
      const scale = map.getZoomScale(zoom, 0);
      const path = new Path2D();
      for (const ring of this.maskRings) {
        let lx = NaN;
        let ly = NaN;
        for (let i = 0; i < ring.length; i += 2) {
          const x = ring[i] * scale;
          const y = ring[i + 1] * scale;
          if (i === 0) path.moveTo(x, y);
          else if (Math.abs(x - lx) + Math.abs(y - ly) < 0.7) continue;
          else path.lineTo(x, y);
          lx = x;
          ly = y;
        }
        path.closePath();
      }
      this.maskPath = { zoom, path };
    }
    // zoom 0 世界坐标原点在当前容器里的位置
    const o = map.latLngToContainerPoint(map.unproject(L.point(0, 0), 0));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.translate(o.x, o.y);
    ctx.fillStyle = '#000';
    ctx.fill(this.maskPath.path, 'nonzero');
    ctx.restore();
  }

  private mode: 'daily' | 'hourly' = 'daily';
  /** 像素块大小：越小越平滑，越大越快 */
  blockPx = 4;
  private off = document.createElement('canvas');
  private rgb: [number, number, number][] = [];

  /** daily = 24 h 均值（与实测日值同尺度，默认）；hourly = 逐小时瞬时值 */
  setMode(mode: 'daily' | 'hourly') {
    if (mode !== this.mode) {
      this.mode = mode;
      this.render();
    }
  }

  private parseColors() {
    this.rgb = this.levels.map((l) => {
      const h = l.color.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });
  }

  render() {
    const map = this.map;
    const size = map.getSize();
    if (this.canvas.width !== size.x || this.canvas.height !== size.y) {
      this.canvas.width = size.x;
      this.canvas.height = size.y;
    }
    L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
    this.canvas.style.visibility = this.visible ? 'visible' : 'hidden';
    const ctx = this.ctx;
    ctx.clearRect(0, 0, size.x, size.y);
    const m = this.model;
    if (!m || !this.visible || size.x === 0 || size.y === 0) return;
    if (this.rgb.length !== this.levels.length) this.parseColors();

    const t = Math.min(m.conc.length - 1, Math.max(0, this.tIdx));
    const grid = this.mode === 'daily' ? m.daily[t] : m.conc[t];

    // 按像素块双线性采样，画到小画布再放大，边界平滑而不是 0.25° 的方格
    const B = this.blockPx;
    const cols = Math.ceil(size.x / B);
    const rows = Math.ceil(size.y / B);
    // Web Mercator 可分离：列 → 经度，行 → 纬度
    const fxs = new Float64Array(cols);
    for (let c = 0; c < cols; c++) fxs[c] = (map.containerPointToLatLng([c * B + B / 2, 0]).lng - m.bbox[0]) / m.step;
    const fys = new Float64Array(rows);
    for (let r = 0; r < rows; r++) fys[r] = (map.containerPointToLatLng([0, r * B + B / 2]).lat - m.bbox[1]) / m.step;

    if (this.off.width !== cols || this.off.height !== rows) {
      this.off.width = cols;
      this.off.height = rows;
    }
    const octx = this.off.getContext('2d')!;
    const img = octx.createImageData(cols, rows);
    const px = img.data;
    const aFull = Math.round(this.opacity * 255);
    const aLow = Math.round(this.opacity * this.lowLevelAlpha * 255);
    const nx = m.nx;
    const ny = m.ny;
    for (let r = 0; r < rows; r++) {
      const fy = fys[r];
      if (!(fy >= 0 && fy <= ny - 1)) continue;
      let iy = Math.floor(fy);
      if (iy >= ny - 1) iy = ny - 2;
      const ty = fy - iy;
      for (let c = 0; c < cols; c++) {
        const fx = fxs[c];
        if (!(fx >= 0 && fx <= nx - 1)) continue;
        let ix = Math.floor(fx);
        if (ix >= nx - 1) ix = nx - 2;
        const tx = fx - ix;
        const i00 = iy * nx + ix;
        const v = (grid[i00] * (1 - tx) + grid[i00 + 1] * tx) * (1 - ty) + (grid[i00 + nx] * (1 - tx) + grid[i00 + nx + 1] * tx) * ty;
        const lvl = levelIndexFor(v, this.levels);
        if (lvl === 0) continue;
        const o = (r * cols + c) * 4;
        const col = this.rgb[lvl];
        px[o] = col[0];
        px[o + 1] = col[1];
        px[o + 2] = col[2];
        px[o + 3] = lvl === 1 ? aLow : aFull;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, 0, 0, cols, rows, 0, 0, cols * B, rows * B);
    this.applyMask(ctx);
  }
}
