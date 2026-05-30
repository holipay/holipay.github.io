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

const fs = require("fs");
const path = require("path");
const { isEnglish, similarity, SHORT_TITLE_LENGTH } = require("./shared.js");
const { fetchUrl, fetchWithRetry, apiCall, DEFAULT_RETRIES } = require("./lib/http.js");
const { loadCache: _loadCache, saveCache: _saveCache, translateItems, cacheKey } = require("./lib/translation.js");
const { normalizeTitle, dedup, semanticDedup, loadExistingTitles } = require("./lib/dedup.js");
const { atomicWrite, sanitizeFilename, migrateToCategoryFiles, writeCategoryFiles, cleanOldCategories, generateMetaJson, generateLatestJson, cleanupOldFiles, saveTitlesIndex, collectAllTitles } = require("./lib/storage.js");
const { getParser } = require("./lib/parsers.js");
const { classifyItems } = require("./lib/classify.js");

const ROOT = path.resolve(__dirname, "../..");
const SCRIPTS_DIR = __dirname;
const TOPICS_FILE = path.join(SCRIPTS_DIR, "topics.json");
const HEALTH_FILE = path.join(SCRIPTS_DIR, "source-health.json");
const METRICS_FILE = path.join(SCRIPTS_DIR, "run-metrics.json");
const ETAG_FILE = path.join(SCRIPTS_DIR, "source-etag.json");
const RETENTION_DAYS = 30;
const MAX_ITEMS_PER_CATEGORY = 40;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_METRICS_HISTORY = 30;

// 社科类分类条数限制（降低权重）
const CATEGORY_ITEM_LIMITS = {
  心理学与认知: 30,
  教育与媒体: 30,
  环境与能源: 20,
  法律与伦理: 20,
};

const RECENT_DAYS = 7;

// 超时配置（按源类型，作为默认值）
const TIMEOUT_CONFIG = {
  rss: 20000,
  api: 15000,
  default: 15000
};

// ==================== 命令行参数 ====================
const FILTER_TOPIC =
  process.argv.find((a) => a.startsWith("--topic="))?.split("=")[1] || null;

// ==================== 翻译缓存 ====================
function loadCache() {
  _loadCache(RETENTION_DAYS);
}

function saveCache() {
  _saveCache(RETENTION_DAYS, { compact: true });
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
  const loaded = require("./lib/storage.js").loadJson(ETAG_FILE);
  if (loaded) {
    etagData = loaded;
    const count = Object.keys(etagData).length;
    if (count > 0) console.log(`🔖 加载 ETag 缓存: ${count} 个源`);
  }
}

function saveEtagData() {
  require("./lib/storage.js").saveJson(ETAG_FILE, etagData, { compact: true });
  console.log(`💾 保存 ETag 缓存: ${Object.keys(etagData).length} 个源`);
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

// ==================== 通用源抓取 ====================
async function fetchSource(source) {
  let items = [];

  // 确定超时时间：源配置 > 源类型默认 > 全局默认
  const timeout = source.timeout 
    || TIMEOUT_CONFIG[source.type] 
    || TIMEOUT_CONFIG.default;

  const parser = getParser(source);
  if (!parser) {
    console.error(`  ❌ ${source.name}: 未知源类型 "${source.type}"${source.parse ? "/" + source.parse : ""}`);
    return { items: [], skipped: false };
  }

  try {
    // RSS 源：增量抓取（ETag/Last-Modified 条件请求）
    const isRss = source.type === "rss";
    let fetchOptions = {};
    if (isRss) {
      const cached = etagData[source.name];
      if (cached) {
        fetchOptions.conditionalHeaders = {
          ...(cached.etag ? { "If-None-Match": cached.etag } : {}),
          ...(cached.lastModified ? { "If-Modified-Since": cached.lastModified } : {}),
        };
      }
    }

    const result = await fetchWithRetry(source.url, DEFAULT_RETRIES, timeout, fetchOptions);

    // 304 Not Modified — 源无更新，跳过
    if (result && result.notModified) {
      return { items: [], skipped: true };
    }

    // 有更新 — 保存新的 etag（仅 RSS）
    if (isRss && result && typeof result === "object" && result.etag !== undefined) {
      updateEtag(source.name, { etag: result.etag, "last-modified": result.lastModified });
    }

    const rawContent = typeof result === "string" ? result : result.body;
    const parsed = parser(source, rawContent);
    parsed.forEach((item) => items.push({ ...item, source: source.name }));
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

// ==================== 单主题处理 ====================
async function processTopic(topic) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`${topic.icon} 处理主题: ${topic.name}`);
  console.log("=".repeat(50));

  const dataDir = path.join(ROOT, topic.dataDir);

  // Phase 1: 迁移旧数据
  migrateToCategoryFiles(dataDir, topic, {
    retentionDays: RETENTION_DAYS,
    categoryItemLimits: CATEGORY_ITEM_LIMITS,
  });

  // Phase 2: 抓取所有源
  const { allRaw, skippedCount, results } = await fetchAllSources(topic);

  // Phase 3: 翻译 + 去重
  const { allItems, translateStats } = await translateAndDedup(allRaw, topic, dataDir);

  if (allItems.length === 0) {
    console.log(`⚠️ ${topic.name}: 未获取到任何新闻，跳过`);
    return;
  }

  // Phase 4: 分类
  const sections = await classifyItems(allItems, topic);

  // Phase 5: 写入数据文件
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const recentCutoffDate = new Date();
  recentCutoffDate.setDate(recentCutoffDate.getDate() - RECENT_DAYS);
  const recentCutoff = recentCutoffDate.toISOString().slice(0, 10);

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const categoryMeta = await writeCategoryFiles(dataDir, sections, {
    today, cutoff, recentCutoff,
    categoryItemLimits: CATEGORY_ITEM_LIMITS,
    maxItems: MAX_ITEMS_PER_CATEGORY,
    normalizeTitle,
  });

  cleanOldCategories(dataDir, categoryMeta, {
    today, cutoff, maxItems: MAX_ITEMS_PER_CATEGORY,
  });

  generateMetaJson(dataDir, topic, categoryMeta);
  generateLatestJson(dataDir, categoryMeta, today);
  cleanupOldFiles(dataDir);

  // Phase 6: 保存标题索引
  const allTitles = collectAllTitles(dataDir, categoryMeta, normalizeTitle);
  saveTitlesIndex(dataDir, [...allTitles]);
  console.log(`  📦 已保存 titles-index: ${allTitles.size} 条`);

  const totalItems = categoryMeta.reduce((sum, cat) => sum + cat.count, 0);
  console.log(`📂 已更新 ${topic.dataDir}/ (${categoryMeta.length} 个分类, ${totalItems} 条)`);

  // Phase 7: 记录指标
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

async function fetchAllSources(topic) {
  const results = await Promise.allSettled(
    topic.sources.map((s) => fetchSource(s)),
  );

  const allRaw = [];
  let skippedCount = 0;

  results.forEach((r, i) => {
    const name = topic.sources[i].name;
    if (r.status === "fulfilled") {
      if (r.value.skipped) { skippedCount++; return; }
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

  const failedSources = results
    .map((r, i) => ({ name: topic.sources[i].name, result: r }))
    .filter(({ result }) => result.status === "rejected");
  if (failedSources.length > 0) {
    console.log(`\n⚠️ 源健康报告: ${failedSources.length}/${topic.sources.length} 个源失败:`);
    failedSources.forEach(({ name, result }) =>
      console.log(`  ❌ ${name}: ${result.reason.message}`),
    );
  }

  const healthAlerts = checkSourceHealthAlerts();
  if (healthAlerts.length > 0) {
    console.log(`\n🚨 源连续失败告警 (>=${MAX_CONSECUTIVE_FAILURES}次):`);
    healthAlerts.forEach((a) =>
      console.log(`  ⚠️ ${a.name}: 连续失败 ${a.failures} 次, 最后错误: ${a.lastError}`),
    );
  }

  return { allRaw, skippedCount, results };
}

async function translateAndDedup(allRaw, topic, dataDir) {
  const sourceLangMap = {};
  for (const s of topic.sources) sourceLangMap[s.name] = s.lang;

  console.log("🔍 加载历史数据进行去重...");
  const existingTitles = loadExistingTitles(dataDir);
  console.log(`  📦 已加载 ${existingTitles.length} 条历史标题`);

  const enItems = allRaw.filter((item) => sourceLangMap[item.source] === "en");
  const cnItems = allRaw.filter((item) => sourceLangMap[item.source] !== "en");

  let translateStats = { cached: 0, newTranslated: 0, failed: 0 };

  console.log(`📝 中文条目 ${cnItems.length} 条，进行模糊去重...`);
  const cnDeduped = dedup(cnItems, existingTitles);
  console.log(`  ✅ 中文去重后 ${cnDeduped.length} 条`);

  let enDeduped = [];
  if (enItems.length > 0) {
    console.log(`🌐 翻译 ${enItems.length} 条英文新闻...`);
    const translateResult = await translateItems(enItems);
    translateStats = translateResult.stats;
    console.log("📝 翻译完成，进行模糊去重...");
    enDeduped = dedup(translateResult.items, existingTitles);
    console.log(`  ✅ 英文去重后 ${enDeduped.length} 条`);
  }

  let allItems = [...cnDeduped, ...enDeduped];

  if (allItems.length > 5) {
    console.log("\n🔍 语义去重检查...");
    allItems = await semanticDedup(allItems, existingTitles);
  }

  console.log(`✅ 去重后共 ${allItems.length} 条新闻`);
  return { allItems, translateStats };
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
