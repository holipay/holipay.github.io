/**
 * 通用新闻聚合引擎 v3.0
 * 读取 topics.json 配置，为每个主题抓取、翻译、分类、输出
 *
 * 翻译方案：多源容错翻译 + 本地缓存
 *   1. 本地翻译缓存（translations-cache.json），避免重复调用
 *   2. 主翻译源：MyMemory（免费，无需 key）
 *   3. 备用翻译源：Google Translate 网页接口（免费，非官方）
 *   4. 翻译失败时保留英文原文
 *
 * v3.0 优化：
 *   - 翻译并发池（默认 3 并发），大幅提速
 *   - gzip 传输压缩支持
 *   - 去重 key 加长 + source 维度
 *   - 分类预处理关键词小写
 *   - 原子文件写入
 *   - fetchUrl 循环重定向检测
 *   - fetchSource 自动重试（5xx/timeout）
 *   - 翻译 try-catch 保护
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
const MAX_DAYS = 365;
const FEED_MAX_DAYS = 3;
const TRANSLATE_CONCURRENCY = 3;
const MAX_RETRIES = 1;

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
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
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
  // 取前 80 + 后 20 字符，减少碰撞
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

  // 并发翻译池
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
        // 始终保留英文原文用于分类
        results.push({ ...item, title: zh, titleEN: item.title });
      } catch {
        failed++;
        results.push({ ...item, titleEN: item.title });
      }
    } else {
      results.push(item);
    }
  }

  // 启动并发池
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

  // RSS 2.0: <item>
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

  // Atom: <entry>
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
  // 用英文原文匹配关键词（翻译前的标题更精准）
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
    .replace(/^[💹🎓📱📰🛢️📈🏦💰🖥️🌍🤖🧠👥🏛️📖⚙️🏥📚⚖️🚗🏠📊💹🎓📱📰🛢️📈🏦💰🖥️🌍🤖🧠👥🏛️📖⚙️🏥📚⚖️🚗🏠📊]+/gu, '') // 去emoji
    .replace(/^[\s\-–—·|：:]+/, '')          // 去前导标点
    .replace(/\s*[-–—]\s*(Reuters|Bloomberg|WSJ|CNBC|Financial Times|FT|BBC|CNN|NBER|36氪|IT之家|新浪财经|观察者|爱范儿|Sohu|东方财富|凤凰网科技|投资者商业日报|华尔街日报)\s*$/i, '') // 去来源后缀
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function dedup(items) {
  const seen = new Set();
  return items.filter(item => {
    // 1. URL 相同直接去重
    if (item.link && seen.has('url:' + item.link)) return false;
    if (item.link) seen.add('url:' + item.link);

    // 2. 优先用英文原文（titleEN）做 key，更稳定；否则用标准化后的中文标题
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

// ==================== 输出 ====================
function escapeXml(str) {
  if (typeof str !== 'string') str = String(str || '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeItem(item) {
  if (typeof item === 'string') return { title: item, link: '', source: '', titleEN: '' };
  return { title: item.title || '', link: item.link || '', source: item.source || '', titleEN: item.titleEN || '' };
}

// ==================== 合并 Feed 生成 ====================
function buildMergedFeedXml(allTopicData, siteUrl) {
  // 收集所有条目，带上日期和主题信息
  const allItems = [];

  for (const { topic, days } of allTopicData) {
    for (const day of days.slice(0, FEED_MAX_DAYS)) {
      const pubDate = new Date(day.date + 'T09:00:00+08:00').toUTCString();
      for (const section of day.sections) {
        for (const raw of section.items) {
          const news = normalizeItem(raw);
          allItems.push({
            title: `${topic.icon} ${section.icon} ${news.title}`,
            link: news.link || siteUrl,
            description: news.titleEN
              ? `[${news.source}] ${news.title} (${news.titleEN})`
              : news.source ? `[${news.source}] ${news.title}]` : news.title,
            category: `${topic.name} - ${section.title}`,
            pubDate,
            guid: `${day.date}-${topic.id}-${news.title.slice(0, 40)}`,
            sortKey: day.date + '-' + (news.title || ''),
          });
        }
      }
    }
  }

  // 按日期降序排列
  allItems.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  const items = allItems.map(item => `  <item>
    <title>${escapeXml(item.title)}</title>
    <link>${escapeXml(item.link)}</link>
    <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
    <pubDate>${item.pubDate}</pubDate>
    <description>${escapeXml(item.description)}</description>
    <category>${escapeXml(item.category)}</category>
  </item>
`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>纳思 - 海纳百思</title>
  <link>${siteUrl}</link>
  <description>每日自动聚合全球金融、社科前沿、科技资讯</description>
  <language>zh-cn</language>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  <atom:link href="${siteUrl}feed.xml" rel="self" type="application/rss+xml"/>
${items}</channel>
</rss>`;
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

  // 预建源语言映射
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

  // 5. 写入数据文件（原子写入）
  const dataPath = path.join(ROOT, topic.dataFile);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch {}

  existing = existing.filter(d => d.date !== today);
  existing.unshift({ date: today, sections });
  existing = existing.slice(0, MAX_DAYS);

  atomicWrite(dataPath, JSON.stringify(existing, null, 2));
  console.log(`📝 已更新 ${topic.dataFile} (${existing.length} 天数据)`);

  // 5b. 写入按日期拆分的文件（新格式）
  if (topic.dataDir) {
    const dataDir = path.join(ROOT, topic.dataDir);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // 写入当天数据文件
    const dayFile = path.join(dataDir, `${today}.json`);
    atomicWrite(dayFile, JSON.stringify({ date: today, sections }, null, 2));

    // 增量更新索引：读取现有索引，插入/更新今天的条目
    let indexData;
    const indexPath = path.join(dataDir, 'index.json');
    try {
      indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch {
      indexData = { topic: topic.id, name: topic.name, icon: topic.icon, updatedAt: '', days: [] };
    }

    // 构建今天的索引条目
    let totalItems = 0;
    const categories = [];
    for (const sec of sections) {
      totalItems += sec.items.length;
      categories.push({ icon: sec.icon, title: sec.title, count: sec.items.length });
    }
    const todayEntry = { date: today, totalItems, categories };

    // 替换或插入
    const existIdx = indexData.days.findIndex(d => d.date === today);
    if (existIdx >= 0) {
      indexData.days[existIdx] = todayEntry;
    } else {
      indexData.days.unshift(todayEntry);
    }
    indexData.days = indexData.days.slice(0, MAX_DAYS);
    indexData.updatedAt = new Date().toISOString();

    atomicWrite(indexPath, JSON.stringify(indexData, null, 2));

    // 清理超出 MAX_DAYS 的旧文件
    const allDayFiles = fs.readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    for (const old of allDayFiles.slice(MAX_DAYS)) {
      fs.unlinkSync(path.join(dataDir, old));
    }

    console.log(`📂 已更新 ${topic.dataDir}/ (${indexData.days.length} 天拆分文件)`);
  }
}

// ==================== 主逻辑 ====================
async function main() {
  console.log('🚀 通用新闻聚合引擎 v3.0');
  console.log(`⏰ ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  loadCache();

  let topics;
  try {
    topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf-8'));
  } catch (e) {
    console.error('❌ 无法读取 topics.json:', e.message);
    process.exit(1);
  }

  console.log(`📋 共 ${topics.length} 个主题: ${topics.map(t => t.name).join(', ')}`);

  // 收集所有主题数据用于合并 feed
  const allTopicData = [];

  for (const topic of topics) {
    await processTopic(topic);

    // 读取已生成的数据用于合并 feed
    try {
      const dataDir = path.join(ROOT, topic.dataDir);
      const indexPath = path.join(dataDir, 'index.json');
      if (fs.existsSync(indexPath)) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const days = [];
        for (const dayInfo of index.days) {
          const dayFile = path.join(dataDir, `${dayInfo.date}.json`);
          if (fs.existsSync(dayFile)) {
            days.push(JSON.parse(fs.readFileSync(dayFile, 'utf-8')));
          }
        }
        allTopicData.push({ topic, days });
      }
    } catch (e) {
      console.warn(`⚠️ 跳过合并 feed 的 ${topic.name}:`, e.message);
    }
  }

  // 生成合并 feed.xml
  if (allTopicData.length > 0) {
    const siteUrl = 'https://nase.me/';
    const mergedFeed = buildMergedFeedXml(allTopicData, siteUrl);
    atomicWrite(path.join(ROOT, 'feed.xml'), mergedFeed);
    console.log('📝 已更新 feed.xml (合并)');
  }

  saveCache();
  console.log('\n✅ 全部完成！');
}

main().catch(e => {
  console.error('❌ 更新失败:', e);
  process.exit(1);
});
