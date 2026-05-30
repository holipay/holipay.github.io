/**
 * AI 深度分析脚本 — 主入口
 *
 * 读取当日新闻，调用 DeepSeek API 生成深度分析
 * 输出: data/news/analysis/YYYY-MM-DD.json + data/news/analysis.json (最新副本)
 *
 * 特性:
 *   - 每日轮换分析视角（按星期切换侧重方向）
 *   - 注入前次分析记忆，避免重复相同主题和角度
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY  - DeepSeek API Key
 *   STORAGE_TYPE      - 存储类型: 'file' (默认) | 'api'
 *   API_BASE_URL      - API 存储的基础 URL（当 STORAGE_TYPE=api 时使用）
 */

const fs = require("fs");
const path = require("path");
const { loadCache: loadTranslationCache, saveCache: saveTranslationCache } = require("./lib/translation.js");
const { callDeepSeek } = require("./lib/deepseek.js");
const { fetchWeightedArticles } = require("./lib/articles.js");
const { loadPreviousTrends, saveTrends, buildTrendSection } = require("./lib/trends.js");
const { loadActiveEvents, updateEvents, saveEvents } = require("./lib/events.js");
const { loadDashboard, updateDashboard, saveDashboard } = require("./lib/dashboard.js");
const { loadTodayNews, selectBestNews } = require("./lib/news-selector.js");
const { loadPreviousAnalyses, selectRelevantAnalyses, extractThemes } = require("./lib/memory.js");
const { extractHotKeywords } = require("./lib/hotwords.js");
const { DAILY_PERSPECTIVES, buildPrompt } = require("./lib/prompts.js");
const { parseStructuredOutput, validateAnalysis, extractStructuredSignals } = require("./lib/structured.js");
const { isMonthlyReviewDay, runMonthlyReview } = require("./lib/monthly-review.js");
const { getDateOffset, updateDateIndex, cleanupOldAnalyses, checkExistingAnalysis, ANALYSIS_DIR, DATA_DIR } = require("./lib/date-utils.js");
const { createDataLoader } = require("./lib/data-loader.js");

const ROOT = path.resolve(__dirname, "../..");
const ARTICLES_DIR = path.join(DATA_DIR, "articles");
const MAX_ITEMS = 50;
const FORCE_FLAG = process.argv.includes("--force");

// ===== 数据加载器 =====
// 支持通过环境变量切换存储后端
const STORAGE_TYPE = process.env.STORAGE_TYPE || "file";
const dataLoader = createDataLoader(STORAGE_TYPE, {
  rootDir: DATA_DIR,
  newsDir: "data/news",
  baseUrl: process.env.API_BASE_URL,
  apiKey: process.env.API_KEY,
});

// ===== 主逻辑 =====
async function main() {
  console.log(
    "🤖 AI 深度分析引擎 v9.0（模块化重构版）",
  );
  const now = new Date();
  const dateStr = now.toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  const dayOfWeek = now.getDay();
  console.log(
    `⏰ ${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} (${dateStr})`,
  );

  if (!fs.existsSync(ANALYSIS_DIR)) {
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  }
  if (!fs.existsSync(ARTICLES_DIR)) {
    fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  }

  // 加载翻译缓存
  loadTranslationCache(90);

  // 清理过期分析文件
  cleanupOldAnalyses();

  // 幂等检查：今天的分析是否已存在
  const existing = checkExistingAnalysis(dateStr);
  if (existing && !FORCE_FLAG) {
    console.log(
      `⏭️  今日分析已存在（${existing.generatedAt}，${existing.newsCount} 条新闻，视角: ${existing.perspective}）`,
    );
    console.log("   跳过重复生成。使用 --force 参数可强制重新生成。");

    // 确保 analysis.json 最新副本存在
    const latestPath = path.join(DATA_DIR, "analysis.json");
    if (!fs.existsSync(latestPath)) {
      const datePath = path.join(ANALYSIS_DIR, `${dateStr}.json`);
      fs.copyFileSync(datePath, latestPath);
      console.log("   📋 已补充 analysis.json 最新副本");
    }
    process.exit(0);
  }
  if (existing && FORCE_FLAG) {
    console.log("🔄 检测到 --force 标志，强制重新生成今日分析");
  }

  // ===== 月度回顾检查 =====
  if (isMonthlyReviewDay(dateStr)) {
    const monthlyDone = await runMonthlyReview(dateStr, now);
    if (monthlyDone) {
      console.log("\n📊 月度回顾完成，跳过当日常规分析。");
      process.exit(0);
    }
    // 如果上月无数据，回退到常规分析
    console.log("↩️ 回退到常规每日分析模式\n");
  }

  // ===== 常规每日分析 =====
  const perspective =
    DAILY_PERSPECTIVES.find((p) => p.day === dayOfWeek) ||
    DAILY_PERSPECTIVES[0];
  console.log(`🎯 今日视角: ${perspective.label}`);

  // 加载所有历史分析（用于后续语义匹配）
  const allPreviousAnalyses = loadPreviousAnalyses(dateStr);
  if (allPreviousAnalyses.length > 0) {
    console.log(
      `🧠 已加载 ${allPreviousAnalyses.length} 份历史分析（待语义匹配）`,
    );
  } else {
    console.log("🧠 无历史分析（首次运行或无历史数据）");
  }

  console.log("\n📰 加载新闻数据...");
  const rawData = loadTodayNews();
  if (!rawData || rawData.items.length === 0) {
    console.log("⚠️ 无新闻数据，退出");
    process.exit(0);
  }
  console.log(`  📰 全量加载 ${rawData.items.length} 条新闻`);

  // 先提取热词（需要全量数据才能准确计算跨分类信号）
  const hotKeywords = extractHotKeywords(rawData.items, 15);

  // 智能选取：热词加权 + 信源权重 + 时间衰减 → top 50
  console.log("\n🎯 智能选取新闻...");
  const selectedItems = selectBestNews(rawData.items, hotKeywords, MAX_ITEMS);
  const newsData = { updatedAt: rawData.updatedAt, items: selectedItems };

  // 统计选取结果
  const catCounts = {};
  for (const item of newsData.items) {
    catCounts[item.category || "其他"] =
      (catCounts[item.category || "其他"] || 0) + 1;
  }
  console.log(
    `  ✅ 选取 ${newsData.items.length} 条（从 ${rawData.items.length} 条中），覆盖 ${Object.keys(catCounts).length} 个分类`,
  );
  for (const [cat, count] of Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)) {
    console.log(`     ${cat}: ${count} 条`);
  }

  // 语义匹配：从历史分析中选出最相关的 2-3 份
  const previousAnalyses = selectRelevantAnalyses(
    allPreviousAnalyses,
    hotKeywords,
    null,
    3,
  );
  if (previousAnalyses.length > 0) {
    console.log(`🎯 语义匹配选出 ${previousAnalyses.length} 份相关历史分析:`);
    previousAnalyses.forEach((p) => {
      const { themes } = extractThemes(p.analysis);
      console.log(
        `   ${p.date} (相关度:${p.relevance?.toFixed(1)}): ${themes.slice(0, 3).join("、")}`,
      );
    });
  }

  // 抓取热点文章摘要
  let snippets = [];
  if (hotKeywords.length > 0) {
    console.log("\n📄 按权重分层抓取文章内容...");
    snippets = await fetchWeightedArticles(hotKeywords, rawData.items);
    console.log(`  📄 共获取 ${snippets.length} 篇文章`);

    // 保存抓取的文章内容到 articles.json
    if (snippets.length > 0) {
      const articlesPath = path.join(DATA_DIR, "articles.json");
      const articlesData = {
        date: dateStr,
        updatedAt: now.toISOString(),
        items: snippets,
      };

      // 按日期归档
      const archivePath = path.join(ARTICLES_DIR, `${dateStr}.json`);
      const archiveTmp = archivePath + ".tmp";
      fs.writeFileSync(
        archiveTmp,
        JSON.stringify(articlesData, null, 2),
        "utf-8",
      );
      fs.renameSync(archiveTmp, archivePath);
      console.log(`💾 已归档 data/news/articles/${dateStr}.json`);

      // 保存最新指针（前端兼容）
      const articlesTmp = articlesPath + ".tmp";
      fs.writeFileSync(
        articlesTmp,
        JSON.stringify(articlesData, null, 2),
        "utf-8",
      );
      fs.renameSync(articlesTmp, articlesPath);
      console.log(
        `💾 已保存 data/news/articles.json (${snippets.length} 篇文章)`,
      );

      updateDateIndex(dateStr, ARTICLES_DIR);
    }
  }

  // 加载历史趋势 + 构建趋势对比
  const previousTrends = loadPreviousTrends(dateStr);
  if (previousTrends.length > 0) {
    console.log(`📈 已加载 ${previousTrends.length} 条历史趋势数据`);
  }
  const trendSection = buildTrendSection(hotKeywords, previousTrends);

  let prompt = buildPrompt(
    newsData,
    previousAnalyses,
    perspective,
    hotKeywords,
    snippets,
    trendSection,
  );
  console.log("\n🤖 调用 DeepSeek 分析中...");

  try {
    // P2-2: 两步调用 — 先提取结构化信号，再生成深度分析
    let structured = {};
    const earlySignals = await extractStructuredSignals(newsData, hotKeywords);
    if (earlySignals) {
      structured = earlySignals;
      // 将提前获取的信号注入分析 prompt，减少重复提取
      const signalHint = `\n\n━━━ 📊 预提取信号（供参考，可修正）━━━\n情绪: ${earlySignals.sentiment}\n风险: ${earlySignals.riskLevel}\n主题: ${(earlySignals.keyThemes || []).join(", ")}\n行业: ${(earlySignals.sectors || []).join(", ")}\n前瞻: ${earlySignals.outlook || "无"}\n`;
      prompt += signalHint;
    }

    const rawAnalysis = await callDeepSeek(prompt);
    console.log(`✅ 分析完成 (${rawAnalysis.length} 字)`);

    // 解析结构化输出（合并: 分析结果优先，预提取做兜底）
    const parsed = parseStructuredOutput(rawAnalysis);
    const analysis = parsed.analysis;
    structured = {
      sentiment: parsed.structured?.sentiment || structured.sentiment || "中性",
      riskLevel: parsed.structured?.riskLevel || structured.riskLevel || "中",
      keyThemes: parsed.structured?.keyThemes?.length
        ? parsed.structured.keyThemes
        : structured.keyThemes || [],
      sectors: parsed.structured?.sectors?.length
        ? parsed.structured.sectors
        : structured.sectors || [],
      outlook: parsed.structured?.outlook || structured.outlook || "",
      eventChains: parsed.structured?.eventChains || [],
    };
    console.log(
      `📊 结构化: sentiment=${structured.sentiment}, risk=${structured.riskLevel}, themes=[${structured.keyThemes.join(",")}]`,
    );

    if (hotKeywords.length > 0) {
      console.log(
        `🔥 热点: ${hotKeywords
          .slice(0, 5)
          .map((hk) => `${hk.keyword}(${hk.score})`)
          .join(", ")}`,
      );
    }

    const result = {
      date: dateStr,
      generatedAt: now.toISOString(),
      newsCount: newsData.items.length,
      perspective: perspective.label,
      analysis: analysis,
      structured: structured,
      hotKeywords: hotKeywords,
      sources: newsData.items.slice(0, 10).map((i) => ({
        title: i.title,
        source: i.source,
      })),
    };

    // P1-2: 质量校验
    const quality = validateAnalysis(result);
    if (!quality.ok) {
      console.warn("⚠️ 分析质量未达标，但仍保存（可使用 --force 重新生成）");
    }

    const datePath = path.join(ANALYSIS_DIR, `${dateStr}.json`);
    const tmp = datePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2), "utf-8");
    fs.renameSync(tmp, datePath);
    console.log(`💾 已保存 data/news/analysis/${dateStr}.json`);

    const latestPath = path.join(DATA_DIR, "analysis.json");
    const tmp2 = latestPath + ".tmp";
    fs.writeFileSync(tmp2, JSON.stringify(result, null, 2), "utf-8");
    fs.renameSync(tmp2, latestPath);
    console.log("💾 已保存 data/news/analysis.json (最新)");

    updateDateIndex(dateStr);
    console.log("📋 已更新日期索引");

    // 保存热点趋势数据
    saveTrends(dateStr, hotKeywords);
    console.log("📈 已保存热点趋势数据");

    // 更新事件链
    const activeEvents = loadActiveEvents();
    const updatedEvents = updateEvents(
      activeEvents,
      structured.eventChains,
      dateStr,
      structured.sentiment,
    );
    saveEvents(updatedEvents);
    const activeCount = updatedEvents.filter(
      (e) => e.status === "active",
    ).length;
    console.log(`🔗 已更新事件链（${activeCount} 个活跃事件）`);

    // 更新信号仪表盘
    const dashboard = loadDashboard();
    updateDashboard(dashboard, dateStr, structured, hotKeywords);
    saveDashboard(dashboard);
    console.log(`📊 已更新信号仪表盘（${dashboard.days.length} 天数据）`);

    // 保存翻译缓存
    saveTranslationCache(90, { compact: false });
  } catch (e) {
    console.error(`❌ 分析失败: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ 分析失败:", e.message);
  process.exit(1);
});
