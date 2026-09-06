import type { City, Region } from '../shared/types.ts';

const C = (code: string, name: string, lat: number, lng: number, region: Region, core = false): City => ({
  code,
  name,
  lat,
  lng,
  region,
  core,
});

/**
 * 城市代码来自中国天气网花粉页面的城市下拉框（option 的 en 属性），
 * 即 graph.weatherdt.com 花粉接口的 city 参数。坐标为 WGS84 市中心近似值。
 */
export const cities: City[] = [
  // 核心：西北 + 内蒙（鼻炎重灾区）
  C('yinchuan', '银川', 38.4872, 106.2309, 'northwest', true),
  C('lanzhou', '兰州', 36.0611, 103.8343, 'northwest', true),
  C('huhehaote', '呼和浩特', 40.8424, 111.749, 'neimeng', true),
  C('baotou', '包头', 40.6574, 109.8403, 'neimeng', true),
  C('eerduosi', '鄂尔多斯', 39.6086, 109.7813, 'neimeng', true),
  C('wuhai', '乌海', 39.6547, 106.7943, 'neimeng', true),
  C('chifeng', '赤峰', 42.2586, 118.8878, 'neimeng', true),
  C('wulanhaote', '乌兰浩特', 46.0726, 122.0932, 'neimeng', true),
  // 西北其他
  C('xining', '西宁', 36.6171, 101.7782, 'northwest'),
  C('wulumuqi', '乌鲁木齐', 43.8256, 87.6168, 'northwest'),
  C('jiuquan', '酒泉', 39.7325, 98.4942, 'northwest'),
  C('yulin', '榆林', 38.2852, 109.7349, 'northwest'),
  C('yanan', '延安', 36.5853, 109.4897, 'northwest'),
  C('xian', '西安', 34.3416, 108.9398, 'northwest'),
  C('xianyang', '咸阳', 34.3296, 108.7093, 'northwest'),
  // 华北
  C('beijing', '北京', 39.9042, 116.4074, 'north'),
  C('tianjin', '天津', 39.0842, 117.2009, 'north'),
  C('shijiazhuang', '石家庄', 38.0428, 114.5149, 'north'),
  C('baoding', '保定', 38.874, 115.4646, 'north'),
  C('cangzhou', '沧州', 38.3037, 116.8388, 'north'),
  C('botou', '泊头', 38.0835, 116.5784, 'north'),
  C('zhangjiakou', '张家口', 40.767, 114.886, 'north'),
  C('chengde', '承德', 40.9515, 117.9634, 'north'),
  C('taiyuan', '太原', 37.8706, 112.5489, 'north'),
  C('zhengzhou', '郑州', 34.7466, 113.6254, 'north'),
  C('jinan', '济南', 36.6512, 117.1201, 'north'),
  C('zibo', '淄博', 36.8131, 118.0549, 'north'),
  C('liaocheng', '聊城', 36.457, 115.9855, 'north'),
  C('yantai', '烟台', 37.4638, 121.4479, 'north'),
  // 东北
  C('shenyang', '沈阳', 41.8057, 123.4315, 'northeast'),
  C('dalian', '大连', 38.914, 121.6147, 'northeast'),
  C('changchun', '长春', 43.8171, 125.3235, 'northeast'),
  C('haerbin', '哈尔滨', 45.8038, 126.535, 'northeast'),
  // 华东 / 华中 / 华南 / 西南
  C('shanghai', '上海', 31.2304, 121.4737, 'east'),
  C('hangzhou', '杭州', 30.2741, 120.1551, 'east'),
  C('wuxi', '无锡', 31.4912, 120.3119, 'east'),
  C('yangzhou', '扬州', 32.3947, 119.4128, 'east'),
  C('hefei', '合肥', 31.8206, 117.2272, 'east'),
  C('wuhan', '武汉', 30.5928, 114.3055, 'central'),
  C('changsha', '长沙', 28.2282, 112.9388, 'central'),
  C('nanchang', '南昌', 28.682, 115.8579, 'central'),
  C('fuzhou', '福州', 26.0745, 119.2965, 'east'),
  C('guangzhou', '广州', 23.1291, 113.2644, 'south'),
  C('shenzhen', '深圳', 22.5431, 114.0579, 'south'),
  C('nanning', '南宁', 22.817, 108.3665, 'south'),
  C('haikou', '海口', 20.0444, 110.1999, 'south'),
  C('chongqing', '重庆', 29.563, 106.5516, 'southwest'),
  C('chengdu', '成都', 30.5728, 104.0668, 'southwest'),
  C('nanchong', '南充', 30.8373, 106.1107, 'southwest'),
  C('kunming', '昆明', 25.0389, 102.7183, 'southwest'),
  C('guiyang', '贵阳', 26.647, 106.6302, 'southwest'),
  C('liupanshui', '六盘水', 26.5946, 104.8302, 'southwest'),
  C('lasa', '拉萨', 29.652, 91.1721, 'southwest'),
];

export const cityByCode = new Map(cities.map((c) => [c.code, c]));
