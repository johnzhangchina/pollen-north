import path from 'node:path';
import { scrapeAll } from './scraper.ts';
import { refreshWind } from './wind.ts';
import { refreshBoundaries } from './boundaries.ts';
import { refreshLandcover } from './landcover.ts';
import { exportStatic } from './export.ts';

const task = process.argv[2];
if (task === 'scrape') {
  const s = await scrapeAll();
  console.log(JSON.stringify(s, null, 2));
} else if (task === 'wind') {
  const w = await refreshWind();
  console.log(`fetchedAt=${w.fetchedAt} grid=${w.nx}x${w.ny} hours=${w.times.length}`);
} else if (task === 'boundaries') {
  const n = await refreshBoundaries();
  console.log(`boundaries: ${n} city polygons`);
} else if (task === 'landcover') {
  const g = await refreshLandcover();
  console.log(`landcover: ${g.nx}x${g.ny} @ ${g.step}° from ${g.source}`);
} else if (task === 'export') {
  const out = path.resolve(process.argv[3] ?? 'client/dist/api');
  const files = exportStatic(out);
  console.log(`export: ${files.length} 个文件 → ${out}\n  ${files.join('\n  ')}`);
} else {
  console.log('usage: node server/cli.ts scrape|wind|boundaries|landcover|export [outDir]');
  process.exit(1);
}
