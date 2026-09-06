import * as L from 'leaflet';
import './style.css';
import { HttpError, api, retry } from './api.ts';
import { createMap, displayLatLng } from './map.ts';
import { BoundaryLayer } from './boundaries.ts';
import { WindField } from './windfield.ts';
import { ParticleLayer } from './particles.ts';
import { HeatLayer } from './heatmap.ts';
import { StationLayer } from './stations.ts';
import { defaultParams, runModel, type ModelResult, type StationObs } from './dispersion.ts';
import { defaultSeasonLevels, levelIndexFor } from '../../shared/levels.ts';
import { concAt } from './dispersion.ts';
import { fmtCN, distanceKm, windFromName } from './geo.ts';
import type { CityLatest, EmissionPrior, LandcoverGrid, LatestResponse, OfficialAlert, SeasonLevel } from '../../shared/types.ts';
import * as ui from './ui.ts';

async function main() {
  ui.initTabs();
  ui.renderAbout();
  const map = createMap(document.getElementById('map')!);

  const [cities, levels0, alerts, priors, landcover] = await Promise.all([
    api.cities(),
    api.seasonLevels().catch(() => defaultSeasonLevels),
    api.alerts().catch(() => [] as OfficialAlert[]),
    api.priors().catch(() => [] as EmissionPrior[]),
    api.landcover().catch((e) => {
      console.warn('landcover unavailable, falling back to hand-drawn priors', e);
      return null as LandcoverGrid | null;
    }),
  ]);
  let levels: SeasonLevel[] = levels0;

  ui.initSheet(map);
  const heat = new HeatLayer(map, levels);
  const boundaries = new BoundaryLayer(map, levels, (code) => stations.focus(code));
  const stations = new StationLayer(map, cities, levels);
  let boundariesReady = false;
  api
    .boundaries()
    .then((fc) => {
      boundaries.setData(fc, cities);
      heat.setMask(fc);
      stations.bringToFront();
      boundariesReady = true;
      refreshLocate();
    })
    .catch((e) => console.warn('boundaries unavailable', e));

  // ---- 搜索：监测城市 + 所有地级市 ----
  ui.renderSearch(
    () => [
      ...cities.map((c) => ({ kind: 'station' as const, name: c.name, sub: ui.REGION_LABELS[c.region], key: c.code, levelCode: latestMap.get(c.code)?.latest?.levelCode ?? null })),
      ...(boundariesReady ? boundaries.otherCities().map((o) => ({ kind: 'other' as const, name: o.name, sub: o.province, key: String(o.adcode) })) : []),
    ],
    () => levels,
    (it) => {
      if (it.kind === 'station') stations.focus(it.key);
      else boundaries.focusFeature(Number(it.key));
    },
  );
  const priorGroup = L.layerGroup(
    priors.map((p) =>
      L.polygon(
        p.polygon.map(([lng, lat]) => displayLatLng(lat, lng)),
        { color: p.season === 'autumn' ? '#a0522d' : '#2e8b57', weight: 1, dashArray: '4 4', fillOpacity: 0.04 },
      ).bindTooltip(`${p.season === 'autumn' ? '秋' : '春'} · ${p.name}（${p.taxa}，权重 ${p.weight}）`, { sticky: true }),
    ),
  );

  let particles: ParticleLayer | null = null;
  const layerState: ui.LayerState = { boundaries: true, stations: true, particles: true, heat: true, hourly: false, priors: false };
  ui.renderLayerToggles(layerState, (k, v) => {
    layerState[k] = v;
    if (k === 'boundaries') boundaries.setVisible(v);
    if (k === 'stations') stations.setVisible(v);
    if (k === 'heat') heat.setVisible(v);
    if (k === 'hourly') heat.setMode(v ? 'hourly' : 'daily');
    if (k === 'particles') particles?.setVisible(v);
    if (k === 'priors') (v ? priorGroup.addTo(map) : priorGroup.remove());
  });

  let region: ui.RegionKey = 'core';
  const latestMap = new Map<string, CityLatest>();
  let latestResp: LatestResponse | null = null;
  const refreshList = () => {
    const pred = ui.regionPred(region);
    stations.setHighlight(pred);
    ui.renderCityList(cities, latestMap, levels, pred, (code) => stations.focus(code));
  };
  ui.renderRegionFilter(region, (k) => {
    region = k;
    refreshList();
  });

  // ---- 我的位置 ----
  let pos: { lat: number; lng: number } | null = null;
  let locState: ui.LocateState = { kind: 'idle' };
  let userMarker: L.Marker | null = null;
  const showMe = () => {
    if (!pos) return;
    map.flyTo(displayLatLng(pos.lat, pos.lng), Math.max(map.getZoom(), 7), { duration: 0.6 });
  };
  const drawLocate = () => ui.renderLocate(locState, levels, locate, showMe, (code) => stations.focus(code));
  const refreshLocate = () => {
    if (!pos) return drawLocate();
    const { lat, lng } = pos;
    let best = cities[0];
    let bestKm = Infinity;
    for (const c of cities) {
      const d = distanceKm(lat, lng, c.lat, c.lng);
      if (d < bestKm) {
        bestKm = d;
        best = c;
      }
    }
    const area = boundariesReady ? boundaries.findAt(lat, lng) : null;
    let modelLevel: number | null = null;
    let wind: { name: string; speed: number } | null = null;
    if (model && field) {
      const t = time?.get() ?? Math.round(field.timeIndex(Date.now() / 1000));
      const c = concAt(model, t, lng, lat);
      if (c != null) modelLevel = levelIndexFor(c, levels);
      const w = field.sample(lat, lng, t, { u: 0, v: 0, p: 0, speed: 0 });
      if (w) wind = { name: windFromName(w.u, w.v), speed: w.speed };
    }
    locState = {
      kind: 'ok',
      lat,
      lng,
      area: area ? `${area.name}${area.city ? '' : '（无监测站）'}` : null,
      nearest: { city: best, km: bestKm, latest: latestMap.get(best.code) },
      modelLevel,
      wind,
      updatedAt: new Date().toTimeString().slice(0, 5),
    };
    drawLocate();
    if (!userMarker) {
      userMarker = L.marker(displayLatLng(lat, lng), { icon: L.divIcon({ className: 'user-marker', iconSize: [14, 14] }), keyboard: false, zIndexOffset: 1000 })
        .bindTooltip('我的位置', { direction: 'top', offset: [0, -8] })
        .addTo(map);
    } else userMarker.setLatLng(displayLatLng(lat, lng));
  };
  function locate() {
    if (!('geolocation' in navigator)) {
      locState = { kind: 'error', message: '这个浏览器不支持定位，请直接搜索城市' };
      return drawLocate();
    }
    locState = { kind: 'locating' };
    drawLocate();
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const first = !pos;
        pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        refreshLocate();
        if (first) showMe();
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? '你拒绝了定位，可以直接搜索城市'
            : location.protocol !== 'https:' && location.hostname !== 'localhost'
              ? '浏览器只允许 https 页面定位，请搜索城市'
              : '定位失败，可以直接搜索城市';
        locState = { kind: 'error', message: msg };
        drawLocate();
      },
      { timeout: 10000, maximumAge: 600000 },
    );
  }
  drawLocate();
  ui.renderLegend(levels, null);

  // ---- 站点实测 ----
  const loadLatest = async () => {
    const r = await api.latest(7);
    latestResp = r;
    for (const c of r.cities) latestMap.set(c.city, c);
    try {
      levels = await api.seasonLevels();
      stations.setLevels(levels);
      heat.setLevels(levels);
      boundaries.setLevels(levels);
    } catch {
      /* 保持默认分级 */
    }
    stations.update(r);
    boundaries.update(r);
    refreshList();
    refreshLocate();
    ui.renderLegend(levels, r.season);
    return r;
  };
  await retry(loadLatest, (n) => ui.setStatus(`读取实测数据…（第 ${n} 次）`), 8000);
  locate(); // 进入页面即定位（浏览器会询问）

  // ---- 风场（服务刚启动时可能还在抓，最长几分钟）----
  let field: WindField | null = null;
  let model: ModelResult | null = null;
  let time: ui.TimeControl | null = null;
  const wind = await retry(
    api.wind,
    (n, e) =>
      ui.setStatus(
        api.isStatic
          ? `风场数据暂缺（静态站点等待下次定时更新）… 第 ${n} 次重试`
          : e instanceof HttpError && e.status === 503
            ? `风场获取中（Open-Meteo 限速，首次约 4 分钟）… 第 ${n} 次等待`
            : `风场加载失败，重试中：${(e as Error).message}`,
      ),
    10000,
  );
  field = new WindField(wind);
  particles = new ParticleLayer(map, field);
  particles.setVisible(layerState.particles);
  particles.start();

  const nowIdx = Math.round(field.timeIndex(Date.now() / 1000));
  time = ui.initTime(wind.times, nowIdx, (idx) => {
    particles?.setTime(idx);
    heat.setTime(idx);
    boundaries.setTime(idx);
    refreshLocate();
    ui.renderCompare(alerts, cities, latestMap, model, idx, levels);
  });
  particles.setTime(nowIdx);
  heat.setTime(nowIdx);
  boundaries.setTime(nowIdx);

  const stationObs = (): StationObs[] => {
    const out: StationObs[] = [];
    for (const c of cities) {
      const l = latestMap.get(c.code)?.latest;
      if (l && l.levelCode != null) out.push({ code: c.code, name: c.name, lat: c.lat, lng: c.lng, levelCode: l.levelCode, date: l.date });
    }
    return out;
  };

  const updateStatus = () => {
    const today = latestResp?.today ?? '';
    const n = latestResp?.cities.filter((c) => c.latest?.date === today).length ?? 0;
    const w = field!.grid;
    const [, mm, dd] = today.split('-');
    const windAt = fmtCN(Date.parse(w.fetchedAt) / 1000); // 北京时间
    ui.setStatus(
      `实测 ${Number(mm)}月${Number(dd)}日，${n}/${cities.length} 城已更新 · 风场 ${windAt} 更新 · ${
        model ? `推算按 ${model.stationFit.length} 站校准，植被底图 Copernicus 2019` : '推算未运行'
      }`,
    );
  };

  const rebuildModel = () => {
    if (!field) return;
    const t0 = performance.now();
    // 模型步长随范围自适应：全国范围约 0.4°，北方范围 0.25°，把格子数控制在 1.5 万左右
    const bb = field.grid.bbox;
    const area = (bb[2] - bb[0]) * (bb[3] - bb[1]);
    const stepDeg = Math.max(0.25, Math.round(Math.sqrt(area / 14000) * 20) / 20);
    model = runModel(field, priors, stationObs(), { ...defaultParams, stepDeg }, levels, landcover);
    heat.setModel(model);
    boundaries.setModel(model);
    stations.setFit(model.stationFit);
    ui.renderCompare(alerts, cities, latestMap, model, time?.get() ?? nowIdx, levels);
    refreshLocate();
    console.info(`[model] ${(performance.now() - t0).toFixed(0)} ms, global factor ${model.globalFactor.toPrecision(3)}, stations ${model.stationFit.length}`);
    updateStatus();
  };
  rebuildModel();
  // 调试句柄（浏览器控制台里可用 __pn.map / __pn.boundaries）
  (window as unknown as { __pn: unknown }).__pn = { map, boundaries, stations, heat, get model() { return model; } };

  // 实测还没抓到时，每 15 秒再试
  if (!latestResp!.cities.some((c) => c.latest)) {
    ui.setStatus('实测数据尚未就绪，正在等待首次抓取…');
    const poll = async () => {
      try {
        const r = await loadLatest();
        if (r.cities.some((c) => c.latest)) {
          rebuildModel();
          return;
        }
      } catch {
        /* 继续等 */
      }
      setTimeout(poll, 15000);
    };
    setTimeout(poll, 15000);
  }

  // ---- 周期刷新 ----
  setInterval(async () => {
    try {
      await loadLatest();
      rebuildModel();
    } catch (e) {
      console.warn('latest refresh failed', e);
    }
  }, 10 * 60 * 1000);
  setInterval(async () => {
    try {
      const w = await api.wind();
      if (w.fetchedAt !== field?.grid.fetchedAt) {
        field = new WindField(w);
        particles?.setField(field);
        time?.set(Math.round(field.timeIndex(Date.now() / 1000)));
        rebuildModel();
      }
    } catch (e) {
      console.warn('wind refresh failed', e);
    }
  }, 30 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  ui.setStatus(`初始化失败：${(e as Error).message}`);
});
