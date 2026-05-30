/**
 * 热词提取、评分、去重
 * 从 analyze.js 提取
 * 配置已外置到 configs/ 目录
 */

const fs = require("fs");
const path = require("path");
const { similarity } = require("./shared.js");
const { DATA_DIR } = require("./date-utils.js");

const CONFIGS_DIR = path.join(__dirname, "..", "configs");

// ===== 配置加载函数 =====
function loadJsonConfig(filename, fallback = {}) {
  try {
    const filePath = path.join(CONFIGS_DIR, filename);
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.warn(`⚠️ 无法加载配置文件 ${filename}: ${e.message}`);
    return fallback;
  }
}

function loadArrayConfig(filename) {
  const config = loadJsonConfig(filename, {});
  // 合并所有数组字段
  const result = [];
  for (const key of Object.keys(config)) {
    if (key.startsWith("_")) continue; // 跳过注释字段
    if (Array.isArray(config[key])) {
      result.push(...config[key]);
    }
  }
  return result;
}

// ===== 加载配置 =====

// 信源权重
const sourceWeightsConfig = loadJsonConfig("source-weights.json", { weights: {} });
const SOURCE_WEIGHTS_FALLBACK = sourceWeightsConfig.weights || {
  default: 1.0,
};

function loadSourceWeights() {
  const weights = { ...SOURCE_WEIGHTS_FALLBACK };
  try {
    const topicsFile = path.join(__dirname, "..", "topics.json");
    const topics = JSON.parse(fs.readFileSync(topicsFile, "utf-8"));
    for (const topic of topics) {
      for (const source of topic.sources || []) {
        if (source.weight) weights[source.name] = source.weight;
      }
    }
  } catch (e) {
    console.warn(`⚠️ 无法从 topics.json 加载信源权重: ${e.message}`);
  }
  return weights;
}

const SOURCE_WEIGHTS = loadSourceWeights();

// 噪音关键词黑名单
const noiseKeywordsList = loadArrayConfig("noise-keywords.json");
const NOISE_KEYWORDS = new Set(noiseKeywordsList);

// 领域关键词白名单
const domainKeywordsList = loadArrayConfig("domain-keywords.json");
const DOMAIN_KEYWORDS = new Set(domainKeywordsList);

// 停用词
const stopwordsConfig = loadJsonConfig("stopwords.json", { chinese: [], english: [] });
const CN_STOPWORDS = new Set(stopwordsConfig.chinese || []);
const EN_STOPWORDS = new Set(stopwordsConfig.english || []);

// 关键词前缀
const prefixesConfig = loadJsonConfig("keyword-prefixes.json", { prefixes: [] });
const CN_KEYWORD_PREFIXES = prefixesConfig.prefixes || [];

function stripCNPrefix(word) {
  for (const prefix of CN_KEYWORD_PREFIXES) {
    if (word.startsWith(prefix) && word.length > prefix.length) {
      return word.slice(prefix.length);
    }
  }
  return word;
}

// 按长度降序预排序（最长匹配优先）
const CN_DOMAIN_SORTED = [...DOMAIN_KEYWORDS]
  .filter((k) => /[\u4e00-\u9fff]/.test(k))
  .sort((a, b) => b.length - a.length);
const EN_DOMAIN_SORTED = [...DOMAIN_KEYWORDS]
  .filter((k) => /^[a-zA-Z\s]+$/.test(k))
  .map((k) => k.toLowerCase())
  .sort((a, b) => b.length - a.length);
const DOMAIN_KEYWORDS_LOWER = new Set([...DOMAIN_KEYWORDS].map((k) => k.toLowerCase()));

function extractKeywordsFromTitle(title) {
  const keywords = [];
  const keywordSet = new Set();
  const lower = title.toLowerCase();

  // ── 中文关键词提取 ──
  // 直接扫描标题中是否包含白名单关键词（最长匹配优先）
  const cnSorted = CN_DOMAIN_SORTED;
  const cnUsed = new Set(); // 避免重叠区域重复匹配
  for (const dk of cnSorted) {
    let idx = lower.indexOf(dk);
    while (idx !== -1) {
      // 检查该位置是否已被更长的关键词占用
      let overlap = false;
      for (let k = idx; k < idx + dk.length; k++) {
        if (cnUsed.has(k)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        keywords.push(dk);
        keywordSet.add(dk);
        for (let k = idx; k < idx + dk.length; k++) cnUsed.add(k);
      }
      idx = lower.indexOf(dk, idx + 1);
    }
  }

  // 补充：提取未匹配的中文词（2-4字），去除停用词前缀后匹配白名单
  const cnWords = lower.match(/[\u4e00-\u9fff]{2,4}/g) || [];
  for (const word of cnWords) {
    const stripped = stripCNPrefix(word);
    if (
      stripped !== word &&
      DOMAIN_KEYWORDS.has(stripped) &&
      !keywordSet.has(stripped)
    ) {
      keywords.push(stripped);
      keywordSet.add(stripped);
    }
  }

  // ── 英文关键词提取 ──
  const enSorted = EN_DOMAIN_SORTED;
  const enUsed = new Set();
  for (const dk of enSorted) {
    let idx = lower.indexOf(dk);
    while (idx !== -1) {
      // 英文需要检查词边界
      const before = idx > 0 ? lower[idx - 1] : " ";
      const after =
        idx + dk.length < lower.length ? lower[idx + dk.length] : " ";
      if (/[^a-z]/.test(before) && /[^a-z]/.test(after)) {
        let overlap = false;
        for (let k = idx; k < idx + dk.length; k++) {
          if (enUsed.has(k)) {
            overlap = true;
            break;
          }
        }
        if (!overlap) {
          keywords.push(dk);
          keywordSet.add(dk);
          for (let k = idx; k < idx + dk.length; k++) enUsed.add(k);
        }
      }
      idx = lower.indexOf(dk, idx + 1);
    }
  }

  return keywords;
}

function getSourceWeight(sourceName) {
  if (!sourceName) return SOURCE_WEIGHTS.default;
  // 精确匹配
  if (SOURCE_WEIGHTS[sourceName]) return SOURCE_WEIGHTS[sourceName];
  // 模糊匹配（source 名称包含关键词）
  const lower = sourceName.toLowerCase();
  for (const [key, weight] of Object.entries(SOURCE_WEIGHTS)) {
    if (key !== "default" && lower.includes(key.toLowerCase())) return weight;
  }
  return SOURCE_WEIGHTS.default;
}

// 噪音分类（这些分类中的关键词不进入热点排行，除非同时出现在金融/经济分类中）
const NOISE_CATEGORIES = new Set(["其他资讯", "教育与媒体", "心理学与认知"]);

function extractHotKeywords(items, topN = 15) {
  const keywordMap = new Map();
  for (const item of items) {
    const title = item.title || "";
    const category = item.category || "其他";
    const source = item.source || "";
    const sourceWeight = getSourceWeight(source);
    const keywords = extractKeywordsFromTitle(title);
    const uniqueKw = new Set(keywords);
    for (const kw of uniqueKw) {
      // 底线黑名单: 娱乐/体育等明确无关词
      if (NOISE_KEYWORDS.has(kw)) continue;
      if (!keywordMap.has(kw)) {
        keywordMap.set(kw, {
          count: 0,
          weightedCount: 0,
          categories: new Set(),
          sources: new Set(),
          isDomain: DOMAIN_KEYWORDS_LOWER.has(kw),
          totalSourceWeight: 0,
        });
      }
      const entry = keywordMap.get(kw);
      entry.count++;
      entry.weightedCount += sourceWeight;
      entry.categories.add(category);
      entry.sources.add(source);
      entry.totalSourceWeight += sourceWeight;
    }
  }

  const scored = [];
  const candidateLog = []; // 规则3: 待审核新词

  for (const [keyword, data] of keywordMap) {
    const cats = [...data.categories];
    const crossCat = data.categories.size;
    const crossSource = data.sources.size;
    const avgSourceWeight = data.totalSourceWeight / data.count;
    // 预计算最高信源权重，避免重复调用 getSourceWeight
    const maxSourceWeight = Math.max(
      ...[...data.sources].map((s) => getSourceWeight(s)),
    );

    // ── 规则 1: 白名单词直接通过（count≥1 即可）──
    if (data.isDomain) {
      if (data.count < 1) continue;
      const score =
        data.weightedCount * Math.pow(1.3, crossCat) * 1.5 * maxSourceWeight;
      scored.push({
        keyword,
        score: Math.round(score * 100) / 100,
        count: data.count,
        categories: cats,
        domain: true,
        sourceWeight: Math.round(maxSourceWeight * 100) / 100,
      });
      continue;
    }

    // ── 规则 2: 跨分类/跨信源信号 → 正常权重通过（count≥2）──
    const crossSignal = crossCat >= 2 || crossSource >= 2;
    if (crossSignal) {
      if (data.count < 2) continue;
      const score =
        data.weightedCount * Math.pow(1.3, crossCat) * 1.0 * maxSourceWeight;
      scored.push({
        keyword,
        score: Math.round(score * 100) / 100,
        count: data.count,
        categories: cats,
        domain: false,
        sourceWeight: Math.round(maxSourceWeight * 100) / 100,
      });
      continue;
    }

    // ── 规则 3: 高频新词（count≥3）→ 降级保留 + 记录候选日志 ──
    if (data.count >= 3) {
      const score =
        data.weightedCount * Math.pow(1.3, crossCat) * 0.5 * maxSourceWeight;
      scored.push({
        keyword,
        score: Math.round(score * 100) / 100,
        count: data.count,
        categories: cats,
        domain: false,
        sourceWeight: Math.round(maxSourceWeight * 100) / 100,
      });
      candidateLog.push({
        keyword,
        count: data.count,
        categories: cats,
        sources: [...data.sources],
      });
      continue;
    }

    // 其余: 丢弃（非领域、无跨分类信号、count<3）
  }

  scored.sort((a, b) => b.score - a.score);

  // 保存候选词日志供人工审核
  if (candidateLog.length > 0) {
    saveCandidateLog(candidateLog);
  }

  return mergeSimilarKeywords(scored).slice(0, topN);
}

/**
 * 合并相似关键词（子串关系）：如 "随着伊朗战争" 和 "伊朗战争" → 合并为 "伊朗战争"
 * 保留更短/更通用的关键词，累加分数和计数
 */
function mergeSimilarKeywords(keywords) {
  if (keywords.length <= 1) return keywords;
  const result = [];
  const used = new Set();

  // 按分数降序，确保高分词优先作为合并目标
  const sorted = [...keywords].sort((a, b) => b.score - a.score);

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    let kw = { ...sorted[i] };

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const other = sorted[j];
      const shorter =
        kw.keyword.length <= other.keyword.length ? kw.keyword : other.keyword;
      const longer =
        kw.keyword.length <= other.keyword.length ? other.keyword : kw.keyword;

      // 子串关系且短关键词长度 ≥ 2
      if (longer.includes(shorter) && shorter.length >= 2) {
        kw.keyword = shorter;
        kw.score += other.score;
        kw.count += other.count;
        if (!kw.domain && other.domain) kw.domain = true;
        if (other.sourceWeight > kw.sourceWeight)
          kw.sourceWeight = other.sourceWeight;
        const catSet = new Set([
          ...(kw.categories || []),
          ...(other.categories || []),
        ]);
        kw.categories = [...catSet];
        used.add(j);
      }
    }

    kw.score = Math.round(kw.score * 100) / 100;
    result.push(kw);
  }

  return result;
}

// ===== 候选关键词日志（规则3: 高频新词供人工审核）=====
const CANDIDATE_LOG_FILE = path.join(DATA_DIR, "candidate-keywords.json");

function saveCandidateLog(newCandidates) {
  let existing = [];
  try {
    if (fs.existsSync(CANDIDATE_LOG_FILE)) {
      existing = JSON.parse(fs.readFileSync(CANDIDATE_LOG_FILE, "utf-8"));
    }
  } catch {
    existing = [];
  }

  const today = new Date().toISOString().slice(0, 10);
  // 合并: 同一天的候选词去重
  const todayEntry = existing.find((e) => e.date === today);
  if (todayEntry) {
    const existingKws = new Set(todayEntry.candidates.map((c) => c.keyword));
    for (const c of newCandidates) {
      if (!existingKws.has(c.keyword)) todayEntry.candidates.push(c);
    }
  } else {
    existing.push({ date: today, candidates: newCandidates });
  }

  // 只保留最近 30 天
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  existing = existing.filter((e) => e.date >= cutoffStr);
  existing.sort((a, b) => a.date.localeCompare(b.date));

  const tmp = CANDIDATE_LOG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf-8");
  fs.renameSync(tmp, CANDIDATE_LOG_FILE);
}

// ===== 热点新闻去重（相似标题合并为一条附多信源）=====
function dedupHotItems(hotItems) {
  const SIMILARITY_THRESHOLD = 0.7;

  function normTitle(title) {
    return (title || "")
      .replace(/^[\s\-\u2013\u2014\u00B7\uFF5C\uFF1A:]+/, "")
      .replace(
        /\s*[\-\u2013\u2014]\s*(Reuters|Bloomberg|WSJ|CNBC|Financial Times|FT|BBC|CNN|NBER|36\u6C2A|新浪|观察者|凤凰)\s*$/i,
        "",
      )
      .replace(/\.com\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 80);
  }

  const merged = [];
  const normMap = []; // parallel array of normalized titles

  for (const item of hotItems) {
    const norm = normTitle(item.title);
    let matchIdx = -1;

    // Find similar existing item
    for (let i = 0; i < normMap.length; i++) {
      if (
        norm === normMap[i] ||
        similarity(norm, normMap[i]) >= SIMILARITY_THRESHOLD
      ) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx >= 0) {
      // Merge: add source to existing item
      const existing = merged[matchIdx];
      const src = item.source || "";
      if (src && !existing.sources.includes(src)) {
        existing.sources.push(src);
      }
      // Keep the longer title
      if (item.title.length > existing.title.length) {
        existing.title = item.title;
      }
      // Merge hot tags
      for (const tag of item.hotTags || []) {
        if (!existing.hotTags.includes(tag)) existing.hotTags.push(tag);
      }
    } else {
      merged.push({
        ...item,
        sources: [item.source || "unknown"],
        hotTags: [...(item.hotTags || [])],
      });
      normMap.push(norm);
    }
  }

  return merged;
}

function matchHotKeywords(title, hotKeywords) {
  const lower = (title || "").toLowerCase();
  return hotKeywords
    .filter((hk) => lower.includes(hk.keyword.toLowerCase()))
    .map((hk) => hk.keyword);
}

module.exports = {
  extractHotKeywords,
  getSourceWeight,
  matchHotKeywords,
  dedupHotItems,
  NOISE_KEYWORDS,
  DOMAIN_KEYWORDS,
  NOISE_CATEGORIES,
};
