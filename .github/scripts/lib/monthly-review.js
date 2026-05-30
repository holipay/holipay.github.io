/**
 * 月度回顾逻辑
 * 从 analyze.js 提取
 */

const fs = require("fs");
const path = require("path");
const { callDeepSeek } = require("./deepseek.js");
const { parseStructuredOutput } = require("./structured.js");
const { buildMonthlyReviewPrompt } = require("./prompts.js");
const { loadTodayNews } = require("./news-selector.js");
const { extractHotKeywords } = require("./hotwords.js");
const { updateDateIndex, ANALYSIS_DIR, DATA_DIR } = require("./date-utils.js");

// 检查是否是月度回顾日（每月1日±1天，即1号、2号、3号）
function isMonthlyReviewDay(dateStr) {
  const day = parseInt(dateStr.split("-")[2], 10);
  return day >= 1 && day <= 3;
}

// 加载上月所有每日分析
function loadLastMonthAnalyses(currentDateStr) {
  const [curYear, curMonth] = currentDateStr.split("-").map(Number);
  // 上个月
  const lastMonth = curMonth === 1 ? 12 : curMonth - 1;
  const lastYear = curMonth === 1 ? curYear - 1 : curYear;
  const prefix = `${lastYear}-${String(lastMonth).padStart(2, "0")}`;

  if (!fs.existsSync(ANALYSIS_DIR)) return [];

  const files = fs.readdirSync(ANALYSIS_DIR).filter((f) => {
    return (
      f.startsWith(prefix) &&
      f.endsWith(".json") &&
      f !== "index.json" &&
      f !== "trends.json" &&
      /^\d{4}-\d{2}-\d{2}\.json$/.test(f)
    );
  });
  files.sort();

  const results = [];
  for (const file of files) {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(ANALYSIS_DIR, file), "utf-8"),
      );
      results.push({
        date: file.replace(".json", ""),
        analysis: data.analysis || "",
        structured: data.structured || {},
        perspective: data.perspective || "",
        newsCount: data.newsCount || 0,
        hotKeywords: data.hotKeywords || [],
      });
    } catch (e) {
      console.warn(`⚠️ 跳过损坏文件: ${file}`);
    }
  }
  return results;
}

// 运行月度回顾
async function runMonthlyReview(dateStr, now) {
  console.log("📊 进入月度回顾模式...");

  const [curYear, curMonth] = dateStr.split("-").map(Number);
  const lastMonth = curMonth === 1 ? 12 : curMonth - 1;
  const lastYear = curMonth === 1 ? curYear - 1 : curYear;
  const monthStr = `${lastYear}-${String(lastMonth).padStart(2, "0")}`;

  // 加载上月分析
  const analyses = loadLastMonthAnalyses(dateStr);
  console.log(`  📄 找到 ${analyses.length} 天的分析数据（${monthStr}）`);

  if (analyses.length === 0) {
    console.log("  ⚠️ 上月无分析数据，回退到每日分析模式");
    return false; // signal to fall through to daily
  }

  // 也加载今日新闻作为补充
  const todayNews = loadTodayNews();

  // 构建 prompt
  const prompt = buildMonthlyReviewPrompt(analyses, todayNews, monthStr);

  console.log("\n🤖 调用 DeepSeek 生成月度回顾...");
  const monthlySystemPrompt = [
    "你是一位资深的宏观策略分析师，同时也是AI分析系统的质量审计员。",
    "你的任务有两个：",
    "1. 从大量碎片化的每日分析中提炼月度级别的宏观趋势和深度洞察。",
    "2. 诚实地回顾和评估AI系统自身的分析质量——哪些判断正确、哪些偏离、哪些遗漏。",
    "你必须有独到见解，拒绝套话。自我纠错部分要诚实具体，不要回避错误。",
    "输出纯文本格式，使用 Markdown 标记。",
  ].join("");
  const rawAnalysis = await callDeepSeek(prompt, monthlySystemPrompt, 8000);
  console.log(`✅ 月度回顾完成 (${rawAnalysis.length} 字)`);

  // 解析结构化输出
  const { analysis, structured } = parseStructuredOutput(rawAnalysis);

  // 月度热点
  const topicFreq = {};
  for (const a of analyses) {
    for (const hk of a.hotKeywords || []) {
      const kw = hk.keyword || hk;
      topicFreq[kw] = (topicFreq[kw] || 0) + (hk.score || 1);
    }
  }
  const topTopics = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([keyword, score]) => ({ keyword, score: Math.round(score) }));

  const result = {
    date: dateStr,
    generatedAt: now.toISOString(),
    newsCount: todayNews ? todayNews.items.length : 0,
    perspective: "月度回顾",
    isMonthlyReview: true,
    reviewMonth: monthStr,
    daysAnalyzed: analyses.length,
    analysis: analysis,
    structured: {
      ...structured,
      keyThemes:
        structured.keyThemes.length > 0
          ? structured.keyThemes
          : [`月度回顾-${monthStr}`],
    },
    hotKeywords: topTopics,
    sources: [],
  };

  // 保存
  const datePath = path.join(ANALYSIS_DIR, `${dateStr}.json`);
  const tmp = datePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2), "utf-8");
  fs.renameSync(tmp, datePath);
  console.log(`💾 已保存 data/news/analysis/${dateStr}.json（月度回顾）`);

  const latestPath = path.join(DATA_DIR, "analysis.json");
  const tmp2 = latestPath + ".tmp";
  fs.writeFileSync(tmp2, JSON.stringify(result, null, 2), "utf-8");
  fs.renameSync(tmp2, latestPath);
  console.log("💾 已保存 data/news/analysis.json (最新)");

  updateDateIndex(dateStr);
  console.log("📋 已更新日期索引");

  return true; // success
}

module.exports = {
  isMonthlyReviewDay,
  loadLastMonthAnalyses,
  runMonthlyReview,
};
