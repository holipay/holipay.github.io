/**
 * Prompt 构建
 * 从 analyze.js 提取
 * 配置已外置到 configs/ 目录
 */

const fs = require("fs");
const path = require("path");
const { matchHotKeywords, dedupHotItems, extractHotKeywords } = require("./hotwords.js");
const { loadActiveEvents, buildEventChainSection } = require("./events.js");
const { extractThemes } = require("./memory.js");
const { extractKeyData } = require("./articles.js");

const CONFIGS_DIR = path.join(__dirname, "..", "configs");

// ===== 配置加载 =====
function loadDailyPerspectives() {
  try {
    const filePath = path.join(CONFIGS_DIR, "daily-perspectives.json");
    const config = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return config.perspectives || [];
  } catch (e) {
    console.warn(`⚠️ 无法加载每日视角配置: ${e.message}`);
    // 返回默认配置
    return [
      { day: 0, label: "周度复盘", instruction: "回顾本周新闻。", sectionHint: "## 📅 周度复盘" },
      { day: 1, label: "宏观全景", instruction: "聚焦全球经济格局。", sectionHint: "## 🌍 宏观全景" },
      { day: 2, label: "行业深潜", instruction: "垂直分析行业。", sectionHint: "## 🏭 行业深潜" },
      { day: 3, label: "逆向思考", instruction: "挑战市场共识。", sectionHint: "## 🔄 逆向思考" },
      { day: 4, label: "历史镜鉴", instruction: "与历史类比。", sectionHint: "## 📜 历史镜鉴" },
      { day: 5, label: "数据驱动", instruction: "用数字说话。", sectionHint: "## 📈 数据驱动" },
      { day: 6, label: "跨市场联动", instruction: "分析资产传导。", sectionHint: "## 🔗 跨市场联动" },
    ];
  }
}

const DAILY_PERSPECTIVES = loadDailyPerspectives();

// ===== 分析生成 =====
function buildPrompt(
  newsData,
  previousAnalyses,
  perspective,
  hotKeywords,
  snippets = [],
  trendSection = "",
) {
  const today = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  // 输出热点关键词日志
  if (hotKeywords.length > 0) {
    console.log("\n🔥 热点关键词 Top 15:");
    hotKeywords.slice(0, 10).forEach((hk, i) => {
      console.log(
        `   ${i + 1}. ${hk.keyword} (热度:${hk.score}, 频次:${hk.count}, 跨${hk.categories.length}个分类, 信源权重:${hk.sourceWeight || 1}${hk.domain ? ", 领域词" : ""})`,
      );
    });
  }

  // 按分类组织新闻
  const catMap = {};
  for (const item of newsData.items) {
    const cat = item.category || "其他";
    if (!catMap[cat]) catMap[cat] = [];
    catMap[cat].push(item);
  }
  const topHotKeywords = hotKeywords.slice(0, 10);

  // 分层：热点相关条目 vs 其他条目
  const rawHotItems = []; // 匹配热点关键词的条目
  const otherItems = []; // 其余条目
  for (const item of newsData.items) {
    const hotMatches = matchHotKeywords(item.title, topHotKeywords);
    if (hotMatches.length > 0) {
      rawHotItems.push({ ...item, hotTags: hotMatches });
    } else {
      otherItems.push(item);
    }
  }

  // 热点新闻去重：相似标题合并为一条附多信源
  const hotItems = dedupHotItems(rawHotItems);
  if (rawHotItems.length !== hotItems.length) {
    console.log(`  🔄 热点去重: ${rawHotItems.length} → ${hotItems.length} 条`);
  }

  // 热点新闻：完整展示（多信源合并标注）
  let hotNewsSection = "";
  if (hotItems.length > 0) {
    const lines = hotItems
      .map((i) => {
        const src =
          i.sources.length > 1 ? i.sources.join(", ") : i.source || "";
        return `  - ${i.title} (${src}) 🔥[${i.hotTags.join("+")}]`;
      })
      .join("\n");
    hotNewsSection = `【🔥 热点新闻（${hotItems.length} 条）】\n${lines}`;
  }

  // 其他新闻：按分类压缩为一行摘要
  const otherByCat = {};
  for (const item of otherItems) {
    const cat = item.category || "其他";
    if (!otherByCat[cat]) otherByCat[cat] = [];
    otherByCat[cat].push(item);
  }
  const otherLines = Object.entries(otherByCat).map(([cat, items]) => {
    const titles = items
      .slice(0, 3)
      .map((i) => i.title)
      .join("；");
    const more = items.length > 3 ? `等${items.length}条` : "";
    return `  ${cat}(${items.length}条): ${titles}${more}`;
  });
  const otherNewsSection =
    otherLines.length > 0
      ? `【📊 其他新闻摘要】\n${otherLines.join("\n")}`
      : "";

  const newsList = [hotNewsSection, otherNewsSection]
    .filter(Boolean)
    .join("\n\n");

  // 日志：分层统计
  console.log(
    `  📊 分层: ${hotItems.length} 条热点新闻（完整展示），${otherItems.length} 条其他新闻（摘要）`,
  );

  // 构建热点关键词 section
  let hotKeywordsSection = "";
  if (topHotKeywords.length > 0) {
    const kwList = topHotKeywords
      .map((hk, i) => {
        const catInfo = hk.categories.join("、");
        const swInfo = hk.sourceWeight ? `，信源权重${hk.sourceWeight}` : "";
        return `  ${i + 1}. **${hk.keyword}** — 热度 ${hk.score}（出现 ${hk.count} 次，跨 ${catInfo}${swInfo}）${hk.domain ? " ⭐领域关键词" : ""}`;
      })
      .join("\n");

    hotKeywordsSection = `

━━━ 🔥 热点关键词排行（按热度加权，必须重点关注）━━━
${kwList}

说明: 热度 = 频次 × 跨分类覆盖度 × 领域加权。新闻列表中 🔥 标记表示该条新闻与热点关键词相关。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  // 文章内容 section（分层展示）
  let snippetsSection = "";
  if (snippets.length > 0) {
    const tier1 = snippets.filter((s) => s.tier === 1);
    const tier2 = snippets.filter((s) => s.tier === 2);
    const tier3 = snippets.filter((s) => s.tier === 3);
    const tierParts = [];

    if (tier1.length > 0) {
      const tier1Text = tier1
        .map((s) => {
          const keyData = extractKeyData(s.snippet);
          return `  ▸ 【${s.keyword}】${s.title} (${s.source})\n    摘要: ${s.snippet}${keyData ? "\n    关键数据: " + keyData : ""}`;
        })
        .join("\n\n");
      tierParts.push(
        `【🔥🔥🔥 Tier 1 - 核心话题（${tier1.length} 篇）】\n${tier1Text}`,
      );
    }
    if (tier2.length > 0) {
      const tier2Text = tier2
        .map(
          (s) =>
            `  ▸ 【${s.keyword}】${s.title} (${s.source})\n    ${s.snippet}`,
        )
        .join("\n\n");
      tierParts.push(
        `【🔥🔥 Tier 2 - 重要话题（${tier2.length} 篇）】\n${tier2Text}`,
      );
    }
    if (tier3.length > 0) {
      const tier3Text = tier3
        .map(
          (s) => `  ▸ ${s.keyword}: ${s.title} — ${s.snippet.slice(0, 150)}...`,
        )
        .join("\n");
      tierParts.push(
        `【🔥 Tier 3 - 补充（${tier3.length} 篇简要）】\n${tier3Text}`,
      );
    }

    snippetsSection = `

━━━ 📄 深度文章内容（按权重分层抓取）━━━
${tierParts.join("\n\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  let memorySection = "";
  if (previousAnalyses.length > 0) {
    const memoryParts = previousAnalyses.map((prev) => {
      const { themes, summaries } = extractThemes(prev.analysis);
      const themeList =
        themes.length > 0 ? themes.join("、") : "（无明确主题）";
      const summaryText = summaries.length > 0 ? summaries.join("\n") : "";
      return `【${prev.date}】\n已覆盖主题: ${themeList}\n内容摘要:\n${summaryText}`;
    });

    memorySection = `

━━━ 历史分析记忆（请务必避免重复以下内容）━━━
${memoryParts.join("\n\n")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  // 事件链上下文
  const events = loadActiveEvents();
  const eventChainSection = buildEventChainSection(events);

  const perspectiveSection = `

━━━ 今日分析视角（方法论）: ${perspective.label} ━━━
${perspective.instruction}
注意: 此视角是「分析方法论」——用这个方法去分析上面的热点关键词和新闻，而不是另起话题。热点关键词决定「分析什么」，视角决定「怎么分析」。`;

  return `请对以下最新新闻进行综合深度分析（日期: ${today}）。

新闻列表（🔥 热点新闻详细展示 + 其他新闻摘要）:
${newsList}
${hotKeywordsSection}
${snippetsSection}
${trendSection}
${eventChainSection}
${memorySection}
${perspectiveSection}

请从以下角度进行分析，输出 Markdown 格式:

## 📌 今日要点
用 2-3 句话概括今天最重要的动态。**优先聚焦 🔥 热点关键词对应的事件。**

## 🔍 深度解读
针对最重要的 2-3 个趋势或事件，进行深入分析（每个 100-200 字）。**热度越高的关键词，分析深度和篇幅应越大。**
${perspective.sectionHint}

## 📊 市场信号
分析这些新闻对市场/行业的影响信号（看涨/看跌/中性）。**对热点关键词涉及的行业/市场单独标注信号强度。**

## ⚠️ 风险提示
需要关注的潜在风险或不确定性。

## 🔮 前瞻展望
基于今日信息，对短期（1-2 周）走势的判断。

重要要求:
1. 上面的「历史分析记忆」列出了前几次分析已覆盖的主题和内容。请**避免重复相同的角度、相同的论点、相同的叙事框架**。如果某个主题已被分析过，要么从新角度切入，要么直接跳过，聚焦于被忽略的方面。
2. 如果历史分析中出现过「K型经济」「脱钩」「旧经济」等已反复讨论的概念，请寻找新的分析维度，而不是换汤不换药地重述。
3. 今天的分析视角是「${perspective.label}」，这是你的**分析方法论**。用这个视角去审视热点关键词涉及的事件，而不是脱离热点另选话题。例如：如果是「数据驱动」视角，就用数据角度解读热点；如果是「逆向思考」，就对热点的市场共识提出反面论据。
4. 新闻覆盖了多个领域（金融、科技、社科、健康、环境等），不要只盯着股市和宏观经济，请关注更广泛的议题。
5. 保持客观、专业，有独到见解，不要泛泛而谈。
6. **🔥 热点关键词加权**: 上面列出了今日热点关键词排行及其热度分数。请对热度高的关键词给予更高的分析权重——它们代表了今日新闻中反复出现的核心主题。分析时应: (a) 优先围绕热点关键词展开深度解读; (b) 对热点涉及的行业/市场做更细致的信号分析; (c) 在前瞻展望中重点回应热点趋势的走向。

最后，在分析正文结束后，另起一行输出一个结构化摘要，格式如下（严格遵守，不要加任何多余文字）:

---STRUCTURED---
\`\`\`json
{
  "sentiment": "看涨|看跌|中性|分化",
  "riskLevel": "低|中|高",
  "keyThemes": ["主题1", "主题2", "主题3"],
  "sectors": ["行业1", "行业2"],
  "outlook": "一句话前瞻判断",
  "hotKeywords": ${JSON.stringify(topHotKeywords.slice(0, 5).map((hk) => ({ keyword: hk.keyword, score: hk.score })))},
  "eventChains": [{"id": "已有事件ID或留空", "title": "事件名称", "summary": "今日进展", "keywords": ["关键词"], "status": "active|resolved"}]
}
\`\`\`

字段说明:
- sentiment: 今日整体市场情绪倾向
- riskLevel: 当前市场风险等级
- keyThemes: 3-5 今日最核心的主题关键词
- sectors: 今日新闻涉及的主要行业/赛道
- outlook: 对未来 1-2 周的一句话核心判断
- hotKeywords: 今日热点关键词及其热度分数（原样输出上面的数组即可）
- eventChains: 事件链更新。如果今日新闻是某个活跃事件的后续发展，填入该事件的 id 并更新 summary。如果是全新重大事件，新建一条（id留空）。如果没有相关事件，输出空数组 []。`;
}

// 构建月度回顾 prompt
function buildMonthlyReviewPrompt(analyses, todayNewsData, monthStr) {
  // 每日分析摘要
  const dailySummaries = analyses
    .map((a) => {
      const themes = (a.structured?.keyThemes || []).join(", ");
      const sentiment = a.structured?.sentiment || "";
      const risk = a.structured?.riskLevel || "";
      const outlook = a.structured?.outlook || "";
      const bodySlice = (a.analysis || "").slice(0, 400);
      return `### ${a.date} [${a.perspective}] | 情绪:${sentiment} | 风险:${risk}
主题: ${themes}
展望: ${outlook}
摘要: ${bodySlice}`;
    })
    .join("\n\n---\n\n");

  // 月度热点词频
  const topicFreq = {};
  for (const a of analyses) {
    for (const hk of a.hotKeywords || []) {
      const kw = hk.keyword || hk;
      topicFreq[kw] = (topicFreq[kw] || 0) + (hk.score || 1);
    }
  }
  const topTopics = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([kw, score]) => `${kw}(${Math.round(score)})`)
    .join(", ");

  // ===== 异常检测数据准备 =====
  const anomalyLines = [];

  // 1. 情绪急转检测
  for (let i = 1; i < analyses.length; i++) {
    const prev = analyses[i - 1];
    const curr = analyses[i];
    const ps = prev.structured?.sentiment;
    const cs = curr.structured?.sentiment;
    if (ps && cs && ps !== cs && ps !== "中性" && cs !== "中性") {
      anomalyLines.push(
        `  - 🔄 情绪急转 [${prev.date}→${curr.date}]: ${ps}→${cs}`,
      );
    }
  }

  // 2. 关键词异动检测（后半段首次出现且高分）
  const firstHalf = analyses.slice(0, Math.floor(analyses.length / 2));
  const secondHalf = analyses.slice(Math.floor(analyses.length / 2));
  const firstHalfKws = new Set();
  for (const a of firstHalf) {
    for (const hk of a.hotKeywords || []) firstHalfKws.add(hk.keyword || hk);
  }
  const emergingKws = [];
  for (const a of secondHalf) {
    for (const hk of a.hotKeywords || []) {
      const kw = hk.keyword || hk;
      const score = typeof hk === "object" ? hk.score : 1;
      if (!firstHalfKws.has(kw) && score > 5) {
        emergingKws.push({ keyword: kw, score, date: a.date });
      }
    }
  }
  const topEmerging = [
    ...new Map(emergingKws.map((e) => [e.keyword, e])).values(),
  ]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  for (const e of topEmerging) {
    anomalyLines.push(
      `  - 🔥 新主题涌现 [${e.date}]: ${e.keyword}（热度 ${e.score}）`,
    );
  }

  // 3. 风险升级检测
  for (let i = 1; i < analyses.length; i++) {
    const prev = analyses[i - 1];
    const curr = analyses[i];
    const pr = prev.structured?.riskLevel;
    const cr = curr.structured?.riskLevel;
    if (pr && cr && pr !== "高" && cr === "高") {
      anomalyLines.push(`  - ⚠️ 风险升级 [${curr.date}]: ${pr}→高`);
    }
  }

  const anomalySection =
    anomalyLines.length > 0
      ? anomalyLines.join("\n")
      : "  （本月未检测到显著异常信号）";

  // 今日新闻（如有）
  let todaySection = "";
  if (todayNewsData && todayNewsData.items && todayNewsData.items.length > 0) {
    const hotKw = extractHotKeywords(todayNewsData.items, 10);
    const lines = todayNewsData.items
      .slice(0, 20)
      .map((i) => `  - ${i.title} (${i.source})`)
      .join("\n");
    todaySection = `\n\n━━━ 📰 今日新增新闻（${todayNewsData.items.length} 条）━━━\n${lines}`;
    if (hotKw.length > 0) {
      todaySection += `\n今日热点: ${hotKw
        .slice(0, 5)
        .map((hk) => `${hk.keyword}(${hk.score})`)
        .join(", ")}`;
    }
  }

  return `以下是 ${monthStr} 期间的每日AI深度分析记录（共 ${analyses.length} 天）：

## 每日分析记录

${dailySummaries}

## 月度热点词频（加权）
${topTopics}

## 本月异常信号
${anomalySection}
${todaySection}

---

请基于以上所有数据，生成一份 **${monthStr} 月度深度回顾**。你需要从两个维度分析：

### 维度一：宏观深度分析

从本月碎片化的每日分析中，提炼更高层次的洞察：

1. **🔑 本月核心叙事**（3-5个）：最重要的主题演变，找出背后的叙事逻辑，不是简单罗列热点
2. **📈 市场与经济脉络**：全球市场走势、关键数据、央行政策的系统性梳理
3. **🔗 跨领域联动**：不同领域（科技、金融、地缘、社会）之间的相互影响
4. **🔄 趋势与转折**：哪些趋势在加速？哪些出现反转？
5. **🔮 下月前瞻**：基于本月走势，下月最需要关注什么？

### 维度二：AI 自我纠错回顾

回顾本月每日的分析判断，进行诚实的自我评估：

1. **✅ 正确判断**：哪些分析在事后被验证正确？具体哪天、什么观点？
2. **❌ 偏离判断**：哪些分析偏离了实际情况？原因是什么？
3. **⚠️ 遗漏信号**：有哪些重要事件或趋势是AI分析未能捕捉的？
4. **📊 整体准确度**：本月分析整体质量如何？哪些视角最有价值？
5. **💡 改进方向**：未来分析应加强哪些方面？

### 维度三：异常信号深度解读

上面「本月异常信号」列出了系统自动检测到的异常。请对每个异常进行深度分析：

1. **异常原因**：是什么导致了这个异常？背后的驱动因素是什么？
2. **影响评估**：这个异常对市场/行业/社会的实际影响有多大？
3. **是噪音还是信号**：这个异常是短期波动还是结构性变化的前兆？
4. **关联分析**：多个异常之间是否存在内在联系？

### 维度四：月度深度专题

从本月热点关键词中选出最值得关注的 2-3 个主题，进行垂直深度分析：

对每个专题：
1. **演变脉络**：该主题在本月的时间线发展
2. **驱动因素**：背后的推动力是什么（政策、技术、市场情绪？）
3. **关键参与者**：涉及的主要公司、国家、机构
4. **联动关系**：与其他主题/领域的相互影响
5. **下月展望**：该主题接下来最可能的走向

请确保分析有深度、有独到见解。自我纠错部分要诚实具体，不回避错误。输出 Markdown 格式。`;
}

module.exports = {
  DAILY_PERSPECTIVES,
  buildPrompt,
  buildMonthlyReviewPrompt,
};
