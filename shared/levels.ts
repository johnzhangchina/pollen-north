import type { SeasonLevel } from './types.ts';

/** 上游（中国天气网/同仁医院）夏秋季分级，单位 粒/千平方毫米。运行时会被抓到的 seasonLevel 覆盖。 */
export const defaultSeasonLevels: SeasonLevel[] = [
  { level: '未检测到花粉', levelMsg: '暂无', color: '#999999', minNum: 0, maxNum: 0, desc: '' },
  { level: '很低', levelMsg: '不易引发过敏反应。', color: '#81CB31', minNum: 1, maxNum: 20, desc: '预计10%的患者出现症状' },
  { level: '低', levelMsg: '易引发轻度过敏，适当防护对症用药。', color: '#A1FF3D', minNum: 21, maxNum: 60, desc: '预计25%的患者出现症状' },
  { level: '中', levelMsg: '易引发过敏，加强防护，对症用药。', color: '#F5EE32', minNum: 61, maxNum: 170, desc: '预计50%的患者出现症状' },
  { level: '高', levelMsg: '易引发过敏，加强防护，规范用药。', color: '#FFAF13', minNum: 171, maxNum: 390, desc: '预计75%的患者出现症状' },
  { level: '很高', levelMsg: '极易引发过敏，减少外出，持续规范用药。', color: '#FF2319', minNum: 391, maxNum: 9999, desc: '预计90%以上的患者出现症状' },
];

/** 浓度 → 等级序号（0 = 未检测/无，1..5） */
export function levelIndexFor(conc: number, levels: SeasonLevel[]): number {
  if (!(conc > 0)) return 0;
  for (let i = levels.length - 1; i >= 1; i--) {
    if (conc >= levels[i].minNum) return i;
  }
  return 0;
}

export function levelColor(code: number | null | undefined, levels: SeasonLevel[]): string {
  if (code == null || code < 0 || code >= levels.length) return '#b9b9b9';
  return levels[code].color;
}

export function levelName(code: number | null | undefined, levels: SeasonLevel[]): string {
  if (code == null || code < 0 || code >= levels.length) return '暂无';
  return levels[code].level;
}

/** 校准用：每个等级对应的代表浓度（区间几何中点；顶级取下限 ×1.35） */
export function midConcForLevel(code: number, levels: SeasonLevel[]): number {
  const l = levels[code];
  if (!l) return 0;
  if (code === levels.length - 1 || l.maxNum == null || l.maxNum >= 9000) return l.minNum * 1.35;
  return Math.sqrt(Math.max(1, l.minNum) * Math.max(1, l.maxNum));
}
