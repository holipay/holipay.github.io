/**
 * 去重模块 — URL精确匹配 + 标题标准化 + 模糊匹配 + 语义去重
 * 从 update-news.js 和 analyze.js 提取，消除重复代码
 */

const fs = require("fs");
const path = require("path");
const { similarity, SHORT_TITLE_LENGTH } = require("../shared.js");
const { apiCall } = require("./http.js");

const SIMILARITY_THRESHOLD = 0.75;

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

function buildLengthBuckets(titles) {
  const buckets = new Map();
  for (const t of titles) {
    const len = t.length;
    if (!buckets.has(len)) buckets.set(len, []);
    buckets.get(len).push(t);
  }
  return buckets;
}

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

function dedup(items, existingTitles = []) {
  const seenUrls = new Set();
  const seenNormsSet = new Set();
  const existingTitlesSet = new Set(existingTitles);

  const existingBuckets = buildLengthBuckets(existingTitles);
  const batchBuckets = new Map();

  return items.filter((item) => {
    if (item.link) {
      if (seenUrls.has(item.link)) return false;
      seenUrls.add(item.link);
    }

    const raw = item.titleEN || item.title || "";
    const norm = normalizeTitle(raw).slice(0, 80);
    if (!norm) return true;

    if (seenNormsSet.has(norm)) return false;
    if (existingTitlesSet.has(norm)) return false;

    const isShortTitle = norm.length < SHORT_TITLE_LENGTH;
    const nLen = norm.length;

    const histCandidates = getCandidates(existingBuckets, nLen, SIMILARITY_THRESHOLD);
    for (const et of histCandidates) {
      if (similarity(norm, et, isShortTitle) >= SIMILARITY_THRESHOLD) return false;
    }

    const batchCandidates = getCandidates(batchBuckets, nLen, SIMILARITY_THRESHOLD);
    for (const sn of batchCandidates) {
      if (similarity(norm, sn, isShortTitle) >= SIMILARITY_THRESHOLD) return false;
    }

    seenNormsSet.add(norm);
    if (!batchBuckets.has(nLen)) batchBuckets.set(nLen, []);
    batchBuckets.get(nLen).push(norm);
    return true;
  });
}

async function semanticDedup(items, existingTitles) {
  if (items.length < 5 || !process.env.DEEPSEEK_API_KEY) return items;

  const norms = items.map((i) => normalizeTitle(i.title).slice(0, 80));
  const SIM_DUP_THRESHOLD = 0.5;

  const lengthBuckets = new Map();
  for (let i = 0; i < items.length; i++) {
    const len = norms[i].length;
    if (!len) continue;
    if (!lengthBuckets.has(len)) lengthBuckets.set(len, []);
    lengthBuckets.get(len).push(i);
  }

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
        if (candidates.length >= 200) break;
      }
      if (candidates.length >= 200) break;
    }
    if (candidates.length >= 200) break;
  }

  if (candidates.length === 0) return items;

  const toCheck = candidates.slice(0, 100);
  const pairs = toCheck
    .map(([i, j], idx) => `${idx + 1}. A: ${items[i].title}\n   B: ${items[j].title}`)
    .join("\n");

  try {
    const res = await apiCall(
      "https://api.deepseek.com/v1/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: '你是去重引擎。判断每对新闻标题是否报道同一件事（语义重复）。输出JSON数组，每元素是{"n":序号,"dup":true/false}。中英文标题也可能重复。',
          },
          { role: "user", content: pairs },
        ],
        temperature: 0.1,
        max_tokens: 600,
      },
      {
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        timeout: 15000,
      },
    );

    const content = res?.choices?.[0]?.message?.content?.trim() || "";
    const jsonMatch = content.match(/\[.*\]/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const toRemove = new Set();
      for (const entry of parsed) {
        if (entry.dup && entry.n >= 1 && entry.n <= toCheck.length) {
          const [i, j] = toCheck[entry.n - 1];
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

function loadExistingTitles(dataDir) {
  const indexPath = path.join(dataDir, "titles-index.json");

  try {
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      if (Array.isArray(index.titles)) {
        console.log(`  📦 从 titles-index 加载 ${index.titles.length} 条历史标题`);
        return index.titles;
      }
    }
  } catch {}

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
        const catData = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf-8"));
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

module.exports = {
  normalizeTitle,
  buildLengthBuckets,
  getCandidates,
  dedup,
  semanticDedup,
  loadExistingTitles,
  SIMILARITY_THRESHOLD,
};
