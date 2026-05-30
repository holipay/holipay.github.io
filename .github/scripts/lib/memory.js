/**
 * 历史分析记忆和语义匹配
 * 从 analyze.js 提取
 */

const fs = require("fs");
const path = require("path");
const { ANALYSIS_DIR } = require("./date-utils.js");

// ===== 加载历史分析（用于记忆注入）=====
function loadPreviousAnalyses(currentDateStr, count = 2) {
  const indexPath = path.join(ANALYSIS_DIR, "index.json");
  if (!fs.existsSync(indexPath)) return [];

  let dates = [];
  try {
    dates = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch {
    return [];
  }

  const prevDates = dates.filter((d) => d < currentDateStr);
  if (prevDates.length === 0) return [];

  // 加载所有历史分析（用于语义匹配）
  const allAnalyses = [];
  for (const d of prevDates) {
    const filePath = path.join(ANALYSIS_DIR, `${d}.json`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      allAnalyses.push({
        date: d,
        analysis: data.analysis || "",
        structured: data.structured || {},
        hotKeywords: data.hotKeywords || [],
      });
    } catch {}
  }

  return allAnalyses;
}

// ===== 语义匹配：基于结构化数据的轻量级检索 =====
function computeRelevance(target, candidate) {
  let score = 0;
  const targetThemes = new Set(
    (target.keyThemes || []).map((t) => t.toLowerCase()),
  );
  const targetSectors = new Set(
    (target.sectors || []).map((s) => s.toLowerCase()),
  );
  const targetKws = new Set(
    (target.hotKeywords || []).map((hk) => (hk.keyword || hk).toLowerCase()),
  );
  const candidateThemes = (candidate.structured?.keyThemes || []).map((t) =>
    t.toLowerCase(),
  );
  const candidateSectors = (candidate.structured?.sectors || []).map((s) =>
    s.toLowerCase(),
  );
  const candidateKws = (candidate.hotKeywords || []).map((hk) =>
    (hk.keyword || hk).toLowerCase(),
  );

  // 主题匹配（权重 3）
  for (const t of candidateThemes) {
    if (targetThemes.has(t)) score += 3;
  }

  // 行业匹配（权重 2）
  for (const s of candidateSectors) {
    if (targetSectors.has(s)) score += 2;
  }

  // 关键词匹配（权重 1，关键词交集越多分越高）
  let kwOverlap = 0;
  for (const kw of candidateKws) {
    if (targetKws.has(kw)) kwOverlap++;
  }
  score += kwOverlap;

  // 时间衰减（越近的分析越有参考价值，但不主导匹配）
  const dayDiff = Math.max(
    1,
    (new Date(target.date || Date.now()) - new Date(candidate.date)) / 86400000,
  );
  const recencyBonus = Math.max(0, 1 - dayDiff / 30); // 30天内有递减加分
  score += recencyBonus;

  return score;
}

function selectRelevantAnalyses(
  allAnalyses,
  currentHotKeywords,
  currentStructured,
  count,
) {
  if (allAnalyses.length === 0) return [];

  const todayTarget = {
    date: new Date().toISOString().slice(0, 10),
    hotKeywords: currentHotKeywords || [],
    keyThemes: currentStructured?.keyThemes || [],
    sectors: currentStructured?.sectors || [],
  };

  // 计算每个历史分析的相关度
  const scored = allAnalyses.map((a) => ({
    ...a,
    relevance: computeRelevance(todayTarget, a),
  }));

  // 按相关度排序，取 top N
  scored.sort((a, b) => b.relevance - a.relevance);
  const selected = scored.slice(0, count);

  // 按日期排序（prompt 中需要时间顺序）
  selected.sort((a, b) => a.date.localeCompare(b.date));

  return selected;
}

// ===== 从历史分析中提取关键主题 =====
function extractThemes(analysisText) {
  const lines = analysisText.split("\n");
  const themes = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{2,3}\s/.test(trimmed)) {
      themes.push(
        trimmed
          .replace(/^#{2,3}\s+/, "")
          .replace(/[📌🔍📊⚠️🔮📅🌍🏭🔄📜📈🔗]/g, "")
          .trim(),
      );
    }
  }

  const paragraphs = analysisText
    .split("\n\n")
    .filter((p) => p.trim() && !p.trim().startsWith("#"))
    .slice(0, 3);

  const summaries = paragraphs.map((p) => {
    const clean = p.replace(/[*_`#\[\]]/g, "").trim();
    return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
  });

  return { themes, summaries };
}

module.exports = {
  loadPreviousAnalyses,
  selectRelevantAnalyses,
  extractThemes,
};
