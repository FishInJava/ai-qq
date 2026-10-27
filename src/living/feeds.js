const KIND_TIMEOUT_MS = 8000;
const USER_AGENT = 'proactive-companion/0.1 (local; +https://localhost)';
const MAX_NEWS_CHARS = 120;

const TIMEZONE_CITIES = Object.freeze({
  'Asia/Shanghai': '上海',
  'Asia/Chongqing': '重庆',
  'Asia/Harbin': '哈尔滨',
  'Asia/Urumqi': '乌鲁木齐',
  'Asia/Taipei': '台北',
  'Asia/Hong_Kong': '香港',
  'Asia/Macau': '澳门',
  'Asia/Tokyo': '东京',
  'Asia/Seoul': '首尔',
  'Asia/Singapore': '新加坡',
  'Europe/London': '伦敦',
  'Europe/Paris': '巴黎',
  'Europe/Berlin': '柏林',
  'America/New_York': '纽约',
  'America/Los_Angeles': '洛杉矶',
  'America/Chicago': '芝加哥',
  'Australia/Sydney': '悉尼',
});

const CITY_COORDS = Object.freeze({
  上海: [31.2304, 121.4737],
  北京: [39.9042, 116.4074],
  广州: [23.1291, 113.2644],
  深圳: [22.5431, 114.0579],
  杭州: [30.2741, 120.1551],
  南京: [32.0603, 118.7969],
  成都: [30.5728, 104.0668],
  重庆: [29.5630, 106.5516],
  武汉: [30.5928, 114.3055],
  西安: [34.3416, 108.9398],
  苏州: [31.2989, 120.5853],
  天津: [39.3434, 117.3616],
  长沙: [28.2282, 112.9388],
  郑州: [34.7466, 113.6253],
  青岛: [36.0671, 120.3826],
  厦门: [24.4798, 118.0894],
  福州: [26.0745, 119.2965],
  合肥: [31.8206, 117.2272],
  昆明: [24.8801, 102.8329],
  哈尔滨: [45.8038, 126.5349],
  沈阳: [41.8057, 123.4315],
  大连: [38.9140, 121.6147],
  济南: [36.6512, 117.1201],
  乌鲁木齐: [43.8256, 87.6168],
  兰州: [36.0611, 103.8343],
  贵阳: [26.6470, 106.6302],
  南宁: [22.8170, 108.3665],
  海口: [20.0442, 110.1999],
  台北: [25.0330, 121.5654],
  香港: [22.3193, 114.1694],
  澳门: [22.1987, 113.5439],
  东京: [35.6762, 139.6503],
  首尔: [37.5665, 126.9780],
  新加坡: [1.3521, 103.8198],
  伦敦: [51.5074, -0.1278],
  巴黎: [48.8566, 2.3522],
  柏林: [52.5200, 13.4050],
  纽约: [40.7128, -74.0060],
  洛杉矶: [34.0522, -118.2437],
  芝加哥: [41.8781, -87.6298],
  悉尼: [-33.8688, 151.2093],
});

const SOLAR_HOLIDAYS = Object.freeze({
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '04-01': '愚人节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '12-24': '平安夜',
  '12-25': '圣诞节',
  '12-31': '跨年夜',
});

const WEATHER_TEXT = Object.freeze({
  0: '晴',
  1: '大致晴',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '有雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '强阵雨',
  82: '暴阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷阵雨伴冰雹',
});

const NEWS_FEEDS = Object.freeze([
  'https://rss.sina.com.cn/news/china/focus15.xml',
  'https://news.163.com/special/00011K6L/rss_newstop.xml',
]);

function cityFromConfig(config) {
  const configured = typeof config?.living?.city === 'string' ? config.living.city.trim() : '';
  if (configured !== '') {
    return configured;
  }
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return null;
  }
  return TIMEZONE_CITIES[zone] ?? null;
}

function decodeEntities(text) {
  return String(text)
    .replaceAll('<![CDATA[', '')
    .replaceAll(']]>', '')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentence(text) {
  const clean = decodeEntities(text);
  const match = /^(.{1,80}?[。！？!?])/.exec(clean);
  return (match ? match[1] : clean).slice(0, 60);
}

function tagText(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? decodeEntities(match[1]) : '';
}

export function createFeeds({ store, clock, config, log, fetchImpl = globalThis.fetch }) {
  async function fetchText(url, timeoutMs = KIND_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = clock.setTimer(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml,application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } finally {
      clock.clearTimer(timer);
    }
  }

  async function coordsOf(city) {
    if (CITY_COORDS[city]) {
      return CITY_COORDS[city];
    }
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
    const text = await fetchText(url);
    const parsed = JSON.parse(text);
    const first = Array.isArray(parsed?.results) ? parsed.results[0] : null;
    if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') {
      return null;
    }
    return [first.latitude, first.longitude];
  }

  async function collectWeather() {
    const city = cityFromConfig(config);
    if (city === null) {
      return null;
    }
    const coords = await coordsOf(city);
    if (coords === null) {
      return null;
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&current=temperature_2m,weather_code&timezone=auto`;
    const parsed = JSON.parse(await fetchText(url));
    const current = parsed?.current;
    const temperature = Number(current?.temperature_2m);
    const code = Number(current?.weather_code);
    if (!Number.isFinite(temperature) || !Number.isFinite(code)) {
      return null;
    }
    const text = WEATHER_TEXT[code] ?? '天气说不准';
    return {
      kind: 'weather',
      content: `${city}今天 ${Math.round(temperature)}°C，${text}。`,
    };
  }

  function collectHoliday(day) {
    const name = SOLAR_HOLIDAYS[day.slice(5)];
    if (!name) {
      return null;
    }
    return { kind: 'holiday', content: `今天是${name}。` };
  }

  async function collectNews() {
    for (const url of NEWS_FEEDS) {
      try {
        const xml = await fetchText(url);
        const item = /<item\b[\s\S]*?<\/item>/i.exec(xml)?.[0];
        if (!item) {
          continue;
        }
        const title = tagText(item, 'title');
        if (title === '') {
          continue;
        }
        const summary = firstSentence(tagText(item, 'description'));
        const content = summary === '' || summary === title
          ? `头条：${title}。`
          : `头条：${title}。${summary}`;
        return { kind: 'news', content: content.slice(0, MAX_NEWS_CHARS) };
      } catch {
        continue;
      }
    }
    return null;
  }

  async function ensureDay(day) {
    const existing = store.worldFeeds.listForDay(day);
    const have = new Set(existing.map((row) => row.kind));
    const tasks = [];
    if (!have.has('weather')) {
      tasks.push(collectWeather());
    }
    if (!have.has('holiday')) {
      tasks.push(Promise.resolve(collectHoliday(day)));
    }
    if (!have.has('news')) {
      tasks.push(collectNews());
    }

    const settled = await Promise.allSettled(tasks);
    const fetchedAt = clock.iso();
    for (const result of settled) {
      if (result.status === 'rejected') {
        log?.warn('living_feed_failed', {
          message: result.reason?.message ?? String(result.reason),
        });
        continue;
      }
      const feed = result.value;
      if (feed !== null) {
        store.worldFeeds.insertIfAbsent({
          date: day,
          kind: feed.kind,
          content: feed.content,
          fetchedAt,
        });
      }
    }

    return store.worldFeeds.listForDay(day);
  }

  return { ensureDay };
}
