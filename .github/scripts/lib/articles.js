/**
 * 文章抓取和内容处理
 * 从 analyze.js 提取
 */

const https = require("https");
const http = require("http");
const { translateSnippets } = require("./translation.js");
const { getSourceWeight, NOISE_KEYWORDS } = require("./hotwords.js");
const { getDateOffset } = require("./date-utils.js");

// ===== URL 内容抓取（用于文章摘要）=====
function fetchUrlText(url, maxChars = 500) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === "https:" ? https : http;
      const req = mod.get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          timeout: 10000,
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            fetchUrlText(res.headers.location, maxChars).then(resolve);
            return;
          }
          // 跳过付费墙 (402/403) 和需要登录的页面
          if (res.statusCode === 402 || res.statusCode === 403) {
            resolve("");
            return;
          }
          if (res.statusCode !== 200) {
            resolve("");
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            const text = cleanHtmlContent(raw);
            resolve(truncateAtSentence(text, maxChars));
          });
        },
      );
      req.on("error", () => resolve(""));
      req.on("timeout", () => {
        req.destroy();
        resolve("");
      });
    } catch {
      resolve("");
    }
  });
}

// HTML 内容清洗（提取正文，移除样板文本）
function cleanHtmlContent(html) {
  // 移除 script/style/nav/footer/header
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  // 尝试提取 article 或 main 内容
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch) text = articleMatch[1];
  else if (mainMatch) text = mainMatch[1];

  // 去 HTML 标签
  text = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // 移除常见样板文本
  const boilerplatePatterns = [
    /cookie[s]?\s*(policy|notice|consent|preferences)?\s*[:.]?\s*.{0,100}(accept|agree|reject|manage|settings|click|continue).{0,50}/gi,
    /subscribe\s*(to|for|now|today|here)?\s*[:.]?\s*.{0,80}(newsletter|email|updates|free|trial)/gi,
    /sign\s*up\s*(for|to|now)?\s*[:.]?\s*.{0,60}(newsletter|email|updates|free|trial|account)/gi,
    /(please|click)\s+(here|below|subscribe|sign up).{0,50}/gi,
    /advertisement\s*/gi,
    /sponsored\s*(content|by)?\s*/gi,
    /read\s*more\s*(→|>|»|\.\.\.)?/gi,
    /continue\s*reading\s*(→|>|»|\.\.\.)?/gi,
    /share\s*(this|on)\s*(facebook|twitter|linkedin|x)/gi,
    /follow\s*us\s*(on|at)\s*/gi,
    /©\s*\d{4}\s*.{0,50}(rights|reserved)/gi,
    /all\s*rights\s*reserved/gi,
    /terms\s*(of|&)\s*(use|service|conditions)/gi,
    /privacy\s*policy/gi,
  ];
  for (const pattern of boilerplatePatterns) {
    text = text.replace(pattern, "");
  }

  return text.replace(/\s+/g, " ").trim();
}

// 按句子边界截断
function truncateAtSentence(text, maxChars) {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastPeriod = Math.max(
    truncated.lastIndexOf("."),
    truncated.lastIndexOf("。"),
    truncated.lastIndexOf("!"),
    truncated.lastIndexOf("！"),
    truncated.lastIndexOf("?"),
    truncated.lastIndexOf("？"),
  );
  if (lastPeriod > maxChars * 0.6) {
    return truncated.slice(0, lastPeriod + 1);
  }
  return truncated + "...";
}

// 从文章正文中提取关键数据点（数字、百分比、引述）
function extractKeyData(text) {
  const dataPoints = [];
  const pcts = text.match(/\d+\.?\d*\s*%/g);
  if (pcts && pcts.length > 0)
    dataPoints.push(`百分比: ${pcts.slice(0, 3).join(", ")}`);
  const amounts = text.match(/\$\s*\d+[\d,.]*\s*(billion|million|trillion)?/gi);
  if (amounts && amounts.length > 0)
    dataPoints.push(`金额: ${amounts.slice(0, 3).join(", ")}`);
  const quotes = text.match(/[""「]([^""」]{20,120})[""」]/g);
  if (quotes && quotes.length > 0)
    dataPoints.push(`引述: ${quotes[0].slice(0, 100)}`);
  return dataPoints.join(" | ");
}

/**
 * 按权重分层抓取文章内容
 * Tier 1 (热度 Top 3): 3篇×1500字  Tier 2 (4-8): 2篇×800字  Tier 3 (9-15): 1篇×300字
 * 评分公式：keywordScore × sourceWeight × recencyDecay
 */
async function fetchWeightedArticles(hotKeywords, items) {
  const TIER_CONFIG = [
    { maxRank: 3, articlesPerKw: 3, charsPerArticle: 1500 },
    { maxRank: 8, articlesPerKw: 2, charsPerArticle: 800 },
    { maxRank: 15, articlesPerKw: 1, charsPerArticle: 300 },
  ];
  const TOTAL_BUDGET = 18000;
  let usedBudget = 0;
  const results = [];
  const fetchedUrls = new Set();

  function scoreArticle(item, keywordScore) {
    const sourceWeight = getSourceWeight(item.source || "");
    const today = new Date().toLocaleDateString("sv-SE", {
      timeZone: "Asia/Shanghai",
    });
    const itemDate = item.date || "";
    let recency = 0.3;
    if (itemDate === today) recency = 1.0;
    else if (itemDate >= getDateOffset(-1)) recency = 0.7;
    else if (itemDate >= getDateOffset(-2)) recency = 0.5;
    return keywordScore * sourceWeight * recency;
  }

  for (let tierIdx = 0; tierIdx < TIER_CONFIG.length; tierIdx++) {
    const tier = TIER_CONFIG[tierIdx];
    const prevMax = tierIdx === 0 ? 0 : TIER_CONFIG[tierIdx - 1].maxRank;
    const tierKws = hotKeywords.filter(
      (_, i) => i + 1 > prevMax && i + 1 <= tier.maxRank,
    );

    for (const hk of tierKws) {
      if (usedBudget >= TOTAL_BUDGET) break;
      const kwLower = hk.keyword.toLowerCase();
      const totalMatched = items.filter((i) =>
        (i.title || "").toLowerCase().includes(kwLower),
      ).length;
      const withLink = items.filter(
        (i) =>
          (i.title || "").toLowerCase().includes(kwLower) && i.link,
      ).length;
      const candidates = items.filter((i) => {
        const lower = (i.title || "").toLowerCase();
        if (
          !lower.includes(kwLower) ||
          !i.link ||
          fetchedUrls.has(i.link)
        )
          return false;
        for (const noise of NOISE_KEYWORDS) {
          if (lower.includes(noise.toLowerCase())) return false;
        }
        return true;
      });
      if (candidates.length === 0) {
        console.log(
          `  ⚠️ [Tier ${tierIdx + 1}] ${hk.keyword} → 0 候选 (标题匹配:${totalMatched}, 有链接:${withLink})`,
        );
        continue;
      }
      console.log(
        `  🔍 [Tier ${tierIdx + 1}] ${hk.keyword} → ${candidates.length} 候选 (标题匹配:${totalMatched})`,
      );
      candidates.sort(
        (a, b) => scoreArticle(b, hk.score) - scoreArticle(a, hk.score),
      );

      const selected = [];
      for (const c of candidates) {
        if (selected.length >= tier.articlesPerKw) break;
        const src = c.source || "unknown";
        if (selected.filter((s) => s.source === src).length >= 2) continue;
        selected.push(c);
      }

      for (const item of selected) {
        if (usedBudget >= TOTAL_BUDGET) break;
        const charsToFetch = Math.min(
          tier.charsPerArticle,
          TOTAL_BUDGET - usedBudget,
        );
        console.log(
          `  📄 [Tier ${tierIdx + 1}] ${hk.keyword} → ${item.link.slice(0, 60)}...`,
        );
        const text = await fetchUrlText(item.link, charsToFetch);
        if (text && text.length > 50) {
          fetchedUrls.add(item.link);
          usedBudget += text.length;
          results.push({
            keyword: hk.keyword,
            score: hk.score,
            tier: tierIdx + 1,
            title: item.title,
            source: item.source || "",
            link: item.link || "",
            snippet: text,
            chars: text.length,
          });
          console.log(
            `     ✅ ${text.length} 字 (累计 ${usedBudget}/${TOTAL_BUDGET})`,
          );
        } else {
          console.log(`     ⚠️ 内容过短或抓取失败`);
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  console.log(`  📊 文章抓取完成: ${results.length} 篇, 共 ${usedBudget} 字`);

  // 翻译英文摘要为中文
  if (results.length > 0) {
    await translateSnippets(results);
  }

  return results;
}

module.exports = {
  fetchWeightedArticles,
  fetchUrlText,
  cleanHtmlContent,
  extractKeyData,
};
