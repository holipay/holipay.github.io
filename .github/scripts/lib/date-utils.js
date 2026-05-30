/**
 * 日期工具函数 — 日期计算、索引维护、数据清理
 * 从 analyze.js 提取
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data/news");
const ANALYSIS_DIR = path.join(DATA_DIR, "analysis");
const ANALYSIS_RETENTION_DAYS = 90;

// 辅助：获取 N 天前的日期字符串
function getDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

// ===== 日期索引维护 + 旧数据清理 =====
function updateDateIndex(dateStr, dir) {
  dir = dir || ANALYSIS_DIR;
  const indexPath = path.join(dir, "index.json");
  let dates = [];
  if (fs.existsSync(indexPath)) {
    try {
      dates = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch {}
  }
  if (!dates.includes(dateStr)) {
    dates.push(dateStr);
  }
  // Prune old dates from index
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ANALYSIS_RETENTION_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  dates = dates.filter((d) => d >= cutoff);
  dates.sort((a, b) => b.localeCompare(a));
  const tmp = indexPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(dates, null, 2), "utf-8");
  fs.renameSync(tmp, indexPath);
}

function cleanupOldAnalyses() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - ANALYSIS_RETENTION_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  if (!fs.existsSync(ANALYSIS_DIR)) return;
  const files = fs
    .readdirSync(ANALYSIS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let cleaned = 0;
  for (const file of files) {
    const date = file.replace(".json", "");
    if (date < cutoff) {
      fs.unlinkSync(path.join(ANALYSIS_DIR, file));
      cleaned++;
    }
  }
  if (cleaned > 0)
    console.log(
      `🗑️ 清理 ${cleaned} 个过期分析文件 (>${ANALYSIS_RETENTION_DAYS}天)`,
    );
}

// ===== 幂等检查 =====
function checkExistingAnalysis(dateStr) {
  const datePath = path.join(ANALYSIS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(datePath)) return null;

  try {
    const existing = JSON.parse(fs.readFileSync(datePath, "utf-8"));
    if (!existing.generatedAt) return null;

    // 检查是否是同一天生成的（Asia/Shanghai 时区）
    const generatedDate = new Date(existing.generatedAt).toLocaleDateString(
      "sv-SE",
      { timeZone: "Asia/Shanghai" },
    );

    if (generatedDate !== dateStr) return null;

    return {
      exists: true,
      generatedAt: existing.generatedAt,
      newsCount: existing.newsCount || 0,
      hasStructured: !!existing.structured,
      perspective: existing.perspective || "",
    };
  } catch {
    return null;
  }
}

module.exports = {
  getDateOffset,
  ANALYSIS_RETENTION_DAYS,
  ANALYSIS_DIR,
  DATA_DIR,
  updateDateIndex,
  cleanupOldAnalyses,
  checkExistingAnalysis,
};
