/**
 * 通用新闻聚合引擎 v3.1
 *
 * v3.1 变更：
 *   - 支持 --topic=xxx 参数，仅更新指定主题
 *   - 移除 feed 生成功能
 *
 * 用法：
 *   node update-news.js                  # 更新全部主题
 *   node update-news.js --topic=finance  # 仅更新金融
 *   node update-news.js --topic=xiaomi   # 仅更新小米
 *   node update-news.js --topic=social-science  # 仅更新社科
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SCRIPTS_DIR = __dirname;
const CACHE_FILE = path.join(SCRIPTS_DIR, 'translations-cache.json');
const TOPICS_FILE = path.join(SCRIPTS_DIR, 'topics.json');
const MAX_DAYS = 365;           // 拆分文件保留天数
const TRANSLATE_CONCURRENCY = 3;
const MAX_RETRIES = 1;

// ==================== 命令行参数 ====================
const FILTER_TOPIC = process.argv.find(a => a.startsWith('--topic='))?.split('=')[1] || null;

// ==================== HTTP 请求 ====================
function fetchUrl(url, maxRedirects = 3, _visited = new Set()) {
  return new Promise((resolve, reject) => {
    if (_visited.has(url)) return reject(new Error(`Circular redirect: ${url}`));
    _visited.add(url);

    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregatorBot/3.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const redirectUrl = new URL(res.headers.location, url).href;
        res.resume();
        return fetchUrl(redirectUrl, maxRedirects - 1, _visited).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      let stream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchUrl(url);
    } catch (e) {
      const retryable = e.message.includes('HTTP 5') || e.message.includes('Timeout');
      if (i < retries && retryable) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
}

// ==================== 翻译缓存 ====================
let translationCache = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      translationCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      const count = Object.keys(translationCache).length;
      if (count > 0) console.log(`📦 加载翻译缓存: ${count} 条`);
    }
  } catch {
    translationCache = {};
  }
}

function saveCache() {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [key, entry] of Object.entries(translationCache)) {
      if (entry.ts && entry.ts < cutoff) delete translationCache[key];
    }
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(translationCache, null, 2), 'utf-8');
    fs.renameSync(tmp, CACHE_FILE);
    console.log(`💾 保存翻译缓存: ${Object.keys(translationCache).length} 条`);
  } catch (e) {
    console.error('⚠️ 缓存保存失败:', e.message);
  }
}

function cacheKey(text) {
  const t = text.trim();
  if (t.length <= 80) return t.toLowerCase();
  return (t.slice(0, 80) + t.slice(-20)).toLowerCase();
}

// ==================== 翻译工具 ====================
function isEnglish(text) {
  const letters = text.replace(/[\s\d.,!?@#$%^&*()\-+='";:/<>[\]{}|\\`~\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '');
  if (!letters.length) return false;
  const ascii = letters.replace(/[^\x00-\x7F]/g, '');
  return ascii.length / letters.length > 0.7;
}

async function translateMyMemory(text) {
  const encoded = encodeURIComponent(text.slice(0, 450));
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|zh-CN`;
  const json = await fetchWithRetry(url);
  const data = JSON.parse(json);
  const translated = data?.responseData?.translatedText;
  if (translated && translated.toLowerCase() !== text.toLowerCase() && !translated.includes('MYMEMORY')) {
    return translated;
  }
  return null;
}

async function translateGoogle(text) {
  const encoded = encodeURIComponent(text.slice(0, 500));
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encoded}`;
  const json = await fetchWithRetry(url);
  const data = JSON.parse(json);
  if (data && data[0]) {
    return data[0].map(s => s[0]).join('');
  }
  return null;
}

async function translateENtoZH(text) {
  const key = cacheKey(text);
  if (translationCache[key] && translationCache[key].zh) {
    return translationCache[key].zh;
  }

  let translated = null;
  try {
    translated = await translateMyMemory(text);
  } catch {}

  if (!translated) {
    try {
      await new Promise(r => setTimeout(r, 300));
      translated = await translateGoogle(text);
    } catch {}
  }

  if (translated) {
    translationCache[key] = { zh: translated, ts: Date.now() };
    return translated;
  }
  return text;
}

async function translateItems(items) {
  const results = [];
  let cached = 0;
  let newTranslated = 0;
  let failed = 0;

  const queue = [...items];
  const running = new Set();

  async function processOne(item) {
    if (isEnglish(item.title)) {
      const key = cacheKey(item.title);
      if (translationCache[key] && translationCache[key].zh) {
        cached++;
      } else {
        newTranslated++;
      }
      try {
        const zh = await translateENtoZH(item.title);
        const translatedOk = zh !== item.title;
        if (!translatedOk) failed++;
        results.push({ ...item, title: zh, titleEN: item.title });
      } catch {
        failed++;
        results.push({ ...item, titleEN: item.title });
      }
    } else {
      results.push(item);
    }
  }

  while (queue.length > 0 || running.size > 0) {
    while (queue.length > 0 && running.size < TRANSLATE_CONCURRENCY) {
      const item = queue.shift();
      const p = processOne(item).finally(() => running.delete(p));
      running.add(p);
    }
    if (running.size > 0) await Promise.race(running);
  }

  console.log(`📊 翻译统计: ${cached} 缓存, ${newTranslated} 新翻译, ${failed} 失败`);
  return results;
}

// ==================== RSS/Atom 解析 ====================
function parseRssItems(xml, filterRegex) {
  const items = [];

  const rssMatches = xml.matchAll(/<item>[\s\S]*?<\/item>/g);
  for (const m of rssMatches) {
    const block = m[0];
    const title = block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]?.trim()
      || block.match(/<title>(.*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim();
    const link = block.match(/<link>(.*?)<\/link>/)?.[1]?.trim()
      || block.match(/<link[^>]*>(.*?)<\/link>/)?.[1]?.trim();
    if (title) {
      if (!filterRegex || filterRegex.test(title)) {
        items.push({ title, link: link || '' });
      }
    }
  }

  if (items.length === 0) {
    const atomMatches = xml.matchAll(/<entry>[\s\S]*?<\/entry>/g);
    for (const m of atomMatches) {
      const block = m[0];
      const title = block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]?.trim()
        || block.match(/<title[^>]*>(.*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim();
      const link = block.match(/<link[^>]*href="([^"]+)"/)?.[1]?.trim()
        || block.match(/<link[^>]*>(.*?)<\/link>/)?.[1]?.trim();
      if (title) {
        if (!filterRegex || filterRegex.test(title)) {
          items.push({ title, link: link || '' });
        }
      }
    }
  }

  return items;
}

// ==================== 通用源抓取 ====================
async function fetchSource(source) {
  const items = [];

  try {
    if (source.type === 'rss') {
      const xml = await fetchWithRetry(source.url);
      const filter = source.filter ? new RegExp(source.filter, 'i') : null;
      const parsed = parseRssItems(xml, filter);
      parsed.forEach(item => items.push({ ...item, source: source.name }));

    } else if (source.type === 'api') {
      const json = await fetchWithRetry(source.url);
      const data = JSON.parse(json);

      if (source.parse === '36kr') {
        const list = data?.data?.items || data?.data?.word_items || [];
        for (const item of list) {
          const info = item.item || item;
          const title = (info.title || '').replace(/<[^>]+>/g, '').trim();
          const link = info.id ? `https://36kr.com/p/${info.id}` : '';
          if (title) items.push({ title, link, source: source.name });
        }
      } else if (source.parse === 'sina') {
        const list = data?.result?.data || [];
        const filter = source.filter ? new RegExp(source.filter, 'i') : null;
        for (const item of list) {
          const title = (item.title || '').trim();
          const link = item.url || '';
          if (title && (!filter || filter.test(title))) {
            items.push({ title, link, source: source.name });
          }
        }
      }
    }
  } catch (e) {
    console.error(`  ❌ ${source.name}: ${e.message}`);
  }

  return items;
}

// ==================== 分类 ====================
function preprocessCategories(categories) {
  return categories.map(cat => ({
    ...cat,
    _kwLower: cat.keywords.map(kw => kw.toLowerCase()),
  }));
}

function classify(item, processedCats, defaultCat) {
  const titleEN = (typeof item === 'string' ? '' : item.titleEN || '').toLowerCase();
  const title = (typeof item === 'string' ? item : item.title || '').toLowerCase();
  const matchTarget = titleEN || title;
  for (const cat of processedCats) {
    if (cat._kwLower.some(kw => matchTarget.includes(kw))) return cat;
  }
  return defaultCat;
}

function normalizeTitle(title) {
  return (title || '')
    .replace(/^[💹🎓📱📰🛢️📈🏦💰🖥️🌍🤖🧠👥🏛️📖⚙️🏥📚⚖️🚗🏠📊💹🎓📱📰🛢️📈🏦💰🖥️🌍🤖🧠👥🏛️📖⚙️🏥📚⚖️🚗🏠📊]+/gu, '')
    .replace(/^[\s\-–—·|：:]+/, '')
    .replace(/\s*[-–—]\s*(Reuters|Bloomberg|WSJ|CNBC|Financial Times|FT|BBC|CNN|NBER|36氪|IT之家|新浪财经|观察者|爱范儿|Sohu|东方财富|凤凰网科技|投资者商业日报|华尔街日报)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function dedup(items) {
  const seen = new Set();
  return items.filter(item => {
    if (item.link && seen.has('url:' + item.link)) return false;
    if (item.link) seen.add('url:' + item.link);

    const raw = item.titleEN || item.title || '';
    const norm = normalizeTitle(raw).slice(0, 80);
    if (!norm) return true;
    if (seen.has('t:' + norm)) return false;
    seen.add('t:' + norm);

    return true;
  });
}

function groupByCategory(items, categories, defaultCat) {
  const processedCats = preprocessCategories(categories);
  const groups = {};
  for (const item of items) {
    const cat = classify(item, processedCats, defaultCat);
    const key = cat.title;
    if (!groups[key]) groups[key] = { icon: cat.icon, title: cat.title, items: [] };
    groups[key].items.push({
      title: item.title,
      link: item.link || '',
      source: item.source || '',
      ...(item.titleEN ? { titleEN: item.titleEN } : {}),
    });
  }
  return Object.values(groups);
}

// ==================== 原子写入 ====================
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// ==================== 单主题处理 ====================
async function processTopic(topic) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${topic.icon} 处理主题: ${topic.name}`);
  console.log('='.repeat(50));

  // 1. 抓取所有源
  const results = await Promise.allSettled(topic.sources.map(s => fetchSource(s)));

  const sourceLangMap = {};
  for (const s of topic.sources) sourceLangMap[s.name] = s.lang;

  let allRaw = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`  ✅ ${topic.sources[i].name}: ${r.value.length} 条`);
      allRaw.push(...r.value);
    } else {
      console.error(`  ❌ ${topic.sources[i].name}: ${r.reason.message}`);
    }
  });

  // 2. 翻译英文标题
  const enItems = allRaw.filter(item => sourceLangMap[item.source] === 'en');
  const cnItems = allRaw.filter(item => sourceLangMap[item.source] !== 'en');

  if (enItems.length > 0) {
    console.log(`🌐 翻译 ${enItems.length} 条英文新闻 (并发 ${TRANSLATE_CONCURRENCY})...`);
    const translated = await translateItems(enItems);
    allRaw = [...cnItems, ...translated];
    console.log('✅ 翻译完成');
  }

  // 3. 去重
  const allItems = dedup(allRaw);
  if (allItems.length === 0) {
    console.log(`⚠️ ${topic.name}: 未获取到任何新闻，跳过`);
    return;
  }
  console.log(`✅ 去重后共 ${allItems.length} 条新闻`);

  // 4. 分类
  const sections = groupByCategory(allItems, topic.categories, topic.defaultCategory);

  // 5. 写入按日期拆分的文件
  const dataDir = path.join(ROOT, topic.dataDir);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const dayFile = path.join(dataDir, `${today}.json`);
  atomicWrite(dayFile, JSON.stringify({ date: today, sections }, null, 2));

  let indexData;
  const indexPath = path.join(dataDir, 'index.json');
  try {
    indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch {
    indexData = { topic: topic.id, name: topic.name, icon: topic.icon, updatedAt: '', days: [] };
  }

  let totalItems = 0;
  const categories = [];
  for (const sec of sections) {
    totalItems += sec.items.length;
    categories.push({ icon: sec.icon, title: sec.title, count: sec.items.length });
  }
  const todayEntry = { date: today, totalItems, categories };

  const existIdx = indexData.days.findIndex(d => d.date === today);
  if (existIdx >= 0) {
    indexData.days[existIdx] = todayEntry;
  } else {
    indexData.days.unshift(todayEntry);
  }
  indexData.days = indexData.days.slice(0, MAX_DAYS);
  indexData.updatedAt = new Date().toISOString();

  atomicWrite(indexPath, JSON.stringify(indexData, null, 2));

  const allDayFiles = fs.readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  for (const old of allDayFiles.slice(MAX_DAYS)) {
    fs.unlinkSync(path.join(dataDir, old));
  }

  console.log(`📂 已更新 ${topic.dataDir}/ (${indexData.days.length} 天拆分文件)`);
}

// ==================== 主逻辑 ====================
async function main() {
  console.log('🚀 通用新闻聚合引擎 v3.1');
  console.log(`⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  loadCache();

  let topics;
  try {
    topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf-8'));
  } catch (e) {
    console.error('❌ 无法读取 topics.json:', e.message);
    process.exit(1);
  }

  // 按 --topic 参数过滤
  if (FILTER_TOPIC) {
    const before = topics.length;
    topics = topics.filter(t => t.id === FILTER_TOPIC);
    if (topics.length === 0) {
      console.error(`❌ 未找到主题: ${FILTER_TOPIC}（可用: ${JSON.stringify(topics.map(t => t.id))}）`);
      process.exit(1);
    }
    console.log(`🎯 仅更新主题: ${FILTER_TOPIC}`);
  } else {
    console.log(`📋 共 ${topics.length} 个主题: ${topics.map(t => t.name).join(', ')}`);
  }

  for (const topic of topics) {
    await processTopic(topic);
  }

  saveCache();
  console.log('\n✅ 全部完成！');
}

main().catch(e => {
  console.error('❌ 更新失败:', e);
  process.exit(1);
});
