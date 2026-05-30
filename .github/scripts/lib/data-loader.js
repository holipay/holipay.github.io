/**
 * 统一数据加载器
 * 封装业务实体的加载和保存逻辑，支持多种存储后端
 * 
 * 使用方式：
 *   const { createDataLoader } = require("./data-loader.js");
 *   const loader = createDataLoader("file", { rootDir: "/path/to/data" });
 *   const news = await loader.loadNews();
 */

const path = require("path");
const { createStorage } = require("./storage/index.js");

class DataLoader {
  /**
   * @param {import("./storage/base.js")} storage - 存储后端实例
   * @param {object} options - 配置选项
   */
  constructor(storage, options = {}) {
    this.storage = storage;
    this.newsDir = options.newsDir || "data/news";
    this.analysisDir = path.join(this.newsDir, "analysis");
    this.articlesDir = path.join(this.newsDir, "articles");
  }

  // ===== 新闻数据 =====

  /**
   * 加载今日新闻
   * @returns {Promise<{updatedAt: string, items: Array}|null>}
   */
  async loadNews() {
    const meta = await this.storage.readJson(
      path.join(this.newsDir, "meta.json")
    );
    if (!meta) return null;

    const allItems = [];
    for (const cat of meta.categories) {
      const catData = await this.storage.readJson(
        path.join(this.newsDir, `${cat.file}.json`)
      );
      if (!catData) continue;

      for (const item of catData.items || []) {
        let link = item.link || "";
        const cdataMatch = link.match(/<!\[CDATA\[([^\]]+)\]\]>/);
        if (cdataMatch) link = cdataMatch[1];
        allItems.push({
          title: item.title,
          link,
          source: item.source || "",
          date: item.date || "",
          category: cat.title,
        });
      }
    }

    allItems.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return {
      updatedAt: meta.updatedAt,
      items: allItems,
    };
  }

  /**
   * 加载最新新闻（从 latest.json）
   * @returns {Promise<{updatedAt: string, items: Array}|null>}
   */
  async loadLatestNews() {
    return this.storage.readJson(path.join(this.newsDir, "latest.json"));
  }

  // ===== 分析数据 =====

  /**
   * 加载历史分析列表
   * @param {string} currentDateStr - 当前日期（排除当天）
   * @param {number} limit - 最大返回数量
   * @returns {Promise<Array>}
   */
  async loadAnalyses(currentDateStr, limit = 100) {
    const index = await this.storage.readJson(
      path.join(this.analysisDir, "index.json"),
      []
    );

    const prevDates = index
      .filter((d) => d < currentDateStr)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit);

    const analyses = [];
    for (const date of prevDates) {
      const data = await this.storage.readJson(
        path.join(this.analysisDir, `${date}.json`)
      );
      if (data) {
        analyses.push({
          date,
          analysis: data.analysis || "",
          structured: data.structured || {},
          hotKeywords: data.hotKeywords || [],
          perspective: data.perspective || "",
          newsCount: data.newsCount || 0,
        });
      }
    }

    return analyses;
  }

  /**
   * 加载指定日期的分析
   * @param {string} dateStr - 日期字符串
   * @returns {Promise<object|null>}
   */
  async loadAnalysis(dateStr) {
    return this.storage.readJson(
      path.join(this.analysisDir, `${dateStr}.json`)
    );
  }

  /**
   * 保存分析结果
   * @param {string} dateStr - 日期字符串
   * @param {object} result - 分析结果
   * @returns {Promise<void>}
   */
  async saveAnalysis(dateStr, result) {
    // 保存日期文件
    await this.storage.writeJson(
      path.join(this.analysisDir, `${dateStr}.json`),
      result
    );

    // 更新最新副本
    await this.storage.writeJson(
      path.join(this.newsDir, "analysis.json"),
      result
    );

    // 更新索引
    const index = await this.storage.readJson(
      path.join(this.analysisDir, "index.json"),
      []
    );
    if (!index.includes(dateStr)) {
      index.push(dateStr);
      index.sort((a, b) => b.localeCompare(a));
    }
    await this.storage.writeJson(
      path.join(this.analysisDir, "index.json"),
      index
    );
  }

  // ===== 文章数据 =====

  /**
   * 保存抓取的文章内容
   * @param {string} dateStr - 日期字符串
   * @param {object} articlesData - 文章数据
   * @returns {Promise<void>}
   */
  async saveArticles(dateStr, articlesData) {
    // 按日期归档
    await this.storage.writeJson(
      path.join(this.articlesDir, `${dateStr}.json`),
      articlesData
    );

    // 保存最新指针
    await this.storage.writeJson(
      path.join(this.newsDir, "articles.json"),
      articlesData
    );
  }

  // ===== 趋势数据 =====

  /**
   * 加载趋势数据
   * @param {string} currentDateStr - 当前日期（排除当天）
   * @param {number} limit - 最大返回数量
   * @returns {Promise<Array>}
   */
  async loadTrends(currentDateStr, limit = 3) {
    const all = await this.storage.readJson(
      path.join(this.analysisDir, "trends.json"),
      []
    );
    return all.filter((t) => t.date < currentDateStr).slice(-limit);
  }

  /**
   * 保存趋势数据
   * @param {string} dateStr - 日期字符串
   * @param {Array} hotKeywords - 热词数据
   * @param {number} retentionDays - 保留天数
   * @returns {Promise<void>}
   */
  async saveTrends(dateStr, hotKeywords, retentionDays = 14) {
    const all = await this.storage.readJson(
      path.join(this.analysisDir, "trends.json"),
      []
    );

    // 去重
    const filtered = all.filter((t) => t.date !== dateStr);
    filtered.push({
      date: dateStr,
      keywords: hotKeywords.slice(0, 10).map((hk) => ({
        keyword: hk.keyword,
        score: hk.score,
        count: hk.count,
      })),
    });

    // 清理旧数据
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const cleaned = filtered.filter((t) => t.date >= cutoffStr);
    cleaned.sort((a, b) => a.date.localeCompare(b.date));

    await this.storage.writeJson(
      path.join(this.analysisDir, "trends.json"),
      cleaned
    );
  }

  // ===== 事件链数据 =====

  /**
   * 加载所有事件
   * @returns {Promise<Array>}
   */
  async loadEvents() {
    return this.storage.readJson(
      path.join(this.newsDir, "events.json"),
      []
    );
  }

  /**
   * 保存事件数据
   * @param {Array} events - 事件数组
   * @returns {Promise<void>}
   */
  async saveEvents(events) {
    await this.storage.writeJson(
      path.join(this.newsDir, "events.json"),
      events
    );
  }

  // ===== 仪表盘数据 =====

  /**
   * 加载仪表盘数据
   * @returns {Promise<object>}
   */
  async loadDashboard() {
    return this.storage.readJson(
      path.join(this.newsDir, "dashboard.json"),
      { days: [], keywordTrends: [] }
    );
  }

  /**
   * 保存仪表盘数据
   * @param {object} dashboard - 仪表盘数据
   * @returns {Promise<void>}
   */
  async saveDashboard(dashboard) {
    await this.storage.writeJson(
      path.join(this.newsDir, "dashboard.json"),
      dashboard
    );
  }

  // ===== 候选关键词日志 =====

  /**
   * 保存候选关键词日志
   * @param {Array} candidates - 候选关键词
   * @returns {Promise<void>}
   */
  async saveCandidateLog(candidates) {
    const existing = await this.storage.readJson(
      path.join(this.newsDir, "candidate-keywords.json"),
      []
    );

    const today = new Date().toISOString().slice(0, 10);
    const todayEntry = existing.find((e) => e.date === today);
    
    if (todayEntry) {
      const existingKws = new Set(todayEntry.candidates.map((c) => c.keyword));
      for (const c of candidates) {
        if (!existingKws.has(c.keyword)) todayEntry.candidates.push(c);
      }
    } else {
      existing.push({ date: today, candidates });
    }

    // 只保留最近 30 天
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const cleaned = existing.filter((e) => e.date >= cutoffStr);
    cleaned.sort((a, b) => a.date.localeCompare(b.date));

    await this.storage.writeJson(
      path.join(this.newsDir, "candidate-keywords.json"),
      cleaned
    );
  }
}

/**
 * 创建数据加载器实例
 * @param {string} storageType - 存储类型: 'file' | 'api'
 * @param {object} options - 配置选项
 * @returns {DataLoader}
 */
function createDataLoader(storageType = "file", options = {}) {
  const storage = createStorage(storageType, options);
  return new DataLoader(storage, options);
}

module.exports = {
  DataLoader,
  createDataLoader,
};
