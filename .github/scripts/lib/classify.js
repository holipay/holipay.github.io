/**
 * 分类模块 — 关键词分类 + 置信度检测 + LLM 辅助分类
 * 从 update-news.js 提取
 */

const { apiCall } = require("./http.js");

function preprocessCategories(categories) {
  return categories.map((cat) => ({
    ...cat,
    _kwLower: cat.keywords.map((kw) => kw.toLowerCase()),
  }));
}

function classify(item, processedCats, defaultCat) {
  const titleEN = (
    typeof item === "string" ? "" : item.titleEN || ""
  ).toLowerCase();
  const title = (
    typeof item === "string" ? item : item.title || ""
  ).toLowerCase();
  const matchTarget = titleEN || title;
  for (const cat of processedCats) {
    if (cat._kwLower.some((kw) => matchTarget.includes(kw))) return cat;
  }
  return defaultCat;
}

function classifyWithConfidence(item, processedCats, defaultCat) {
  const titleEN = (
    typeof item === "string" ? "" : item.titleEN || ""
  ).toLowerCase();
  const title = (
    typeof item === "string" ? item : item.title || ""
  ).toLowerCase();
  const matchTarget = titleEN || title;

  let bestCat = defaultCat;
  let bestMatchCount = 0;
  let bestMatchedKws = [];

  for (const cat of processedCats) {
    const matchedKws = cat._kwLower.filter((kw) => matchTarget.includes(kw));
    if (matchedKws.length > bestMatchCount) {
      bestMatchCount = matchedKws.length;
      bestCat = cat;
      bestMatchedKws = matchedKws;
    }
  }

  return {
    category: bestCat,
    matchCount: bestMatchCount,
    matchedKeywords: bestMatchedKws,
  };
}

function groupByCategory(items, categories, defaultCat) {
  const processedCats = preprocessCategories(categories);
  const groups = {};
  for (const item of items) {
    const cat = classify(item, processedCats, defaultCat);
    const key = cat.title;
    if (!groups[key])
      groups[key] = { icon: cat.icon, title: cat.title, items: [] };
    groups[key].items.push({
      title: item.title,
      link: item.link || "",
      source: item.source || "",
      ...(item.titleEN ? { titleEN: item.titleEN } : {}),
    });
  }
  return Object.values(groups);
}

function groupByCategoryWithConfidence(items, categories, defaultCat) {
  const processedCats = preprocessCategories(categories);
  const groups = {};
  const lowConfidenceItems = [];
  const LOW_CONFIDENCE_THRESHOLD = 1;

  for (const item of items) {
    const { category: cat, matchCount } = classifyWithConfidence(item, processedCats, defaultCat);
    const key = cat.title;
    if (!groups[key])
      groups[key] = { icon: cat.icon, title: cat.title, items: [] };

    const itemData = {
      title: item.title,
      link: item.link || "",
      source: item.source || "",
      ...(item.titleEN ? { titleEN: item.titleEN } : {}),
    };

    groups[key].items.push(itemData);

    if (cat.title !== defaultCat.title && matchCount <= LOW_CONFIDENCE_THRESHOLD) {
      lowConfidenceItems.push({
        ...itemData,
        currentCategory: cat.title,
        matchCount,
      });
    }
  }

  return {
    sections: Object.values(groups),
    lowConfidenceItems,
  };
}

async function llmClassify(items, categoryTitles) {
  const result = new Map();
  const BATCH = 20;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return result;

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const numbered = batch.map((it, j) => `${j + 1}. ${it.title}`).join("\n");
    const cats = categoryTitles.join("、");
    const bodyObj = {
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: `你是新闻分类引擎。将新闻标题分类到以下类别之一: ${cats}。如果都不匹配，输出"跳过"。输出JSON数组，每个元素是{"n":行号,"c":"类别名"}或{"n":行号,"c":"跳过"}。`,
        },
        { role: "user", content: numbered },
      ],
      temperature: 0.1,
      max_tokens: 800,
    };

    try {
      const res = await apiCall(
        "https://api.deepseek.com/v1/chat/completions",
        bodyObj,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 15000,
        },
      );

      const content = res?.choices?.[0]?.message?.content?.trim() || "";
      const jsonMatch = content.match(/\[.*\]/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const entry of parsed) {
          if (
            entry.c &&
            entry.c !== "跳过" &&
            entry.n >= 1 &&
            entry.n <= batch.length
          ) {
            result.set(batch[entry.n - 1].title, entry.c);
          }
        }
      }
    } catch {}
    if (i + BATCH < items.length) await new Promise((r) => setTimeout(r, 500));
  }
  return result;
}

/**
 * 执行分类流程（关键词分类 + LLM 二次分类）
 * @param {Array} allItems - 去重后的条目
 * @param {object} topic - 主题配置（含 categories, defaultCategory）
 * @returns {{ sections: Array, categoryMeta: Array }}
 */
async function classifyItems(allItems, topic) {
  let sections;
  let lowConfidenceItems = [];

  if (process.env.DEEPSEEK_API_KEY) {
    const result = groupByCategoryWithConfidence(
      allItems,
      topic.categories,
      topic.defaultCategory,
    );
    sections = result.sections;
    lowConfidenceItems = result.lowConfidenceItems;
  } else {
    sections = groupByCategory(
      allItems,
      topic.categories,
      topic.defaultCategory,
    );
  }

  const defaultCatTitle = topic.defaultCategory?.title || "其他资讯";
  const allCatTitles = topic.categories.map((c) => c.title);
  const itemsToReclassify = [];

  const otherSection = sections.find((s) => s.title === defaultCatTitle);
  if (otherSection && otherSection.items.length > 5) {
    itemsToReclassify.push(...otherSection.items.map((item) => ({
      ...item,
      sourceCategory: defaultCatTitle,
      reason: "default_category",
    })));
  }

  if (lowConfidenceItems.length > 0) {
    console.log(`  🔍 发现 ${lowConfidenceItems.length} 条低置信度分类条目`);
    itemsToReclassify.push(...lowConfidenceItems.map((item) => ({
      ...item,
      reason: "low_confidence",
    })));
  }

  if (itemsToReclassify.length > 0 && process.env.DEEPSEEK_API_KEY) {
    console.log(`\n🤖 LLM 辅助分类: ${itemsToReclassify.length} 条待验证条目...`);
    const reclassified = await llmClassify(itemsToReclassify, allCatTitles);
    if (reclassified.size > 0) {
      let movedCount = 0;
      for (const item of itemsToReclassify) {
        const newCat = reclassified.get(item.title);
        if (newCat && newCat !== item.sourceCategory) {
          if (item.sourceCategory) {
            const sourceSection = sections.find((s) => s.title === item.sourceCategory);
            if (sourceSection) {
              sourceSection.items = sourceSection.items.filter((i) => i.title !== item.title);
            }
          }
          const targetSection = sections.find((s) => s.title === newCat);
          if (targetSection) {
            targetSection.items.push({
              title: item.title,
              link: item.link || "",
              source: item.source || "",
              ...(item.titleEN ? { titleEN: item.titleEN } : {}),
            });
            movedCount++;
          }
        }
      }
      console.log(`  ✅ 已将 ${movedCount} 条重新分类`);
    }
  }

  return sections;
}

module.exports = {
  preprocessCategories,
  classify,
  classifyWithConfidence,
  groupByCategory,
  groupByCategoryWithConfidence,
  llmClassify,
  classifyItems,
};
