/**
 * 翻译管线 — 缓存 + MyMemory/Google/DeepSeek 链式调用
 * 从 update-news.js 和 analyze.js 提取，消除重复代码
 */

const fs = require("fs");
const path = require("path");
const { fetchWithRetry, apiCall } = require("./http.js");
const { isEnglish } = require("../shared.js");

const SCRIPTS_DIR = path.resolve(__dirname, "..");
const CACHE_FILE = path.join(SCRIPTS_DIR, "translations-cache.json");
const MAX_CACHE_SIZE = 3000;

let translationCache = {};
let _cacheDirty = false;

// ===== 自适应限流 =====
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
    config.current = Math.min(config.current + config.step * 2, config.max);
    console.log(`    ⚠️ ${provider} 被限流，延迟调整为 ${config.current}ms`);
  } else if (success) {
    config.current = Math.max(config.current - config.step, config.base);
  }
}

function getRateLimitDelay(provider) {
  return RATE_LIMIT_CONFIG[provider]?.current || 200;
}

// ===== 缓存管理 =====
function cacheKey(text) {
  const t = text.trim();
  if (t.length <= 80) return t.toLowerCase();
  return (t.slice(0, 80) + t.slice(-20)).toLowerCase();
}

function loadCache(retentionDays = 30) {
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

function saveCache(retentionDays = 30, { compact = true } = {}) {
  if (!_cacheDirty) {
    console.log(`📦 翻译缓存未变更，跳过保存`);
    return;
  }
  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const [key, entry] of Object.entries(translationCache)) {
      if (entry.ts && entry.ts < cutoff) delete translationCache[key];
    }

    const entries = Object.entries(translationCache);
    if (entries.length > MAX_CACHE_SIZE) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      const evictCount = entries.length - MAX_CACHE_SIZE;
      const toKeep = entries.slice(0, MAX_CACHE_SIZE);
      translationCache = Object.fromEntries(toKeep);
      console.log(`🗑️ 翻译缓存淘汰 ${evictCount} 条旧数据，保留 ${MAX_CACHE_SIZE} 条`);
    }

    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(translationCache, compact ? null : undefined, compact ? undefined : 2), "utf-8");
    fs.renameSync(tmp, CACHE_FILE);
    console.log(`💾 保存翻译缓存: ${Object.keys(translationCache).length} 条`);
    _cacheDirty = false;
  } catch (e) {
    console.error("⚠️ 缓存保存失败:", e.message);
  }
}

function getTranslation(text) {
  const key = cacheKey(text);
  return translationCache[key]?.zh || null;
}

function setTranslation(text, translated) {
  translationCache[cacheKey(text)] = { zh: translated, ts: Date.now() };
  _cacheDirty = true;
}

// ===== 翻译 API =====
async function translateMyMemory(text) {
  const encoded = encodeURIComponent(text.slice(0, 450));
  const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|zh-CN`;
  const json = await fetchWithRetry(url, 2, 15000, {
    onRateLimit: (u) => {
      if (u.includes("mymemory")) adjustRateLimit("myMemory", false, true);
    },
  });
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
  const json = await fetchWithRetry(url, 2, 15000, {
    onRateLimit: (u) => {
      if (u.includes("googleapis")) adjustRateLimit("google", false, true);
    },
  });
  const data = JSON.parse(json);
  if (data && data[0]) {
    return data[0].map((s) => s[0]).join("");
  }
  return null;
}

async function translateDeepSeek(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await apiCall(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "你是翻译引擎。将用户输入的英文翻译为中文，只输出翻译结果，不加任何解释、引号或标点符号。如果输入已是中文，直接原样输出。",
          },
          { role: "user", content: text.slice(0, 500) },
        ],
        temperature: 0.1,
        max_tokens: 200,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      },
    );
    const result = res?.choices?.[0]?.message?.content?.trim();
    if (result && result.toLowerCase() !== text.toLowerCase()) return result;
    return null;
  } catch {
    return null;
  }
}

const BATCH_SIZE = 15;

async function translateBatchDeepSeek(texts) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || texts.length === 0) return new Map();

  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");

  try {
    const res = await apiCall(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "你是翻译引擎。将用户输入的英文新闻标题逐行翻译为中文。保持相同的行数和顺序，每行只输出翻译结果，不加编号、引号或解释。如果某行已是中文，原样输出。",
          },
          { role: "user", content: numbered },
        ],
        temperature: 0.1,
        max_tokens: Math.max(800, texts.length * 80),
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 30000,
      },
    );

    const content = res?.choices?.[0]?.message?.content?.trim() || "";
    const lines = content.split("\n").map((l) => l.replace(/^\d+\.\s*/, "").trim());
    const result = new Map();
    for (let i = 0; i < texts.length; i++) {
      const translated = lines[i] || "";
      if (translated && translated.toLowerCase() !== texts[i].toLowerCase()) {
        result.set(texts[i], translated);
        setTranslation(texts[i], translated);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

// ===== 翻译链 =====
async function translateENtoZH(text) {
  const cached = getTranslation(text);
  if (cached) return cached;

  let translated = null;

  try {
    translated = await translateMyMemory(text);
  } catch {}

  if (!translated) {
    try {
      await new Promise((r) => setTimeout(r, getRateLimitDelay("google")));
      translated = await translateGoogle(text);
    } catch {}
  }

  if (!translated) {
    try {
      await new Promise((r) => setTimeout(r, getRateLimitDelay("deepseek")));
      translated = await translateDeepSeek(text);
      if (translated) console.log(`    🤖 DeepSeek 翻译兜底: "${text.slice(0, 40)}..."`);
    } catch {}
  }

  if (translated) {
    setTranslation(text, translated);
    return translated;
  }
  return text;
}

// ===== 批量翻译编排 =====
async function translateItems(items) {
  const results = [];
  let cached = 0;
  let newTranslated = 0;
  let failed = 0;

  const enItems = [];
  const nonEnItems = [];
  for (const item of items) {
    if (isEnglish(item.title)) {
      const existing = getTranslation(item.title);
      if (existing) {
        cached++;
        results.push({ ...item, title: existing, titleEN: item.title });
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

  const texts = enItems.map((i) => i.title);
  console.log(`🌐 批量翻译 ${texts.length} 条 (每批 ${BATCH_SIZE} 条)...`);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(texts.length / BATCH_SIZE);
    console.log(`  📦 批次 ${batchNum}/${totalBatches} (${batch.length} 条)...`);

    let translated;
    try {
      translated = await translateBatchDeepSeek(batch);
      newTranslated += translated.size;
    } catch (e) {
      console.warn(`  ⚠️ 批量翻译失败: ${e.message}，回退到逐条翻译`);
      translated = new Map();
    }

    for (let j = 0; j < batch.length; j++) {
      const item = enItems[i + j];
      const zh = translated.get(batch[j]);
      if (zh) {
        results.push({ ...item, title: zh, titleEN: item.title });
      } else {
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

    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, getRateLimitDelay("batch")));
    }
  }

  console.log(`📊 翻译统计: ${cached} 缓存, ${newTranslated} 新翻译, ${failed} 失败`);
  return { items: results, stats: { cached, newTranslated, failed } };
}

// ===== analyze.js 摘要翻译 =====
const SNIPPET_BATCH_SIZE = 3;

async function translateSnippet(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || !text) return null;
  try {
    const res = await apiCall(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "你是翻译引擎。将用户输入的英文新闻摘要翻译为流畅的中文。保持原文段落结构，只输出翻译结果，不加编号、引号或解释。如果已是中文，原样输出。",
          },
          { role: "user", content: text },
        ],
        temperature: 0.1,
        max_tokens: Math.max(800, Math.ceil(text.length * 1.5)),
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 30000,
      },
    );
    const translated = res?.choices?.[0]?.message?.content?.trim();
    if (translated && translated !== text) return translated;
    return null;
  } catch (e) {
    console.error(`⚠️ 摘要翻译失败: ${e.message}`);
    return null;
  }
}

async function translateSnippets(items) {
  const enItems = items.filter((item) => item.snippet && isEnglish(item.snippet));
  if (enItems.length === 0) {
    console.log("📊 摘要翻译: 无需翻译（全部为中文或无内容）");
    return;
  }

  console.log(`🌐 翻译 ${enItems.length} 篇英文摘要...`);
  let cached = 0;
  let translated = 0;
  let failed = 0;

  for (let i = 0; i < enItems.length; i += SNIPPET_BATCH_SIZE) {
    const batch = enItems.slice(i, i + SNIPPET_BATCH_SIZE);
    const batchNum = Math.floor(i / SNIPPET_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(enItems.length / SNIPPET_BATCH_SIZE);
    console.log(`  📦 批次 ${batchNum}/${totalBatches} (${batch.length} 篇)...`);

    for (const item of batch) {
      const cachedZh = getTranslation(item.snippet);
      if (cachedZh) {
        item.snippetEN = item.snippet;
        item.snippet = cachedZh;
        cached++;
        continue;
      }

      const zh = await translateSnippet(item.snippet);
      if (zh) {
        item.snippetEN = item.snippet;
        item.snippet = zh;
        setTranslation(item.snippet, zh);
        translated++;
      } else {
        failed++;
      }
    }

    if (i + SNIPPET_BATCH_SIZE < enItems.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  console.log(`📊 摘要翻译统计: ${cached} 缓存, ${translated} 新翻译, ${failed} 失败`);
}

module.exports = {
  cacheKey,
  loadCache,
  saveCache,
  getTranslation,
  setTranslation,
  adjustRateLimit,
  getRateLimitDelay,
  translateMyMemory,
  translateGoogle,
  translateDeepSeek,
  translateBatchDeepSeek,
  translateENtoZH,
  translateItems,
  translateSnippet,
  translateSnippets,
  BATCH_SIZE,
  SNIPPET_BATCH_SIZE,
  CACHE_FILE,
  MAX_CACHE_SIZE,
};
