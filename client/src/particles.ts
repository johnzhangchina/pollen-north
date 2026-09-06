import * as L from 'leaflet';
import type { WindField, WindSample } from './windfield.ts';
import { M_PER_DEG_LAT, mPerDegLng } from './geo.ts';

interface P {
  lat: number;
  lng: number;
  age: number;
}

// 按风速分桶着色（m/s）：<2, <4, <6, <9, <12, ≥12
const COLORS = [
  'rgba(70,120,190,0.50)',
  'rgba(60,100,190,0.60)',
  'rgba(75,75,190,0.70)',
  'rgba(115,55,180,0.80)',
  'rgba(155,40,160,0.85)',
  'rgba(195,30,120,0.90)',
];
const bucket = (s: number) => (s < 2 ? 0 : s < 4 ? 1 : s < 6 ? 2 : s < 9 ? 3 : s < 12 ? 4 : 5);

/** Windy 风格的风粒子层。拖动/缩放时暂停并清屏，结束后重置粒子。 */
export class ParticleLayer {
  private map: L.Map;
  private field: WindField;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: P[] = [];
  private tIdx = 0;
  private running = false;
  private paused = false;
  private visible = true;
  private raf = 0;
  private maxAge = 90;

  constructor(map: L.Map, field: WindField) {
    this.map = map;
    this.field = field;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pn-canvas pn-particles';
    this.ctx = this.canvas.getContext('2d')!;
    map.getPanes().overlayPane.appendChild(this.canvas);
    map.on('movestart zoomstart', this.pause, this);
    map.on('moveend zoomend resize', this.resume, this);
    this.reset();
  }

  setField(field: WindField) {
    this.field = field;
    this.reset();
  }

  setTime(t: number) {
    this.tIdx = t;
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.canvas.style.visibility = v ? 'visible' : 'hidden';
    if (v) this.reset();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private pause() {
    this.paused = true;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resume() {
    this.reset();
    this.paused = false;
  }

  private reset() {
    const size = this.map.getSize();
    this.canvas.width = size.x;
    this.canvas.height = size.y;
    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]));
    this.ctx.clearRect(0, 0, size.x, size.y);
    const count = Math.round(Math.min(2500, Math.max(300, (size.x * size.y) / 1500)));
    this.particles = Array.from({ length: count }, () => this.spawn({ lat: 0, lng: 0, age: 0 }, true));
  }

  private spawn(p: P, randomAge = false): P {
    const b = this.map.getBounds();
    const [x0, y0, x1, y1] = this.field.grid.bbox;
    const s = Math.max(b.getSouth(), y0);
    const n = Math.min(b.getNorth(), y1);
    const w = Math.max(b.getWest(), x0);
    const e = Math.min(b.getEast(), x1);
    if (n > s && e > w) {
      p.lat = s + Math.random() * (n - s);
      p.lng = w + Math.random() * (e - w);
    } else {
      p.lat = y0 + Math.random() * (y1 - y0);
      p.lng = x0 + Math.random() * (x1 - x0);
    }
    p.age = randomAge ? Math.floor(Math.random() * this.maxAge) : 0;
    return p;
  }

  private frame() {
    if (this.paused || !this.visible) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.90)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    // 每帧代表的小时数：放大时慢一点，缩小时快一点
    const zoom = this.map.getZoom();
    const dtH = 0.12 * Math.pow(2, (5 - zoom) * 0.6);
    const segs: number[][] = COLORS.map(() => []);
    const smp: WindSample = { u: 0, v: 0, p: 0, speed: 0 };
    for (const p of this.particles) {
      if (p.age++ > this.maxAge) {
        this.spawn(p);
        continue;
      }
      const s = this.field.sample(p.lat, p.lng, this.tIdx, smp);
      if (!s) {
        this.spawn(p);
        continue;
      }
      const nlat = p.lat + (s.v * dtH * 3600) / M_PER_DEG_LAT;
      const nlng = p.lng + (s.u * dtH * 3600) / mPerDegLng(p.lat);
      const a = this.map.latLngToContainerPoint([p.lat, p.lng]);
      if (a.x < -20 || a.y < -20 || a.x > W + 20 || a.y > H + 20) {
        this.spawn(p);
        continue;
      }
      const b = this.map.latLngToContainerPoint([nlat, nlng]);
      segs[bucket(s.speed)].push(a.x, a.y, b.x, b.y);
      p.lat = nlat;
      p.lng = nlng;
    }
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    segs.forEach((arr, bi) => {
      if (!arr.length) return;
      ctx.strokeStyle = COLORS[bi];
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 4) {
        ctx.moveTo(arr[i], arr[i + 1]);
        ctx.lineTo(arr[i + 2], arr[i + 3]);
      }
      ctx.stroke();
    });
  }
}
