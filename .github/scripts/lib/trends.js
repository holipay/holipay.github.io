/**
 * 跨日趋势追踪
 * 从 analyze.js 提取
 */

const fs = require("fs");
const path = require("path");
const { ANALYSIS_DIR } = require("./date-utils.js");

const TRENDS_FILE = path.join(ANALYSIS_DIR, "trends.json");
const TRENDS_RETENTION_DAYS = 14;

function loadPreviousTrends(currentDateStr) {
  if (!fs.existsSync(TRENDS_FILE)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(TRENDS_FILE, "utf-8"));
    return all.filter((t) => t.date < currentDateStr).slice(-3); // 最近 3 次
  } catch {
    return [];
  }
}

function saveTrends(dateStr, hotKeywords) {
  let all = [];
  try {
    if (fs.existsSync(TRENDS_FILE)) {
      all = JSON.parse(fs.readFileSync(TRENDS_FILE, "utf-8"));
    }
  } catch {
    all = [];
  }

  // 去重（同一天不重复写入）
  all = all.filter((t) => t.date !== dateStr);
  all.push({
    date: dateStr,
    keywords: hotKeywords.slice(0, 10).map((hk) => ({
      keyword: hk.keyword,
      score: hk.score,
      count: hk.count,
    })),
  });

  // 清理旧数据
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TRENDS_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  all = all.filter((t) => t.date >= cutoffStr);
  all.sort((a, b) => a.date.localeCompare(b.date));

  const tmp = TRENDS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf-8");
  fs.renameSync(tmp, TRENDS_FILE);
}

function buildTrendSection(currentHotKeywords, previousTrends) {
  if (previousTrends.length === 0) return "";

  // 构建历史关键词 map: keyword -> [{date, score}]
  const historyMap = new Map();
  for (const trend of previousTrends) {
    for (const kw of trend.keywords) {
      if (!historyMap.has(kw.keyword)) historyMap.set(kw.keyword, []);
      historyMap.get(kw.keyword).push({ date: trend.date, score: kw.score });
    }
  }

  const trendLines = [];
  for (const hk of currentHotKeywords.slice(0, 10)) {
    const history = historyMap.get(hk.keyword);
    if (!history || history.length === 0) {
      trendLines.push(
        `  - **${hk.keyword}**: 当前热度 ${hk.score}（🆕 新热点）`,
      );
      continue;
    }
    const lastScore = history[history.length - 1].score;
    const lastDate = history[history.length - 1].date;
    const delta = hk.score - lastScore;
    const pct = lastScore > 0 ? Math.round((delta / lastScore) * 100) : 0;
    const arrow = delta > 2 ? "🔺" : delta < -2 ? "🔻" : "➡️";
    const trendDesc =
      delta > 2
        ? `上升 ${pct}%`
        : delta < -2
          ? `下降 ${Math.abs(pct)}%`
          : "持平";
    trendLines.push(
      `  - **${hk.keyword}**: ${hk.score}（${arrow} vs ${lastDate}: ${lastScore} → ${trendDesc}）`,
    );
  }

  if (trendLines.length === 0) return "";

  return `

━━━ 📈 热点趋势变化（与近期对比）━━━
${trendLines.join("\n")}
说明: 🔺 = 热度上升，🔻 = 热度下降，➡️ = 基本持平，🆕 = 首次出现
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

module.exports = {
  loadPreviousTrends,
  saveTrends,
  buildTrendSection,
};
