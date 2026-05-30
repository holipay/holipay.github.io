/**
 * 信号仪表盘
 * 从 analyze.js 提取
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./date-utils.js");

const DASHBOARD_FILE = path.join(DATA_DIR, "dashboard.json");
const DASHBOARD_RETENTION_DAYS = 90;

function loadDashboard() {
  if (!fs.existsSync(DASHBOARD_FILE)) return { days: [], keywordTrends: [] };
  try {
    return JSON.parse(fs.readFileSync(DASHBOARD_FILE, "utf-8"));
  } catch {
    return { days: [], keywordTrends: [] };
  }
}

function updateDashboard(dashboard, dateStr, structured, hotKeywords) {
  // 更新/插入当日数据
  const dayEntry = {
    date: dateStr,
    sentiment: structured.sentiment,
    riskLevel: structured.riskLevel,
    keyThemes: structured.keyThemes || [],
    sectors: structured.sectors || [],
    outlook: structured.outlook || "",
    topKeywords: (hotKeywords || []).slice(0, 10).map((hk) => ({
      keyword: hk.keyword,
      score: hk.score,
      count: hk.count,
    })),
  };

  dashboard.days = (dashboard.days || []).filter((d) => d.date !== dateStr);
  dashboard.days.push(dayEntry);

  // 清理超期数据
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DASHBOARD_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  dashboard.days = dashboard.days.filter((d) => d.date >= cutoffStr);
  dashboard.days.sort((a, b) => a.date.localeCompare(b.date));

  // 计算关键词趋势（7天 vs 30天）
  const now = dashboard.days;
  const last7 = now.slice(-7);
  const last30 = now.slice(-30);
  const kw7 = aggregateKeywords(last7);
  const kw30 = aggregateKeywords(last30);

  const trendMap = new Map();
  for (const [kw, data7] of kw7) {
    const data30 = kw30.get(kw) || { avgScore: 0, total: 0 };
    const delta =
      data30.avgScore > 0
        ? ((data7.avgScore - data30.avgScore) / data30.avgScore) * 100
        : 0;
    trendMap.set(kw, {
      keyword: kw,
      avgScore7d: Math.round(data7.avgScore * 100) / 100,
      avgScore30d: Math.round(data30.avgScore * 100) / 100,
      trend: Math.round(delta),
      frequency7d: data7.total,
      frequency30d: data30.total,
    });
  }

  dashboard.keywordTrends = [...trendMap.values()]
    .sort((a, b) => b.avgScore7d - a.avgScore7d)
    .slice(0, 30);

  // 情绪/风险序列（用于前端绘图）
  dashboard.signals = now.map((d) => ({
    date: d.date,
    sentiment: d.sentiment,
    riskLevel: d.riskLevel,
    keywordCount: d.topKeywords.length,
  }));

  return dashboard;
}

function aggregateKeywords(days) {
  const map = new Map();
  for (const d of days) {
    for (const kw of d.topKeywords || []) {
      if (!map.has(kw.keyword)) map.set(kw.keyword, { scores: [], total: 0 });
      const entry = map.get(kw.keyword);
      entry.scores.push(kw.score);
      entry.total++;
    }
  }
  const result = new Map();
  for (const [kw, data] of map) {
    result.set(kw, {
      avgScore: data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
      total: data.total,
    });
  }
  return result;
}

function saveDashboard(dashboard) {
  const tmp = DASHBOARD_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(dashboard, null, 2), "utf-8");
  fs.renameSync(tmp, DASHBOARD_FILE);
}

module.exports = {
  loadDashboard,
  updateDashboard,
  saveDashboard,
};
