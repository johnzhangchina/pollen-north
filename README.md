# 北方花粉风图（pollen-north）

全国 53 个花粉监测城市的等级地图，叠加风场粒子动画和一个简化的花粉扩散趋势推算。给鼻炎患者做的个人项目，重点城市是银川、兰州和内蒙古的呼和浩特、包头、鄂尔多斯、乌海、赤峰、乌兰浩特。默认范围是全国（73–135°E，18–54°N，风场 1°），`.env` 里改 `WIND_BBOX`/`WIND_STEP_DEG` 可以只做北方（如 `96,33,128,50` 和 `0.5`）。

> 页面内容仅供个人防护参考，不构成医疗建议，也不是气象部门的官方预报。

## 它做了什么

| 层 | 内容 | 来源 |
|---|---|---|
| 站点实测 | 53 个城市的每日花粉等级（5 档）、上游"明日"预报、最近 7 天走势 | 中国天气网 × 北京同仁医院 花粉过敏指数（经 WeatherDT 接口） |
| 风粒子 | 10 米风场的 Windy 式粒子流，可拖时间轴看昨日到未来 3 天 | Open-Meteo（默认 best_match 模式，可切 CMA GRAPES / GFS / ECMWF） |
| 花粉推算 | 土地覆盖排放底图 × 手工先验权重 × 物候 × 日变化，随风逐小时平流，扣沉降和降水清除，用站点实测标定后按等级着色（默认显示 24 h 均值） | 本项目计算；植被来自 Copernicus LC100 2019（CC BY 4.0），先验区手工圈定 |
| 对照 | 卫健委 + 气象局每周《花粉浓度预报服务提示》的分区等级 vs 站点实测均值 vs 模型推算 | `data/official_alerts.json` 手工录入 |
| 我的位置 | 进入页面自动请求浏览器定位（http 非 localhost 下浏览器会拒绝，需 https）：所在地级市、周边 24 h 推算等级、最近监测站的实测与明日等级、此刻风向 | 浏览器 Geolocation，坐标只在本地使用 |
| 城市搜索 | 53 个监测城市（中文或拼音）和全国所有地级市；无站城市跳到边界并弹出推算 | — |
| 城市边界 | 全国地级市（直辖市、港澳台取整体）的行政边界：有站点的城市按实测等级填色并标中文名，其余城市细虚线、悬停显示推算等级 | 阿里云 DataV GeoAtlas（高德数据，GCJ-02） |

## 快速开始

需要 Node ≥ 22.13（用到内置 `node:sqlite` 和原生运行 TypeScript）。

```bash
npm install
npm run scrape     # 首次抓取 53 城实测（约 25 秒）
npm run wind       # 首次抓取风场（Open-Meteo 每分钟限 600 点、每天 1 万点；全国 1° 约 2300 点 4 分钟）
npm run boundaries # 下载地级市边界（约 10 秒；服务启动时缺失也会自动补）
npm run landcover  # 从 Zenodo 按范围读取 Copernicus 100 m 土地覆盖并聚合到 0.1°（北方约 7 分钟，全国约 30 分钟，一次即可；缺失时推算退回手工多边形）
npm run build      # 打包前端到 client/dist
npm start          # http://localhost:8787
```

开发模式（前端热更新 + 后端自动重启）：

```bash
npm run dev        # 前端 http://localhost:5173 ，/api 代理到 8787
```

服务启动后会自动调度：实测每 24 小时抓一次（有值不会被"暂无"覆盖，能补到医院下午的迟报），风场每 24 小时刷新一次。所有配置见 `.env.example`。

## 目录

```
server/   Hono 后端：抓取、SQLite 存储、Open-Meteo 风场缓存、调度、API
client/   Vite + Leaflet 前端：站点、风粒子、推算热力、对照面板
shared/   前后端共用的类型和分级工具
data/     official_alerts.json（官方周报）、emission_prior.json（排放先验区）
          运行时生成：pollen.sqlite、raw/（每日原始 JSON）、wind/（风场快照）
```

API：`/api/cities`、`/api/pollen/latest?days=7`、`/api/pollen/history?city=baotou&days=90`、`/api/wind`、`/api/alerts`、`/api/priors`、`/api/season-levels`、`/api/status`。设置 `ADMIN_TOKEN` 后可 `POST /api/admin/scrape?token=…` 手动触发。

## 零成本部署（Cloudflare Pages + GitHub Actions）

服务端只做定时抓取和吐 JSON，推算模型在浏览器里跑，所以整站可以按"静态文件 + 定时任务"部署，不需要常驻服务器：

1. 把仓库推到 GitHub（`data/pollen.sqlite`、`data/boundaries/`、`data/landcover/fractions.json` 都要入库，历史和底图数据靠它们）。
2. Cloudflare 控制台新建 Pages 项目（Direct Upload 方式，名字默认 `pollen-north`），创建一个权限为 *Cloudflare Pages: Edit* 的 API Token。
3. 在 GitHub 仓库 Settings → Secrets and variables 里填：
   - Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，可选 `TIANDITU_KEY`
   - Variables：可选 `CF_PAGES_PROJECT`（Pages 项目名）、`TILE_PRESET`（`amap` / `tianditu`）
4. Actions 页面手动跑一次 `publish`，之后每天北京时间 10:30 自动执行：抓花粉等级 → 刷风场 → `npm run build`（`VITE_STATIC_API=1`）→ `npm run export` 生成 `client/dist/api/*.json` → 发布到 Pages → 把 `pollen.sqlite` 提交回仓库保存历史。

没有配置 Cloudflare 的 Secrets 时，workflow 会退而发布到 GitHub Pages（`https://<用户名>.github.io/<仓库名>/`，仓库需公开，Settings → Pages 的 Source 选 GitHub Actions）。国内访问 github.io 不稳定，所以建议尽早补上 Cloudflare。

细节见 [.github/workflows/publish.yml](.github/workflows/publish.yml)。风场抓取失败时用上一次缓存的结果继续发布；花粉迟报会在次日抓 7 天历史时补齐。本地想验证静态产物：`npm run build:static && npx vite preview`。

海外免费托管在国内偶有慢或抽风，Cloudflare 是其中最稳的；等有预算再绑自己的域名，那也是接广告的前提。

## 底图与坐标系

默认底图是高德栅格瓦片（`VITE_TILE_PRESET=amap`）：中文、国内加载快、免 key，但它和 DataV 边界都是 GCJ-02 坐标。站点、先验区这些 WGS84 数据叠加时会做同向偏移；风场和 25 km 的推算色块不转换，误差不到 1 公里，肉眼看不出。高德瓦片服务条款并未开放第三方直连，个人研究可用，**要上线请切天地图**：到 tianditu.gov.cn 免费申请个人 key，然后在 `.env` 里设 `VITE_TILE_PRESET=tianditu` 和 `VITE_TIANDITU_KEY=…`，天地图是 CGCS2000（≈WGS84），无需偏移。其他可选：`osm`（中国境内中文，国内访问慢）、`esri`（浅灰英文）。

## 推算模型说明

`client/src/dispersion.ts`，全部在浏览器里跑（0.25° 网格 × 96 小时两遍约 0.3 秒）：

1. **排放底图**：`data/landcover/fractions.json`（`npm run landcover` 生成）里每个 0.1° 格子的草地、灌丛、农田、稀疏植被、林地、建成区占比。秋季排放当量 = 草地 + 0.6 灌丛 + 0.45 稀疏植被 + 0.5 农田；春季 = 林地 + 0.7 建成区 + 0.3 灌丛。
2. **先验权重**：`data/emission_prior.json` 里手工圈的多边形只做放大：排放 = 植被当量 × (0.3 + 圈内权重)。秋季圈的是蒿属/藜科集中区（内蒙中西部、宁夏、甘肃中部、陕北、坝上、内蒙东部草原…），春季是柏科/杨柳/榆（北京太行山东麓、关中、山东…）。没有植被文件时退回只用多边形。
3. **物候**：以北纬 40° 为基准，秋季以 8 月 28 日为中心、σ=14 天，春季以 4 月 6 日为中心、σ=16 天；越往南春季越早（每度约 2.2 天）、秋季略晚且更长。纯经验，南方城市尤其需要用实测校正。
4. **日变化**：上午 10 点前后释放最多。
5. **输送**：半拉格朗日后向追踪，10 米风乘 1.4 当作输送层风；每小时干沉降 8%，每毫米降水再清除 35%；加一点数值扩散。
6. **校准**：医院 08:00 的读数当作前 24 小时均值，先跑一遍求全局系数（中位数比值），再对每站的残差做反距离加权得到局地修正场，第二遍用修正后的排放重算。
7. **浓度场局地修正**：排放校准只能调源强，被大源包围的站点（比如银川被内蒙古中西部围着）浓度仍会被邻区顶高，所以再按站点实测对浓度本身做一次反距离加权乘性修正（半径约 1°，幅度不超过 ×3），保证站点处的 24 h 均值落回实测等级。
8. **显示尺度**：实测是日值，地图默认画"截至所选时刻的 24 h 均值"，与实测同尺度着色；勾选"显示逐小时瞬时值"才看午后峰/夜间谷。否则午后瞬时峰会把"高"的城市周边画成"很高"。热力按像素双线性采样后着色，不再是 0.25° 方格。

它表达的是"花粉大概从哪来、往哪去"，不是浓度预报。"对照"页里有每站实测 vs 推算的偏差表，先验圈得对不对一眼能看出来。土地覆盖只说明哪里有草有树，分不出蒿属，所以站点校准和手工圈定的蒿属集中区仍然保留；下一步是叠加中国 1:100 万植被图里以蒿属/藜科为优势种的群系。

## 数据与合规

- 中国天气网页面有版权声明；WeatherDT 花粉接口无鉴权、无公开文档，随时可能变化。本项目只做抓取、缓存和可视化，不拥有原始数据版权。**做成对外产品前必须取得授权**（WeatherDT 有商业 API）。
- Open-Meteo 免费接口仅限非商用（CC BY 4.0，每天 1 万点、每分钟 600 点）；商用要订阅。
- 国内实行气象预报统一发布制度。界面统一用"推算""参考"措辞，不用"预报""预警"，并标注来源和时间。
- 分级单位是国内的 粒/千平方毫米（重力法），与国际的 粒/立方米（体积法）不能直接换算。国家级周报对草本花粉用的阈值（≤50 / 100 / 150 / 300）也与中国天气网的夏秋分级（20 / 60 / 170 / 390）不同，对照页已注明。

## 已知限制与路线

- 站点是一城一点的日值，推算层远离站点处只有示意意义。
- 上游只有等级没有粒数，校准用的是区间代表值。
- 风场只用 10 米风；应改用边界层平均风或 100 米风。
- 先验多边形是手工画的矩形。
- 城市边界来自 DataV，注明仅供学习研究；泊头是县级市，没有对应的地级面，只显示圆点。
- 路线：土地覆盖驱动的排放图 → 北京 15 站小时级验证 → 症状打卡众包 → PWA 推送 → 春季柏科季上线完整版。
