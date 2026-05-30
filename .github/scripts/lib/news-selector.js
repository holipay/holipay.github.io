/**
 * 新闻加载和智能选取
 * 从 analyze.js 提取
 */

const fs = require("fs");
const path = require("path");
const { getSourceWeight } = require("./hotwords.js");
const { getDateOffset, DATA_DIR } = require("./date-utils.js");

// ===== 数据加载 =====
function loadTodayNews() {
  const metaPath = path.join(DATA_DIR, "meta.json");
  if (!fs.existsSync(metaPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const allItems = [];

  for (const cat of meta.categories) {
    const catPath = path.join(DATA_DIR, `${cat.file}.json`);
    if (!fs.existsSync(catPath)) continue;
    try {
      const catData = JSON.parse(fs.readFileSync(catPath, "utf-8"));
      for (const item of catData.items || []) {
        let link = item.link || "";
        const cdataMatch = link.match(
          /<!\[CDATA\[([^\]]+)\]\]>/,
        );
        if (cdataMatch) link = cdataMatch[1];
        allItems.push({
          title: item.title,
          link,
          source: item.source || "",
          date: item.date || "",
          category: cat.title,
        });
      }
    } catch {}
  }

  allItems.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return {
    updatedAt: meta.updatedAt,
    items: allItems,
  };
}

// ===== 智能新闻选取（热词加权 + 信源权重 + 时间衰减）=====
function selectBestNews(allItems, hotKeywords, maxItems = 50) {
  if (allItems.length <= maxItems) return allItems;

  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  const topKws = hotKeywords.slice(0, 10);

  // 分类感知的时间衰减系数 [今天, 昨天, 前天, 更早]
  const DECAY_PROFILES = {
    // 经济金融：极度时效敏感
    fast: [1.0, 0.5, 0.2, 0.1],
    // 社科研究：长尾价值
    slow: [1.0, 0.9, 0.8, 0.6],
    // 默认：中等衰减
    medium: [1.0, 0.7, 0.5, 0.3],
  };
  const FAST_DECAY = new Set(["股市与市场", "央行与利率", "大宗商品与能源"]);
  const SLOW_DECAY = new Set([
    "心理学与认知",
    "教育与媒体",
    "健康与公共卫生",
    "科技与研究",
  ]);

  function getDecay(category, date) {
    const profile = FAST_DECAY.has(category)
      ? DECAY_PROFILES.fast
      : SLOW_DECAY.has(category)
        ? DECAY_PROFILES.slow
        : DECAY_PROFILES.medium;
    if (date === today) return profile[0];
    if (date >= getDateOffset(-1)) return profile[1];
    if (date >= getDateOffset(-2)) return profile[2];
    return profile[3];
  }

  function scoreItem(item) {
    const title = (item.title || "").toLowerCase();
    const source = item.source || "";
    const date = item.date || "";
    const category = item.category || "";

    // 热词匹配分（匹配到的热词分数之和）
    let kwScore = 0;
    for (const hk of topKws) {
      if (title.includes(hk.keyword.toLowerCase())) {
        kwScore += hk.score;
      }
    }

    // 信源权重
    const srcWeight = getSourceWeight(source);

    // 分类感知的时间衰减
    const recency = getDecay(category, date);

    // 最终分数
    if (kwScore > 0) {
      return kwScore * srcWeight * recency;
    }
    return srcWeight * recency * 0.3; // 无热词命中的条目降权
  }

  // 去重（标题相似度过高只保留分数最高的）
  const seenNorms = new Set();
  const uniqueItems = [];
  for (const item of allItems) {
    const norm = (item.title || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    if (!norm) continue;
    if (seenNorms.has(norm)) continue;
    seenNorms.add(norm);
    uniqueItems.push(item);
  }

  // 打分排序
  const scored = uniqueItems.map((item) => ({ item, score: scoreItem(item) }));
  scored.sort((a, b) => b.score - a.score);

  // 保底：确保每个分类至少有 1 条（避免某分类完全被筛掉）
  const selected = [];
  const catSeen = new Set();
  const topItems = scored.slice(0, maxItems * 2); // 候选池扩大 2 倍

  // 第一轮：每个分类保底 1 条
  for (const { item } of topItems) {
    if (selected.length >= maxItems) break;
    const cat = item.category || "其他";
    if (!catSeen.has(cat)) {
      catSeen.add(cat);
      selected.push(item);
    }
  }

  // 第二轮：按分数填充剩余名额
  const selectedTitles = new Set(selected.map((i) => i.title));
  for (const { item } of topItems) {
    if (selected.length >= maxItems) break;
    if (!selectedTitles.has(item.title)) {
      selectedTitles.add(item.title);
      selected.push(item);
    }
  }

  return selected;
}

module.exports = {
  loadTodayNews,
  selectBestNews,
};
