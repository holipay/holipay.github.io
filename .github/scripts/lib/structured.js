/**
 * 结构化输出解析和质量校验
 * 从 analyze.js 提取
 */

const { callDeepSeek } = require("./deepseek.js");

// ===== 解析结构化输出 =====
function parseStructuredOutput(rawAnalysis) {
  const defaultResult = {
    sentiment: "中性",
    riskLevel: "中",
    keyThemes: [],
    sectors: [],
    outlook: "",
    hotKeywords: [],
    eventChains: [],
  };

  try {
    // 查找 ---STRUCTURED--- 标记后的 JSON 块
    const marker = "---STRUCTURED---";
    const idx = rawAnalysis.indexOf(marker);
    if (idx === -1) return { analysis: rawAnalysis, structured: defaultResult };

    const analysisPart = rawAnalysis.slice(0, idx).trim();
    const structuredPart = rawAnalysis.slice(idx + marker.length);

    // 提取 JSON 块
    const jsonMatch = structuredPart.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch)
      return { analysis: analysisPart, structured: defaultResult };

    const parsed = JSON.parse(jsonMatch[1]);

    return {
      analysis: analysisPart,
      structured: {
        sentiment: ["看涨", "看跌", "中性", "分化"].includes(parsed.sentiment)
          ? parsed.sentiment
          : "中性",
        riskLevel: ["低", "中", "高"].includes(parsed.riskLevel)
          ? parsed.riskLevel
          : "中",
        keyThemes: Array.isArray(parsed.keyThemes)
          ? parsed.keyThemes.slice(0, 5).map(String)
          : [],
        sectors: Array.isArray(parsed.sectors)
          ? parsed.sectors.slice(0, 5).map(String)
          : [],
        outlook:
          typeof parsed.outlook === "string"
            ? parsed.outlook.slice(0, 200)
            : "",
        hotKeywords: Array.isArray(parsed.hotKeywords)
          ? parsed.hotKeywords.slice(0, 10)
          : [],
        eventChains: Array.isArray(parsed.eventChains)
          ? parsed.eventChains.slice(0, 10)
          : [],
      },
    };
  } catch (e) {
    console.warn(`⚠️ 结构化解析失败: ${e.message}，使用纯文本模式`);
    return { analysis: rawAnalysis, structured: defaultResult };
  }
}

// ===== P1-2: 输出质量校验 =====
function validateAnalysis(result) {
  const checks = {
    hasAnalysis: (result.analysis || "").length > 200,
    hasSentiment: ["看涨", "看跌", "分化", "中性"].includes(
      result.structured?.sentiment,
    ),
    hasRiskLevel: ["高", "中", "低"].includes(result.structured?.riskLevel),
    hasThemes: (result.structured?.keyThemes || []).length >= 1,
    hasOutlook: (result.structured?.outlook || "").length > 10,
    hasKeywords: (result.hotKeywords || []).length >= 1,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v);
  if (failed.length > 0) {
    console.warn(
      `\n⚠️ 质量检查: ${failed.length}/${Object.keys(checks).length} 项未通过:`,
    );
    failed.forEach(([k]) => console.warn(`  ❌ ${k}`));
    return { ok: false, failed: failed.map(([k]) => k) };
  }
  console.log("✅ 质量检查全部通过");
  return { ok: true, failed: [] };
}

// ===== P2-2: 结构化信号提取（第一次调用，轻量）=====
async function extractStructuredSignals(newsData, hotKeywords) {
  const titles = newsData.items
    .slice(0, 30)
    .map((i) => `- ${i.title} (${i.source})`)
    .join("\n");
  const kwStr = hotKeywords
    .slice(0, 10)
    .map((hk) => `${hk.keyword}(${hk.score})`)
    .join(", ");

  const prompt = `以下是今日新闻标题（${newsData.items.length} 条中的 30 条）和热点关键词。

热点关键词: ${kwStr}

新闻标题:
${titles}

请快速输出以下结构化信号（JSON格式，不要其他内容）:
{
  "sentiment": "看涨|看跌|分化|中性",
  "riskLevel": "高|中|低",
  "keyThemes": ["主题1", "主题2", "主题3"],
  "sectors": ["行业1", "行业2"],
  "outlook": "一句话前瞻（30字以内）"
}`;

  try {
    const raw = await callDeepSeek(
      prompt,
      "你是市场信号分析引擎。只输出JSON，不加任何解释。",
      300,
    );
    const jsonMatch = raw.match(/\{[^{}]*\}/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(
        `  📊 结构化信号: sentiment=${parsed.sentiment}, risk=${parsed.riskLevel}`,
      );
      return parsed;
    }
  } catch (e) {
    console.warn(`  ⚠️ 结构化信号提取失败: ${e.message}`);
  }
  return null;
}

module.exports = {
  parseStructuredOutput,
  validateAnalysis,
  extractStructuredSignals,
};
