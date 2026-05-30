/**
 * 通用新闻聚合引擎 v4.0
 *
 * v4.0 变更：
 *   - 先去重再翻译：中文条目无需翻译即可去重，减少翻译 API 调用
 *   - 模糊去重：基于 bigram Jaccard 相似度（阈值 75%）判断标题重复
 *   - URL 精确去重：URL 相同一定重复，无需计算相似度
 *
 * v3.2 变更：
 *   - 跨日期去重：扫描近 7 天历史数据，相同 URL 或标题的新闻不再重复添加
 *   - 代码结构优化：统一引号风格，提取常量 DEDUP_DAYS
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

const https = require("https");
const http = require("http");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const fsPromises = fs.promises;
const { isEnglish, similarity, SHORT_TITLE_LENGTH } = require("./shared.js");

// 复用 TCP 连接（keep-alive），避免 RSS 批量抓取时反复建连
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

const ROOT = path.resolve(__dirname, "../..");
const SCRIPTS_DIR = __dirname;
const CACHE_FILE = path.join(SCRIPTS_DIR, "translations-cache.json");
const TOPICS_FILE = path.join(SCRIPTS_DIR, "topics.json");
const HEALTH_FILE = path.join(SCRIPTS_DIR, "source-health.json");
const METRICS_FILE = path.join(SCRIPTS_DIR, "run-metrics.json");
const ETAG_FILE = path.join(SCRIPTS_DIR, "source-etag.json");
const RETENTION_DAYS = 30; // 数据保留天数（1个月）
const MAX_ITEMS_PER_CATEGORY = 40; // 每个分类最大记录数（与 trim-data.js 保持一致）
const MAX_CONSECUTIVE_FAILURES = 3; // 连续失败告警阈值
const MAX_CACHE_SIZE = 3000; // 翻译缓存最大条目数
const MAX_METRICS_HISTORY = 30; // 保留最近30次运行的指标

// 社科类分类条数限制（降低权重）
const CATEGORY_ITEM_LIMITS = {
  心理学与认知: 30,
  教育与媒体: 30,
  环境与能源: 20,
  法律与伦理: 20,
};

const RECENT_DAYS = 7; // recent.json 保留天数（从14天缩短到7天，减少文件大小）
const SIMILARITY_THRESHOLD = 0.75; // 标题相似度阈值（75% 以上视为重复）
const TRANSLATE_CONCURRENCY = 8;
const MAX_RETRIES = 2; // 增加重试次数，提升网络抖动容错

// 超时配置（按源类型）
const TIMEOUT_CONFIG = {
  rss: 20000,    // RSS源：20秒（部分学术RSS较慢）
  api: 15000,    // API源：15秒
  default: 15000 // 默认：15秒
};

// 特定源的超时覆盖（源名称 -> 超时毫秒数）
const SOURCE_TIMEOUT_OVERRIDES = {
  "NBER": 30000,           // 学术机构，响应较慢
  "PNAS Social Science": 30000,
  "Nature Human Behaviour": 25000,
  "ScienceDirect": 25000,
  "Google News Academic": 25000,
  "Brookings": 25000,
  "Foreign Affairs": 25000,
};

// ==================== 命令行参数 ====================
const FILTER_TOPIC =
  process.argv.find((a) => a.startsWith("--topic="))?.split("=")[1] || null;

// ==================== 工具函数 ====================
function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

// ==================== HTTP 请求 ====================
function fetchUrl(url, maxRedirects = 3, _visited = new Set(), timeout = TIMEOUT_CONFIG.default, options = {}) {
  return new Promise((resolve, reject) => {
    if (_visited.has(url))
      return reject(new Error(`Circular redirect: ${url}`));
    _visited.add(url);

    const mod = url.startsWith("https") ? https : http;
    const agent = url.startsWith("https") ? httpsAgent : httpAgent;
    const req = mod.get(
      url,
      {
        agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NewsAggregatorBot/3.0)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate",
          ...(options.conditionalHeaders || {}),
        },
        timeout,
      },
      (res) => {
        // 304 Not Modified — 源无更新
        if (res.statusCode === 304) {
          res.resume();
          resolve({ notModified: true });
          return;
        }
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const redirectUrl = new URL(res.headers.location, url).href;
          res.resume();
          return fetchUrl(redirectUrl, maxRedirects - 1, _visited, timeout, options)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        let stream = res;
        const encoding = res.headers["content-encoding"];
        if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate")
          stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (options.conditionalHeaders) {
            resolve({
              body,
              etag: res.headers.etag,
              lastModified: res.headers["last-modified"],
            });
          } else {
            resolve(body);
          }
        });
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

async function fetchWithRetry(url, retries = MAX_RETRIES, timeout = TIMEOUT_CONFIG.default, options = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchUrl(url, 3, new Set(), timeout, options);
    } catch (e) {
      const msg = e.message || "";
      const isRateLimited = msg.includes("HTTP 429");
      const isTimeout = msg.includes("Timeout");
      const retryable =
        isRateLimited ||
        isTimeout ||
        msg.includes("HTTP 5") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("socket hang up");

      // 检测429限流，调整延迟
      if (isRateLimited) {
        if (url.includes("mymemory")) adjustRateLimit("myMemory", false, true);
        else if (url.includes("googleapis")) adjustRateLimit("google", false, true);
      }

      if (i < retries && retryable) {
        const baseDelay = isRateLimited ? getRateLimitDelay("google") : 2000;
        const delay = baseDelay * (i + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

// ==================== 翻译缓存 ====================
let translationCache = {};
let _cacheDirty = false; // 脏标记：仅在有新翻译时写盘

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      translationCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      const count = Object.keys(translationCache).length;
      if (count > 0) console.log(`📦 加载翻译缓存: ${count} 条`);
    }
  } catch {
    translationCache = {};
  }
  _cacheDirty = false;
}

function saveCache() {
  if (!_cacheDirty) {
    console.log(`📦 翻译缓存未变更，跳过保存`);
    return;
  }
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const [key, entry] of Object.entries(translationCache)) {
      if (entry.ts && entry.ts < cutoff) delete translationCache[key];
    }

    // 容量限制：超过上限时淘汰最旧的条目（LRU策略）
    const entries = Object.entries(translationCache);
    if (entries.length > MAX_CACHE_SIZE) {
      // 按时间戳排序，淘汰最旧的
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      const evictCount = entries.length - MAX_CACHE_SIZE;
      const toKeep = entries.slice(0, MAX_CACHE_SIZE);
      translationCache = Object.fromEntries(toKeep);
      console.log(`🗑️ 翻译缓存淘汰 ${evictCount} 条旧数据，保留 ${MAX_CACHE_SIZE} 条`);
    }

    const tmp = CACHE_FILE + ".tmp";
    // 紧凑序列化（无缩进），减少文件体积 ~60%
    fs.writeFileSync(tmp, JSON.stringify(translationCache), "utf-8");
    fs.renameSync(tmp, CACHE_FILE);
    console.log(`💾 保存翻译缓存: ${Object.keys(translationCache).length} 条`);
    _cacheDirty = false;
  } catch (e) {
    console.error("⚠️ 缓存保存失败:", e.message);
  }
}

function cacheKey(text) {
  const t = text.trim();
  if (t.length <= 80) return t.toLowerCase();
  return (t.slice(0, 80) + t.slice(-20)).toLowerCase();
}

// ==================== 源健康监控 ====================
let sourceHealthData = {};

function loadSourceHealth() {
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      sourceHealthData = JSON.parse(fs.readFileSync(HEALTH_FILE, "utf-8"));
      const count = Object.keys(sourceHealthData).length;
      if (count > 0) console.log(`📊 加载源健康数据: ${count} 个源`);
    }
  } catch {
    sourceHealthData = {};
  }
}

function saveSourceHealth() {
  try {
    const tmp = HEALTH_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(sourceHealthData, null, 2), "utf-8");
    fs.renameSync(tmp, HEALTH_FILE);
    console.log(`💾 保存源健康数据: ${Object.keys(sourceHealthData).length} 个源`);
  } catch (e) {
    console.error("⚠️ 源健康数据保存失败:", e.message);
  }
}

function updateSourceHealth(name, success, itemCount, errorMsg) {
  if (!sourceHealthData[name]) {
    sourceHealthData[name] = {
      firstSeen: new Date().toISOString(),
      totalChecks: 0,
      totalSuccess: 0,
      totalFailure: 0,
      consecutiveFailures: 0,
      lastItems: 0,
    };
  }
  const entry = sourceHealthData[name];
  entry.totalChecks++;
  entry.lastCheck = new Date().toISOString();

  if (success) {
    entry.totalSuccess++;
    entry.consecutiveFailures = 0;
    entry.lastItems = itemCount;
    entry.lastSuccess = entry.lastCheck;
  } else {
    entry.totalFailure++;
    entry.consecutiveFailures++;
    entry.lastError = errorMsg || "Unknown error";
    entry.lastFailure = entry.lastCheck;
  }

  entry.successRate = Math.round((entry.totalSuccess / entry.totalChecks) * 100);
}

function checkSourceHealthAlerts() {
  const alerts = [];
  for (const [name, entry] of Object.entries(sourceHealthData)) {
    if (entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      alerts.push({
        name,
        failures: entry.consecutiveFailures,
        lastError: entry.lastError,
      });
    }
  }
  return alerts;
}

// ==================== 源 ETag 缓存（增量抓取） ====================
let etagData = {};

function loadEtagData() {
  try {
    if (fs.existsSync(ETAG_FILE)) {
      etagData = JSON.parse(fs.readFileSync(ETAG_FILE, "utf-8"));
      const count = Object.keys(etagData).length;
      if (count > 0) console.log(`🔖 加载 ETag 缓存: ${count} 个源`);
    }
  } catch {
    etagData = {};
  }
}

function saveEtagData() {
  try {
    const tmp = ETAG_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(etagData), "utf-8");
    fs.renameSync(tmp, ETAG_FILE);
    console.log(`💾 保存 ETag 缓存: ${Object.keys(etagData).length} 个源`);
  } catch (e) {
    console.error("⚠️ ETag 数据保存失败:", e.message);
  }
}

function updateEtag(sourceName, responseHeaders) {
  const entry = {};
  if (responseHeaders.etag) entry.etag = responseHeaders.etag;
  if (responseHeaders["last-modified"]) entry.lastModified = responseHeaders["last-modified"];
  if (entry.etag || entry.lastModified) {
    entry.lastCheck = new Date().toISOString();
    etagData[sourceName] = entry;
  }
}

// ==================== 运行指标收集 ====================
const metrics = {
  startTime: null,
  endTime: null,
  duration: 0,
  topics: [],
  totals: {
    sourcesAttempted: 0,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    sourcesSkipped: 0,
    itemsFetched: 0,
    itemsDeduped: 0,
    itemsFinal: 0,
    translateCached: 0,
    translateNew: 0,
    translateFailed: 0,
    categories: 0,
  },
};

function startMetrics() {
  metrics.startTime = new Date().toISOString();
  metrics.topics = [];
  metrics.totals = {
    sourcesAttempted: 0,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    sourcesSkipped: 0,
    itemsFetched: 0,
    itemsDeduped: 0,
    itemsFinal: 0,
    translateCached: 0,
    translateNew: 0,
    translateFailed: 0,
    categories: 0,
  };
}

function recordTopicMetrics(topicName, data) {
  metrics.topics.push({
    name: topicName,
    ...data,
  });
  // 累加到总计
  metrics.totals.sourcesAttempted += data.sourcesAttempted || 0;
  metrics.totals.sourcesSucceeded += data.sourcesSucceeded || 0;
  metrics.totals.sourcesFailed += data.sourcesFailed || 0;
  metrics.totals.sourcesSkipped += data.sourcesSkipped || 0;
  metrics.totals.itemsFetched += data.itemsFetched || 0;
  metrics.totals.itemsDeduped += data.itemsDeduped || 0;
  metrics.totals.itemsFinal += data.itemsFinal || 0;
  metrics.totals.translateCached += data.translateCached || 0;
  metrics.totals.translateNew += data.translateNew || 0;
  metrics.totals.translateFailed += data.translateFailed || 0;
  metrics.totals.categories += data.categories || 0;
}

function finishMetrics() {
  metrics.endTime = new Date().toISOString();
  metrics.duration = new Date(metrics.endTime) - new Date(metrics.startTime);
}

function saveMetrics() {
  try {
    let history = [];
    if (fs.existsSync(METRICS_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(METRICS_FILE, "utf-8"));
      } catch {
        history = [];
      }
    }

    history.push(metrics);

    // 保留最近 N 次运行
    if (history.length > MAX_METRICS_HISTORY) {
      history = history.slice(-MAX_METRICS_HISTORY);
    }

    const tmp = METRICS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), "utf-8");
    fs.renameSync(tmp, METRICS_FILE);
    console.log(`📊 保存运行指标: 第 ${history.length} 次记录`);
  } catch (e) {
    console.error("⚠️ 指标保存失败:", e.message);
  }
}

// ==================== 翻译工具 ====================
// 自适应限流配置
const RATE_LIMIT_CONFIG = {
  myMemory: { base: 300, current: 300, min: 200, max: 2000, step: 100 },
  google: { base: 300, current: 300, min: 200, max: 2000, step: 100 },
  deepseek: { base: 500, current: 500, min: 300, max: 5000, step: 200 },
  batch: { base: 200, current: 200, min: 100, max: 2000, step: 100 },
};

function adjustRateLimit(provider, success, isRateLimited = false) {
  const config = RATE_LIMIT_CONFIG[provider];
  if (!config) return;

  if (isRateLimited) {
    // 被限流时，增加延迟
    config.current = Math.min(config.current + config.step * 2, config.max);
    console.log(`    ⚠️ ${provider} 被限流，延迟调整为 ${config.current}ms`);
  } else if (success) {
    // 成功时，逐步减少延迟（但不低于基础值）
    config.current = Math.max(config.current - config.step, config.base);
  }
}

function getRateLimitDelay(provider) {
  return RATE_LIMIT_CONFIG[provider]?.current || 200;
}

async function translateMyMemory(text) {
  const encoded = encodeURIComponent(text.slice(0, 450));
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|zh-CN`;
  const json = await fetchWithRetry(url);
  const data = JSON.parse(json);
  const translated = data?.responseData?.translatedText;
  if (
    translated &&
    translated.toLowerCase() !== text.toLowerCase() &&
    !translated.includes("MYMEMORY")
  ) {
    adjustRateLimit("myMemory", true);
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
    return data[0].map((s) => s[0]).join("");
  }
  return null;
}

async function translateDeepSeek(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "你是翻译引擎。将用户输入的英文翻译为中文，只输出翻译结果，不加任何解释、引号或标点符号。如果输入已是中文，直接原样输出。",
        },
        { role: "user", content: text.slice(0, 500) },
      ],
      temperature: 0.1,
      max_tokens: 200,
    });

    const req = https.request(
      {
        hostname: "api.deepseek.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const result = data?.choices?.[0]?.message?.content?.trim();
            if (result && result.toLowerCase() !== text.toLowerCase()) {
              resolve(result);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

async function translateENtoZH(text) {
  const key = cacheKey(text);
  if (translationCache[key] && translationCache[key].zh) {
    return translationCache[key].zh;
  }

  let translated = null;

  // 1. MyMemory（免费，速度快）
  try {
    translated = await translateMyMemory(text);
  } catch {}

  // 2. Google Translate（免费，作为备选）
  if (!translated) {
    try {
      await new Promise((r) => setTimeout(r, getRateLimitDelay("google")));
      translated = await translateGoogle(text);
    } catch {}
  }

  // 3. DeepSeek（付费 API，最后兜底）
  if (!translated) {
    try {
      await new Promise((r) => setTimeout(r, getRateLimitDelay("deepseek")));
      translated = await translateDeepSeek(text);
      if (translated)
        console.log(`    🤖 DeepSeek 翻译兜底: "${text.slice(0, 40)}..."`);
    } catch {}
  }

  if (translated) {
    translationCache[key] = { zh: translated, ts: Date.now() };
    _cacheDirty = true;
    return translated;
  }
  return text;
}

// ===== 批量翻译（减少 API 调用次数）=====
const BATCH_SIZE = 15; // DeepSeek 单次翻译条数

async function translateBatchDeepSeek(texts) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || texts.length === 0) return new Map();

  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content:
          "你是翻译引擎。将用户输入的英文新闻标题逐行翻译为中文。保持相同的行数和顺序，每行只输出翻译结果，不加编号、引号或解释。如果某行已是中文，原样输出。",
      },
      { role: "user", content: numbered },
    ],
    temperature: 0.1,
    max_tokens: Math.max(800, texts.length * 80),
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.deepseek.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const content = data?.choices?.[0]?.message?.content?.trim() || "";
            const lines = content
              .split("\n")
              .map((l) => l.replace(/^\d+\.\s*/, "").trim());
            const result = new Map();
            for (let i = 0; i < texts.length; i++) {
              const translated = lines[i] || "";
              if (
                translated &&
                translated.toLowerCase() !== texts[i].toLowerCase()
              ) {
                result.set(texts[i], translated);
                translationCache[cacheKey(texts[i])] = {
                  zh: translated,
                  ts: Date.now(),
                };
                _cacheDirty = true;
              }
            }
            resolve(result);
          } catch {
            resolve(new Map());
          }
        });
      },
    );
    req.on("error", () => resolve(new Map()));
    req.on("timeout", () => {
      req.destroy();
      resolve(new Map());
    });
    req.write(body);
    req.end();
  });
}

async function translateItems(items) {
  const results = [];
  let cached = 0;
  let newTranslated = 0;
  let failed = 0;

  // 分离英文/非英文
  const enItems = [];
  const nonEnItems = [];
  for (const item of items) {
    if (isEnglish(item.title)) {
      const key = cacheKey(item.title);
      if (translationCache[key] && translationCache[key].zh) {
        cached++;
        results.push({
          ...item,
          title: translationCache[key].zh,
          titleEN: item.title,
        });
      } else {
        enItems.push(item);
      }
    } else {
      nonEnItems.push(item);
    }
  }
  results.push(...nonEnItems);

  if (enItems.length === 0) {
    console.log(`📊 翻译统计: ${cached} 缓存, 0 新翻译, 0 失败`);
    return { items: results, stats: { cached, newTranslated, failed } };
  }

  // 批量翻译（DeepSeek 单次翻译多条）
  const texts = enItems.map((i) => i.title);
  console.log(`🌐 批量翻译 ${texts.length} 条 (每批 ${BATCH_SIZE} 条)...`);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(texts.length / BATCH_SIZE);
    console.log(
      `  📦 批次 ${batchNum}/${totalBatches} (${batch.length} 条)...`,
    );

    let translated;
    try {
      translated = await translateBatchDeepSeek(batch);
      newTranslated += translated.size;
    } catch (e) {
      console.warn(`  ⚠️ 批量翻译失败: ${e.message}，回退到逐条翻译`);
      translated = new Map();
    }

    // 对批量翻译失败的条目，回退到逐条翻译
    for (let j = 0; j < batch.length; j++) {
      const item = enItems[i + j];
      const zh = translated.get(batch[j]);
      if (zh) {
        results.push({ ...item, title: zh, titleEN: item.title });
      } else {
        // 回退: MyMemory → Google → DeepSeek 逐条
        try {
          const fallbackZh = await translateENtoZH(item.title);
          if (fallbackZh !== item.title) {
            newTranslated++;
            results.push({ ...item, title: fallbackZh, titleEN: item.title });
          } else {
            failed++;
            results.push({ ...item, titleEN: item.title });
          }
        } catch {
          failed++;
          results.push({ ...item, titleEN: item.title });
        }
      }
    }

    // 批次间延迟（自适应限流）
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, getRateLimitDelay("batch")));
    }
  }

  console.log(
    `📊 翻译统计: ${cached} 缓存, ${newTranslated} 新翻译, ${failed} 失败`,
  );
  return { items: results, stats: { cached, newTranslated, failed } };
}

// ==================== RSS/Atom 解析 ====================
/**
 * 从 XML 块中提取 <title> 内容（优先 CDATA，支持属性）
 */
function extractTitle(block) {
  const cdataMatch = block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/);
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = block.match(/<title[^>]*>(.*?)<\/title>/);
  if (plainMatch) return plainMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/, "$1").trim();
  return "";
}

/**
 * 从 XML 块中提取 <link> 内容（支持 href 属性或包裹内容）
 */
function extractLink(block) {
  const hrefMatch = block.match(/<link[^>]*href="([^"]+)"/);
  if (hrefMatch) return hrefMatch[1].trim();
  const contentMatch = block.match(/<link[^>]*>(.*?)<\/link>/);
  if (contentMatch) return contentMatch[1].trim();
  return "";
}

/**
 * 用 indexOf 循环遍历 XML 中所有 <tag>...</tag> 块，避免正则回溯
 */
function extractBlocks(xml, openTag, closeTag) {
  const blocks = [];
  let pos = 0;
  let start = xml.indexOf(openTag, pos);
  while (start !== -1) {
    const end = xml.indexOf(closeTag, start);
    if (end === -1) break;
    blocks.push(xml.slice(start, end + closeTag.length));
    pos = end + closeTag.length;
    start = xml.indexOf(openTag, pos);
  }
  return blocks;
}

function parseRssItems(xml, filterRegex) {
  const items = [];

  // 优先 RSS 格式：<item>...</item>
  const rssBlocks = extractBlocks(xml, "<item>", "</item>");
  for (const block of rssBlocks) {
    const title = extractTitle(block);
    if (!title) continue;
    if (filterRegex && !filterRegex.test(title)) continue;
    const link = extractLink(block);
    items.push({ title, link: link || "" });
  }

  // 无 RSS 命中则尝试 Atom 格式：<entry>...</entry>
  if (items.length === 0) {
    const atomBlocks = extractBlocks(xml, "<entry>", "</entry>");
    for (const block of atomBlocks) {
      const title = extractTitle(block);
      if (!title) continue;
      if (filterRegex && !filterRegex.test(title)) continue;
      const link = extractLink(block);
      items.push({ title, link: link || "" });
    }
  }

  return items;
}

// ==================== 通用源抓取 ====================
async function fetchSource(source) {
  let items = [];

  // 确定超时时间：源特定配置 > 源类型默认 > 全局默认
  const timeout = source.timeout 
    || SOURCE_TIMEOUT_OVERRIDES[source.name] 
    || TIMEOUT_CONFIG[source.type] 
    || TIMEOUT_CONFIG.default;

  try {
    if (source.type === "rss") {
      // 增量抓取：发送条件请求头
      const cached = etagData[source.name];
      const options = cached
        ? {
            conditionalHeaders: {
              ...(cached.etag ? { "If-None-Match": cached.etag } : {}),
              ...(cached.lastModified ? { "If-Modified-Since": cached.lastModified } : {}),
            },
          }
        : {};

      const result = await fetchWithRetry(source.url, MAX_RETRIES, timeout, options);

      // 304 Not Modified — 源无更新，跳过
      if (result && result.notModified) {
        return { items: [], skipped: true };
      }

      // 有更新 — 保存新的 etag
      if (result && typeof result === "object" && result.etag !== undefined) {
        updateEtag(source.name, { etag: result.etag, "last-modified": result.lastModified });
      }

      const xml = typeof result === "string" ? result : result.body;
      const filter = source.filter ? new RegExp(source.filter, "i") : null;
      const parsed = parseRssItems(xml, filter);
      parsed.forEach((item) => items.push({ ...item, source: source.name }));
    } else if (source.type === "api") {
      const json = await fetchWithRetry(source.url, MAX_RETRIES, timeout);
      const data = JSON.parse(json);

      if (source.parse === "36kr") {
        const list = data?.data?.items || data?.data?.word_items || [];
        for (const item of list) {
          const info = item.item || item;
          const title = (info.title || "").replace(/<[^>]+>/g, "").trim();
          const link = info.id ? `https://36kr.com/p/${info.id}` : "";
          if (title) items.push({ title, link, source: source.name });
        }
      } else if (source.parse === "sina") {
        const list = data?.result?.data || [];
        const filter = source.filter ? new RegExp(source.filter, "i") : null;
        for (const item of list) {
          const title = (item.title || "").trim();
          const link = item.url || "";
          if (title && (!filter || filter.test(title))) {
            items.push({ title, link, source: source.name });
          }
        }
      }
    }
  } catch (e) {
    console.error(`  ❌ ${source.name}: ${e.message}`);
  }

  // Apply exclude filter
  if (source.exclude) {
    const excludeRegex = new RegExp(source.exclude, "i");
    const before = items.length;
    items = items.filter((item) => !excludeRegex.test(item.title));
    if (before !== items.length) {
      console.log(
        `  🚫 ${source.name}: exclude 过滤 ${before - items.length} 条`,
      );
    }
  }

  return { items, skipped: false };
}

// ==================== 分类 ====================
function preprocessCategories(categories) {
  return categories.map((cat) => ({
    ...cat,
    _kwLower: cat.keywords.map((kw) => kw.toLowerCase()),
  }));
}

function classify(item, processedCats, defaultCat) {
  const titleEN = (
    typeof item === "string" ? "" : item.titleEN || ""
  ).toLowerCase();
  const title = (
    typeof item === "string" ? item : item.title || ""
  ).toLowerCase();
  const matchTarget = titleEN || title;
  for (const cat of processedCats) {
    if (cat._kwLower.some((kw) => matchTarget.includes(kw))) return cat;
  }
  return defaultCat;
}

/**
 * 带置信度的分类
 * 返回 { category, matchCount, matchedKeywords }
 */
function classifyWithConfidence(item, processedCats, defaultCat) {
  const titleEN = (
    typeof item === "string" ? "" : item.titleEN || ""
  ).toLowerCase();
  const title = (
    typeof item === "string" ? item : item.title || ""
  ).toLowerCase();
  const matchTarget = titleEN || title;

  let bestCat = defaultCat;
  let bestMatchCount = 0;
  let bestMatchedKws = [];

  for (const cat of processedCats) {
    const matchedKws = cat._kwLower.filter((kw) => matchTarget.includes(kw));
    if (matchedKws.length > bestMatchCount) {
      bestMatchCount = matchedKws.length;
      bestCat = cat;
      bestMatchedKws = matchedKws;
    }
  }

  return {
    category: bestCat,
    matchCount: bestMatchCount,
    matchedKeywords: bestMatchedKws,
  };
}

function normalizeTitle(title) {
  return (title || "")
    .replace(
      /^[\u{1F4B8}\u{1F393}\u{1F4F1}\u{1F4F0}\u{1F6E2}\u{1F4C8}\u{1F3E6}\u{1F4B0}\u{1F5A5}\u{1F30D}\u{1F916}\u{1F9E0}\u{1F465}\u{1F3DB}\u{1F4D6}\u{2699}\u{1F3E5}\u{1F4DA}\u{2696}\u{1F697}\u{1F3E0}\u{1F4CA}\u{1F4B8}\u{1F393}\u{1F4F1}\u{1F4F0}\u{1F6E2}\u{1F4C8}\u{1F3E6}\u{1F4B0}\u{1F5A5}\u{1F30D}\u{1F916}\u{1F9E0}\u{1F465}\u{1F3DB}\u{1F4D6}\u{2699}\u{1F3E5}\u{1F4DA}\u{2696}\u{1F697}\u{1F3E0}\u{1F4CA}]+/gu,
      "",
    )
    .replace(/^[\s\-\u2013\u2014\u00B7\uFF5C\uFF1A:]+/, "")
    .replace(
      /\s*[\-\u2013\u2014]\s*(Reuters|Bloomberg|WSJ|CNBC|Financial Times|FT|BBC|CNN|NBER|36\u6C2A|IT\u4E4B\u5BB6|\u65B0\u6D6A\u8D22\u7ECF|\u89C2\u5BDF\u8005|\u7231\u8303\u513F|Sohu|\u4E1C\u65B9\u8D22\u5BCC|\u51E4\u51F0\u7F51\u79D1\u6280|\u6295\u8D44\u8005\u5546\u4E1A\u65E5\u62A5|\u534E\u5C14\u8857\u65E5\u62A5)\s*$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * 从历史数据文件中加载已有条目的标准化标题（用于模糊去重）
 *
 * v2: 优先读取 titles-index.json（单文件），
 *     仅在不存�?时回退到遍历所有分类文件
 * @param {string} dataDir
 * @returns {string[]}
 */
function loadExistingTitles(dataDir) {
  const indexPath = path.join(dataDir, "titles-index.json");

  // 尝试从索引文件读取（单文�? IO）
  try {
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      if (Array.isArray(index.titles)) {
        console.log(`  📦 从 titles-index 加载 ${index.titles.length} 条历史标题`);
        return index.titles;
      }
    }
  } catch {}

  // 回退：读取所有分类文件
  const titles = [];
  try {
    if (!fs.existsSync(dataDir)) return titles;

    const catFiles = fs
      .readdirSync(dataDir)
      .filter(
        (f) =>
          f.endsWith(".json") &&
          f !== "meta.json" &&
          f !== "data.json" &&
          f !== "index.json" &&
          f !== "titles-index.json" &&
          !/^\d{4}-\d{2}-\d{2}\.json$/.test(f),
      );
    for (const file of catFiles) {
      try {
        const catData = JSON.parse(
          fs.readFileSync(path.join(dataDir, file), "utf-8"),
        );
        if (catData.items) {
          for (const item of catData.items) {
            const norm = normalizeTitle(item.title);
            if (norm) titles.push(norm);
          }
        }
      } catch {}
    }
  } catch {}
  return titles;
}

/**
 * 保存标题索引文件（供下次运行时快速加�?
 */
function saveTitlesIndex(dataDir, titles) {
  const indexPath = path.join(dataDir, "titles-index.json");
  const tmp = indexPath + ".tmp";
  fs.writeFileSync(
    tmp,
    JSON.stringify({ updatedAt: new Date().toISOString(), titles }),
    "utf-8",
  );
  fs.renameSync(tmp, indexPath);
}

/**
 * 检查是否已按分类存储
 */
function isCategoryFormat(dataDir) {
  if (!fs.existsSync(dataDir)) return false;
  const catFiles = fs
    .readdirSync(dataDir)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        f !== "meta.json" &&
        f !== "data.json" &&
        f !== "index.json" &&
        f !== "titles-index.json" &&
        f !== "latest.json" &&
        !f.endsWith("_archive.json") &&
        !/^\d{4}-\d{2}-\d{2}\.json$/.test(f),
    );
  return catFiles.length > 0;
}

/**
 * 迁移到按分类存储格式
 */
function migrateToCategoryFiles(dataDir, topic) {
  if (isCategoryFormat(dataDir)) return;

  if (!fs.existsSync(dataDir)) return;

  // 1. 从 data.json 迁移
  const dataFile = path.join(dataDir, "data.json");
  if (fs.existsSync(dataFile)) {
    console.log("📦 迁移 data.json 到按分类存储...");
    const data = JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    if (data.sections) {
      const categoryMeta = [];
      for (const sec of data.sections) {
        const catFile = path.join(
          dataDir,
          `${sanitizeFilename(sec.title)}.json`,
        );
        atomicWrite(
          catFile,
          JSON.stringify(
            {
              icon: sec.icon,
              title: sec.title,
              updatedAt: new Date().toISOString(),
              items: sec.items,
            },
            null,
            2,
          ),
        );
        categoryMeta.push({
          icon: sec.icon,
          title: sec.title,
          file: sanitizeFilename(sec.title),
          count: sec.items.length,
        });
      }
      atomicWrite(
        path.join(dataDir, "meta.json"),
        JSON.stringify(
          {
            topic: topic.id,
            name: topic.name,
            icon: topic.icon,
            updatedAt: new Date().toISOString(),
            categories: categoryMeta,
          },
          null,
          2,
        ),
      );
      fs.unlinkSync(dataFile);
      console.log(`✅ 迁移完成: ${categoryMeta.length} 个分类`);
    }
    return;
  }

  // 2. 从旧的按日期拆分的文件迁移
  const dayFiles = fs
    .readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (dayFiles.length === 0) return;

  console.log(`📦 迁移 ${dayFiles.length} 个日期文件到按分类存储...`);

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const sectionsMap = new Map();
  let migratedCount = 0;

  for (const file of dayFiles) {
    const filePath = path.join(dataDir, file);
    const date = file.replace(".json", "");
    if (date < cutoff) {
      fs.unlinkSync(filePath);
      continue;
    }
    try {
      const dayData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!dayData.sections) {
        fs.unlinkSync(filePath);
        continue;
      }
      for (const sec of dayData.sections) {
        if (!sectionsMap.has(sec.title)) {
          sectionsMap.set(sec.title, {
            icon: sec.icon,
            title: sec.title,
            items: [],
          });
        }
        for (const item of sec.items) {
          sectionsMap.get(sec.title).items.push({ ...item, date });
          migratedCount++;
        }
      }
      fs.unlinkSync(filePath);
    } catch {}
  }

  const categoryMeta = [];
  for (const [title, sec] of sectionsMap) {
    sec.items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const catLimit = CATEGORY_ITEM_LIMITS[sec.title] || MAX_ITEMS_PER_CATEGORY;
    if (sec.items.length > catLimit) {
      sec.items = sec.items.slice(0, catLimit);
    }
    const catFile = path.join(dataDir, `${sanitizeFilename(title)}.json`);
    atomicWrite(
      catFile,
      JSON.stringify(
        {
          icon: sec.icon,
          title: sec.title,
          updatedAt: new Date().toISOString(),
          items: sec.items,
        },
        null,
        2,
      ),
    );
    categoryMeta.push({
      icon: sec.icon,
      title: sec.title,
      file: sanitizeFilename(title),
      count: sec.items.length,
    });
  }

  atomicWrite(
    path.join(dataDir, "meta.json"),
    JSON.stringify(
      {
        topic: topic.id,
        name: topic.name,
        icon: topic.icon,
        updatedAt: new Date().toISOString(),
        categories: categoryMeta,
      },
      null,
      2,
    ),
  );

  const oldIndex = path.join(dataDir, "index.json");
  if (fs.existsSync(oldIndex)) fs.unlinkSync(oldIndex);

  console.log(
    `✅ 迁移完成: ${migratedCount} 条记录 → ${categoryMeta.length} 个分类`,
  );
}

/**
 * 将标题按长度分桶，用于加速模糊去重
 * 核心思路：相似度阈值 SIMILARITY_THRESHOLD=0.75 下，
 * 若标题A长度L与标题B长度之比 < 0.75，相似度必然 < 阈值，可直接跳过
 */
function buildLengthBuckets(titles) {
  const buckets = new Map();
  for (const t of titles) {
    const len = t.length;
    if (!buckets.has(len)) buckets.set(len, []);
    buckets.get(len).push(t);
  }
  return buckets;
}

/**
 * 获取给定长度下可能匹配的候选标题（长度在 [L*T, L/T] 范围内）
 */
function getCandidates(buckets, normLen, threshold) {
  const candidates = [];
  const minLen = Math.max(1, Math.floor(normLen * threshold));
  const maxLen = Math.ceil(normLen / threshold);
  for (let len = minLen; len <= maxLen; len++) {
    const bucket = buckets.get(len);
    if (bucket) {
      for (const t of bucket) candidates.push(t);
    }
  }
  return candidates;
}

/**
 * 对当前批次进行去重（URL精确匹配 + 标题精确匹配 + 模糊匹配）
 * v2: 短标题（<10字符）使用更严格的匹配策略
 * @param {Array} items
 * @param {string[]} existingTitles - 历史标题
 * @returns {Array}
 */
function dedup(items, existingTitles = []) {
  const seenUrls = new Set();
  const seenNormsSet = new Set(); // O(1) 精确匹配
  const existingTitlesSet = new Set(existingTitles); // O(1) 历史精确匹配

  // 长度分桶：将历史标题按长度分组，避免 O(n²) 全量遍历
  const existingBuckets = buildLengthBuckets(existingTitles);
  // 当前批次的长度分桶（动态增长）
  const batchBuckets = new Map();

  return items.filter((item) => {
    // 1. URL 精确匹配（URL 相同一定重复）
    if (item.link) {
      if (seenUrls.has(item.link)) return false;
      seenUrls.add(item.link);
    }

    // 2. 标题标准化
    const raw = item.titleEN || item.title || "";
    const norm = normalizeTitle(raw).slice(0, 80);
    if (!norm) return true;

    // 3. 标题精确匹配（O(1)）
    if (seenNormsSet.has(norm)) return false;
    if (existingTitlesSet.has(norm)) return false;

    // 4. 短标题优化：对短标题使用更严格的匹配
    const isShortTitle = norm.length < SHORT_TITLE_LENGTH;

    // 5. 模糊匹配——历史数据（仅比较长度相近的候选）
    const nLen = norm.length;
    const histCandidates = getCandidates(existingBuckets, nLen, SIMILARITY_THRESHOLD);
    for (const et of histCandidates) {
      // 短标题使用严格模式
      if (similarity(norm, et, isShortTitle) >= SIMILARITY_THRESHOLD) return false;
    }

    // 6. 模糊匹配——当前批次（仅比较长度相近的候选）
    const batchCandidates = getCandidates(batchBuckets, nLen, SIMILARITY_THRESHOLD);
    for (const sn of batchCandidates) {
      // 短标题使用严格模式
      if (similarity(norm, sn, isShortTitle) >= SIMILARITY_THRESHOLD) return false;
    }

    // 7. 通过去重，加入当前批次分桶
    seenNormsSet.add(norm);
    if (!batchBuckets.has(nLen)) batchBuckets.set(nLen, []);
    batchBuckets.get(nLen).push(norm);
    return true;
  });
}

function groupByCategory(items, categories, defaultCat) {
  const processedCats = preprocessCategories(categories);
  const groups = {};
  for (const item of items) {
    const cat = classify(item, processedCats, defaultCat);
    const key = cat.title;
    if (!groups[key])
      groups[key] = { icon: cat.icon, title: cat.title, items: [] };
    groups[key].items.push({
      title: item.title,
      link: item.link || "",
      source: item.source || "",
      ...(item.titleEN ? { titleEN: item.titleEN } : {}),
    });
  }
  return Object.values(groups);
}

/**
 * 带置信度的分类分组
 * 返回 { sections, lowConfidenceItems }
 * lowConfidenceItems: 匹配关键词数 <=1 的条目，需要LLM二次验证
 */
function groupByCategoryWithConfidence(items, categories, defaultCat) {
  const processedCats = preprocessCategories(categories);
  const groups = {};
  const lowConfidenceItems = [];
  const LOW_CONFIDENCE_THRESHOLD = 1; // 匹配关键词数 <=1 视为低置信度

  for (const item of items) {
    const { category: cat, matchCount } = classifyWithConfidence(item, processedCats, defaultCat);
    const key = cat.title;
    if (!groups[key])
      groups[key] = { icon: cat.icon, title: cat.title, items: [] };

    const itemData = {
      title: item.title,
      link: item.link || "",
      source: item.source || "",
      ...(item.titleEN ? { titleEN: item.titleEN } : {}),
    };

    groups[key].items.push(itemData);

    // 低置信度条目（非默认分类，但匹配关键词很少）
    if (cat.title !== defaultCat.title && matchCount <= LOW_CONFIDENCE_THRESHOLD) {
      lowConfidenceItems.push({
        ...itemData,
        currentCategory: cat.title,
        matchCount,
      });
    }
  }

  return {
    sections: Object.values(groups),
    lowConfidenceItems,
  };
}

// ==================== 原子写入 ====================
function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, filePath);
}

// ===== P3-1: 语义去重（LLM 批量检测跨语言/改写重复）=====
async function semanticDedup(items, existingTitles) {
  if (items.length < 5 || !process.env.DEEPSEEK_API_KEY) return items;

  // v2：长度分桶生成候选对，避免 O(n²) 全量遍历
  const norms = items.map((i) => normalizeTitle(i.title).slice(0, 80));
  const SIM_DUP_THRESHOLD = 0.5;

  // 按长度分桶
  const lengthBuckets = new Map();
  for (let i = 0; i < items.length; i++) {
    const len = norms[i].length;
    if (!len) continue;
    if (!lengthBuckets.has(len)) lengthBuckets.set(len, []);
    lengthBuckets.get(len).push(i);
  }

  // 仅在同一长度范围内生成候选对
  const candidates = [];
  for (let i = 0; i < items.length; i++) {
    const len = norms[i].length;
    if (!len) continue;
    const minLen = Math.max(1, Math.floor(len * SIM_DUP_THRESHOLD));
    const maxLen = Math.ceil(len / SIM_DUP_THRESHOLD);
    for (let l = minLen; l <= maxLen; l++) {
      const bucket = lengthBuckets.get(l);
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        candidates.push([i, j]);
        if (candidates.length >= 200) break; // 足够多了就停止
      }
      if (candidates.length >= 200) break;
    }
    if (candidates.length >= 200) break;
  }

  if (candidates.length === 0) return items;

  // 批量检查（取前 100 对）
  const toCheck = candidates.slice(0, 100);
  const pairs = toCheck
    .map(
      ([i, j], idx) =>
        `${idx + 1}. A: ${items[i].title}\n   B: ${items[j].title}`,
    )
    .join("\n");

  const body = JSON.stringify({
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content:
          '你是去重引擎。判断每对新闻标题是否报道同一件事（语义重复）。输出JSON数组，每元素是{"n":序号,"dup":true/false}。中英文标题也可能重复。',
      },
      { role: "user", content: pairs },
    ],
    temperature: 0.1,
    max_tokens: 600,
  });

  try {
    const res = await new Promise((resolve) => {
      const req = https.request(
        {
          hostname: "api.deepseek.com",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            } catch {
              resolve({});
            }
          });
        },
      );
      req.on("error", () => resolve({}));
      req.on("timeout", () => {
        req.destroy();
        resolve({});
      });
      req.write(body);
      req.end();
    });

    const content = res?.choices?.[0]?.message?.content?.trim() || "";
    const jsonMatch = content.match(/\[.*\]/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const toRemove = new Set();
      for (const entry of parsed) {
        if (entry.dup && entry.n >= 1 && entry.n <= toCheck.length) {
          const [i, j] = toCheck[entry.n - 1];
          // 移除较短的标题（保留信息量更大的）
          toRemove.add(items[i].title.length < items[j].title.length ? i : j);
        }
      }
      if (toRemove.size > 0) {
        console.log(`  🔍 语义去重: 移除 ${toRemove.size} 条重复`);
        return items.filter((_, idx) => !toRemove.has(idx));
      }
    }
  } catch (e) {
    console.warn(`  ⚠️ 语义去重失败: ${e.message}`);
  }
  return items;
}

// ===== P2-1: LLM 辅助分类 =====
async function llmClassify(items, categoryTitles) {
  const result = new Map();
  const BATCH = 20;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return result;

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const numbered = batch.map((it, j) => `${j + 1}. ${it.title}`).join("\n");
    const cats = categoryTitles.join("、");
    const body = JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: `你是新闻分类引擎。将新闻标题分类到以下类别之一: ${cats}。如果都不匹配，输出"跳过"。输出JSON数组，每个元素是{"n":行号,"c":"类别名"}或{"n":行号,"c":"跳过"}。`,
        },
        { role: "user", content: numbered },
      ],
      temperature: 0.1,
      max_tokens: 800,
    });

    try {
      const res = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: "api.deepseek.com",
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
            timeout: 15000,
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
              } catch {
                resolve({});
              }
            });
          },
        );
        req.on("error", () => resolve({}));
        req.on("timeout", () => {
          req.destroy();
          resolve({});
        });
        req.write(body);
        req.end();
      });

      const content = res?.choices?.[0]?.message?.content?.trim() || "";
      // Extract JSON array from response
      const jsonMatch = content.match(/\[.*\]/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const entry of parsed) {
          if (
            entry.c &&
            entry.c !== "跳过" &&
            entry.n >= 1 &&
            entry.n <= batch.length
          ) {
            result.set(batch[entry.n - 1].title, entry.c);
          }
        }
      }
    } catch {}
    if (i + BATCH < items.length) await new Promise((r) => setTimeout(r, 500));
  }
  return result;
}

// ==================== 单主题处理 ====================
async function processTopic(topic) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`${topic.icon} 处理主题: ${topic.name}`);
  console.log("=".repeat(50));

  const dataDir = path.join(ROOT, topic.dataDir);

  // 0. 迁移旧数据（如需要）
  migrateToCategoryFiles(dataDir, topic);

  // 1. 抓取所有源
  const results = await Promise.allSettled(
    topic.sources.map((s) => fetchSource(s)),
  );

  const sourceLangMap = {};
  for (const s of topic.sources) sourceLangMap[s.name] = s.lang;

  let allRaw = [];
  let skippedCount = 0;
  results.forEach((r, i) => {
    const name = topic.sources[i].name;
    if (r.status === "fulfilled") {
      if (r.value.skipped) {
        skippedCount++;
        return;
      }
      console.log(`  ✅ ${name}: ${r.value.items.length} 条`);
      allRaw.push(...r.value.items);
      updateSourceHealth(name, true, r.value.items.length);
    } else {
      console.error(`  ❌ ${name}: ${r.reason.message}`);
      updateSourceHealth(name, false, 0, r.reason.message);
    }
  });

  if (skippedCount > 0) {
    console.log(`\n⏭️ 跳过 ${skippedCount}/${topic.sources.length} 个无更新的源`);
  }

  // 源健康报告
  const failedSources = results
    .map((r, i) => ({ name: topic.sources[i].name, result: r }))
    .filter(({ result }) => result.status === "rejected");
  if (failedSources.length > 0) {
    console.log(
      `\n⚠️ 源健康报告: ${failedSources.length}/${topic.sources.length} 个源失败:`,
    );
    failedSources.forEach(({ name, result }) =>
      console.log(`  ❌ ${name}: ${result.reason.message}`),
    );
  }

  // 连续失败告警
  const healthAlerts = checkSourceHealthAlerts();
  if (healthAlerts.length > 0) {
    console.log(`\n🚨 源连续失败告警 (>=${MAX_CONSECUTIVE_FAILURES}次):`);
    healthAlerts.forEach((a) =>
      console.log(`  ⚠️ ${a.name}: 连续失败 ${a.failures} 次, 最后错误: ${a.lastError}`),
    );
  }

  // 2. 加载历史数据用于去重
  console.log("🔍 加载历史数据进行去重...");
  const existingTitles = loadExistingTitles(dataDir);
  console.log(`  📦 已加载 ${existingTitles.length} 条历史标题`);

  // 3. 按语言分离
  const enItems = allRaw.filter((item) => sourceLangMap[item.source] === "en");
  const cnItems = allRaw.filter((item) => sourceLangMap[item.source] !== "en");

  // 指标：翻译统计
  let translateStats = { cached: 0, newTranslated: 0, failed: 0 };

  // 4. 中文条目：先去重（无需翻译）
  console.log(`📝 中文条目 ${cnItems.length} 条，进行模糊去重...`);
  const cnDeduped = dedup(cnItems, existingTitles);
  console.log(`  ✅ 中文去重后 ${cnDeduped.length} 条`);

  // 5. 英文条目：翻译后再去重
  let enDeduped = [];
  if (enItems.length > 0) {
    console.log(
      `🌐 翻译 ${enItems.length} 条英文新闻 (并发 ${TRANSLATE_CONCURRENCY})...`,
    );
    const translateResult = await translateItems(enItems);
    translateStats = translateResult.stats;
    console.log("📝 翻译完成，进行模糊去重...");
    enDeduped = dedup(translateResult.items, existingTitles);
    console.log(`  ✅ 英文去重后 ${enDeduped.length} 条`);
  }

  // 6. 合并去重后的条目
  let allItems = [...cnDeduped, ...enDeduped];

  // P3-1: 语义去重（检测跨语言/改写的重复）
  if (allItems.length > 5) {
    console.log("\n🔍 语义去重检查...");
    allItems = await semanticDedup(allItems, existingTitles);
  }

  if (allItems.length === 0) {
    console.log(`⚠️ ${topic.name}: 未获取到任何新闻，跳过`);
    return;
  }
  console.log(`✅ 去重后共 ${allItems.length} 条新闻`);

  // 7. 分类（带置信度检测）
  let sections;
  let lowConfidenceItems = [];
  if (process.env.DEEPSEEK_API_KEY) {
    // 使用带置信度的分类
    const result = groupByCategoryWithConfidence(
      allItems,
      topic.categories,
      topic.defaultCategory,
    );
    sections = result.sections;
    lowConfidenceItems = result.lowConfidenceItems;
  } else {
    // 无API Key时使用普通分类
    sections = groupByCategory(
      allItems,
      topic.categories,
      topic.defaultCategory,
    );
  }

  // P2-2: LLM 辅助分类 — 对"其他资讯"和低置信度条目做二次分类
  const defaultCatTitle = topic.defaultCategory?.title || "其他资讯";
  const allCatTitles = topic.categories.map((c) => c.title);

  // 收集需要LLM验证的条目
  const itemsToReclassify = [];

  // 1. "其他资讯"中的条目
  const otherSection = sections.find((s) => s.title === defaultCatTitle);
  if (otherSection && otherSection.items.length > 5) {
    itemsToReclassify.push(...otherSection.items.map((item) => ({
      ...item,
      sourceCategory: defaultCatTitle,
      reason: "default_category",
    })));
  }

  // 2. 低置信度条目（匹配关键词数 <=1）
  if (lowConfidenceItems.length > 0) {
    console.log(`  🔍 发现 ${lowConfidenceItems.length} 条低置信度分类条目`);
    itemsToReclassify.push(...lowConfidenceItems.map((item) => ({
      ...item,
      reason: "low_confidence",
    })));
  }

  // 执行LLM二次分类
  if (itemsToReclassify.length > 0 && process.env.DEEPSEEK_API_KEY) {
    console.log(
      `\n🤖 LLM 辅助分类: ${itemsToReclassify.length} 条待验证条目...`,
    );
    const reclassified = await llmClassify(itemsToReclassify, allCatTitles);
    if (reclassified.size > 0) {
      let movedCount = 0;
      // 处理重新分类结果
      for (const item of itemsToReclassify) {
        const newCat = reclassified.get(item.title);
        if (newCat && newCat !== item.sourceCategory) {
          // 从原分类移除
          if (item.sourceCategory) {
            const sourceSection = sections.find((s) => s.title === item.sourceCategory);
            if (sourceSection) {
              sourceSection.items = sourceSection.items.filter((i) => i.title !== item.title);
            }
          }
          // 添加到新分类
          const targetSection = sections.find((s) => s.title === newCat);
          if (targetSection) {
            targetSection.items.push({
              title: item.title,
              link: item.link || "",
              source: item.source || "",
              ...(item.titleEN ? { titleEN: item.titleEN } : {}),
            });
            movedCount++;
          }
        }
      }
      console.log(`  ✅ 已将 ${movedCount} 条重新分类`);
    }
  }

  // 8. 按分类写入独立文件（分片：recent + archive）
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const recentCutoffDate = new Date();
  recentCutoffDate.setDate(recentCutoffDate.getDate() - RECENT_DAYS);
  const recentCutoff = recentCutoffDate.toISOString().slice(0, 10);

  const categoryMeta = [];

  // #4: 并行读取所有分类的现有数据（16个分类 × 2文件 = 32次IO → 1次并发）
  // #11: 预计算 safeName map，避免循环内重复调用 sanitizeFilename
  const safeNameMap = new Map(sections.map((s) => [s.title, sanitizeFilename(s.title)]));
  const existingDataMap = new Map();
  const readTasks = sections.map(async (sec) => {
    const safeName = safeNameMap.get(sec.title);
    const catFile = path.join(dataDir, `${safeName}.json`);
    const archiveFile = path.join(dataDir, `${safeName}_archive.json`);
    let items = [];
    try {
      const existing = JSON.parse(await fsPromises.readFile(catFile, "utf-8"));
      items = existing.items || [];
    } catch {}
    try {
      const arch = JSON.parse(await fsPromises.readFile(archiveFile, "utf-8"));
      items = [...items, ...(arch.items || [])];
    } catch {}
    existingDataMap.set(safeName, items);
  });
  await Promise.all(readTasks);

  for (const sec of sections) {
    const safeName = safeNameMap.get(sec.title);
    const catFile = path.join(dataDir, `${safeName}.json`);
    const archiveFile = path.join(dataDir, `${safeName}_archive.json`);

    // 从预读缓存中取，不再同步读盘
    const existingItems = existingDataMap.get(safeName) || [];

    // 准备新条目
    const newItems = sec.items.map(({ titleEN, ...rest }) => ({
      ...rest,
      date: today,
    }));

    // P1-3: 增量追加 — 先对新条目去重，再追加到现有数据前面
    // 同时用有 link 的新条目回填旧条目的 link 字段
    const existingMap = new Map();
    for (const item of existingItems) {
      const norm = normalizeTitle(item.title).slice(0, 80);
      if (norm) existingMap.set(norm, item);
    }
    const trulyNew = [];
    let linkBackfilled = 0;
    for (const item of newItems) {
      const norm = normalizeTitle(item.title).slice(0, 80);
      if (!norm) continue;
      const existing = existingMap.get(norm);
      if (!existing) {
        trulyNew.push(item);
      } else if (!existing.link && item.link) {
        existing.link = item.link;
        linkBackfilled++;
      }
    }
    if (linkBackfilled > 0) {
      console.log(`  🔗 ${sec.title}: 回填 ${linkBackfilled} 条链接`);
    }
    if (trulyNew.length > 0) {
      console.log(`  ➕ ${sec.title}: 新增 ${trulyNew.length} 条`);
    }

    // 合并: 新条目在前 + 现有条目在后，清理过期
    const mergedItems = [...trulyNew, ...existingItems];
    const seenTitles = new Set();
    const filteredItems = mergedItems.filter((item) => {
      if ((item.date || today) < cutoff) return false;
      const norm = normalizeTitle(item.title).slice(0, 80);
      if (!norm) return true;
      if (seenTitles.has(norm)) return false;
      seenTitles.add(norm);
      return true;
    });
    const catLimit = CATEGORY_ITEM_LIMITS[sec.title] || MAX_ITEMS_PER_CATEGORY;
    const finalItems = filteredItems.slice(0, catLimit);
    const dedupeRemoved =
      mergedItems.filter((i) => (i.date || today) >= cutoff).length -
      filteredItems.length;
    if (dedupeRemoved > 0)
      console.log(`  🔄 ${sec.title}: 合并去重移除 ${dedupeRemoved} 条`);

    // 分片：recent（最近 RECENT_DAYS 天）+ archive（更早的）
    const recentItems = finalItems.filter(
      (item) => (item.date || today) >= recentCutoff,
    );
    const archiveItems = finalItems.filter(
      (item) => (item.date || today) < recentCutoff,
    );

    // P3: 按日期倒序排列，确保前端读取时无需重新排序
    recentItems.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    archiveItems.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    // 写入 recent（前端默认加载，小文件）
    atomicWrite(
      catFile,
      JSON.stringify(
        {
          icon: sec.icon,
          title: sec.title,
          updatedAt: new Date().toISOString(),
          items: recentItems,
        },
        null,
        2,
      ),
    );

    // 写入 archive（按需加载）
    if (archiveItems.length > 0) {
      atomicWrite(
        archiveFile,
        JSON.stringify(
          {
            icon: sec.icon,
            title: sec.title,
            updatedAt: new Date().toISOString(),
            items: archiveItems,
          },
          null,
          2,
        ),
      );
    } else if (fs.existsSync(archiveFile)) {
      fs.unlinkSync(archiveFile);
    }

    categoryMeta.push({
      icon: sec.icon,
      title: sec.title,
      file: safeName,
      count: recentItems.length,
      archiveCount: archiveItems.length,
    });
  }

  // 9. 处理没有新数据的现有分类（仍然需要清理过期数据）
  const existingCatFiles = fs
    .readdirSync(dataDir)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        f !== "meta.json" &&
        f !== "data.json" &&
        f !== "index.json" &&
        f !== "titles-index.json" &&
        f !== "latest.json" &&
        !f.endsWith("_archive.json") &&
        !/^\d{4}-\d{2}-\d{2}\.json$/.test(f),
    );

  for (const file of existingCatFiles) {
    const catTitle = file.replace(".json", "");
    if (categoryMeta.find((c) => sanitizeFilename(c.title) === catTitle))
      continue;

    try {
      const catData = JSON.parse(
        fs.readFileSync(path.join(dataDir, file), "utf-8"),
      );

      // 清理过期数据
      catData.items = catData.items.filter(
        (item) => (item.date || today) >= cutoff,
      );
      if (catData.items.length > MAX_ITEMS_PER_CATEGORY) {
        catData.items = catData.items.slice(0, MAX_ITEMS_PER_CATEGORY);
      }

      catData.updatedAt = new Date().toISOString();
      atomicWrite(path.join(dataDir, file), JSON.stringify(catData, null, 2));

      categoryMeta.push({
        icon: catData.icon,
        title: catData.title,
        file: sanitizeFilename(catData.title),
        count: catData.items.length,
        archiveCount: 0,
      });
    } catch {}
  }

  // 10. 写入 meta.json
  atomicWrite(
    path.join(dataDir, "meta.json"),
    JSON.stringify(
      {
        topic: topic.id,
        name: topic.name,
        icon: topic.icon,
        updatedAt: new Date().toISOString(),
        categories: categoryMeta,
      },
      null,
      2,
    ),
  );

  // 10.5 生成 latest.json（首页快速加载用）
  // 从已写入的分类文件读取合并后的数据，而非预合并的 sections
  const LATEST_ITEMS = 100;
  const latestAll = [];
  for (const cat of categoryMeta) {
    try {
      const catPath = path.join(dataDir, `${cat.file}.json`);
      const catData = JSON.parse(fs.readFileSync(catPath, "utf-8"));
      for (const item of catData.items || []) {
        latestAll.push({
          title: item.title,
          source: item.source || "",
          date: item.date || today,
          category: cat.title,
        });
      }
    } catch {}
  }
  // 按日期倒序，取最新 N 条
  latestAll.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const latestItems = latestAll.slice(0, LATEST_ITEMS);

  atomicWrite(
    path.join(dataDir, "latest.json"),
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        items: latestItems,
      },
      null,
      2,
    ),
  );
  console.log(`⚡ 已生成 latest.json: ${latestItems.length} 条`);

  // 11. 清理旧格式文件
  const oldDataFile = path.join(dataDir, "data.json");
  if (fs.existsSync(oldDataFile)) fs.unlinkSync(oldDataFile);
  const oldIndex = path.join(dataDir, "index.json");
  if (fs.existsSync(oldIndex)) fs.unlinkSync(oldIndex);
  const oldDayFiles = fs
    .readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const old of oldDayFiles) {
    fs.unlinkSync(path.join(dataDir, old));
  }

  // 12. 保存标题索引（下次运行无需遍历所有分类文件）
  const allTitles = new Set();
  for (const cat of categoryMeta) {
    try {
      const catPath = path.join(dataDir, `${cat.file}.json`);
      const catData = JSON.parse(fs.readFileSync(catPath, "utf-8"));
      for (const item of catData.items || []) {
        const norm = normalizeTitle(item.title).slice(0, 80);
        if (norm) allTitles.add(norm);
      }
    } catch {}
    if (cat.archiveCount > 0) {
      try {
        const archPath = path.join(dataDir, `${cat.file}_archive.json`);
        const archData = JSON.parse(fs.readFileSync(archPath, "utf-8"));
        for (const item of archData.items || []) {
          const norm = normalizeTitle(item.title).slice(0, 80);
          if (norm) allTitles.add(norm);
        }
      } catch {}
    }
  }
  saveTitlesIndex(dataDir, [...allTitles]);
  console.log(`  📦 已保存 titles-index: ${allTitles.size} 条`);

  const totalItems = categoryMeta.reduce((sum, cat) => sum + cat.count, 0);
  console.log(
    `📂 已更新 ${topic.dataDir}/ (${categoryMeta.length} 个分类, ${totalItems} 条)`,
  );

  // 记录主题指标
  const succeededSources = results.filter((r) => r.status === "fulfilled" && !r.value.skipped).length;
  const failedSourcesCount = results.filter((r) => r.status === "rejected").length;
  recordTopicMetrics(topic.name, {
    sourcesAttempted: topic.sources.length,
    sourcesSucceeded: succeededSources,
    sourcesFailed: failedSourcesCount,
    sourcesSkipped: skippedCount,
    itemsFetched: allRaw.length,
    itemsDeduped: allRaw.length - allItems.length,
    itemsFinal: totalItems,
    translateCached: translateStats.cached,
    translateNew: translateStats.newTranslated,
    translateFailed: translateStats.failed,
    categories: categoryMeta.length,
  });
}

// ==================== 主逻辑 ====================
async function main() {
  console.log("🚀 通用新闻聚合引擎 v6.0");
  console.log(
    `⏰ ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
  );

  loadCache();
  loadSourceHealth();
  loadEtagData();
  startMetrics();

  let topics;
  try {
    topics = JSON.parse(fs.readFileSync(TOPICS_FILE, "utf-8"));
  } catch (e) {
    console.error("❌ 无法读取 topics.json:", e.message);
    process.exit(1);
  }

  // 按 --topic 参数过滤
  if (FILTER_TOPIC) {
    topics = topics.filter((t) => t.id === FILTER_TOPIC);
    if (topics.length === 0) {
      console.error(
        `❌ 未找到主题: ${FILTER_TOPIC}（可用: ${JSON.stringify(topics.map((t) => t.id))}）`,
      );
      process.exit(1);
    }
    console.log(`🎯 仅更新主题: ${FILTER_TOPIC}`);
  } else {
    console.log(
      `📋 共 ${topics.length} 个主题: ${topics.map((t) => t.name).join(", ")}`,
    );
  }

  for (const topic of topics) {
    await processTopic(topic);
  }

  saveCache();
  saveSourceHealth();
  saveEtagData();
  finishMetrics();
  saveMetrics();
  console.log("\n✅ 全部完成！");
}

main().catch((e) => {
  console.error("❌ 更新失败:", e);
  process.exit(1);
});
