/**
 * AI 深度分析脚本
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
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_URL = "https://api.deepseek.com";
const MAX_ITEMS = 50;
const MODEL = "deepseek-v4-pro";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 3000; // 3s, 6s, 12s

if (!API_KEY) {
  console.error("❌ 缺少 DEEPSEEK_API_KEY 环境变量");
  process.exit(1);
}

const DATA_DIR = path.join(ROOT, "data/news");
const ANALYSIS_DIR = path.join(DATA_DIR, "analysis");

// ===== 每日视角配置 =====
const DAILY_PERSPECTIVES = [
  {
    day: 0,
    label: "周度复盘",
    instruction:
      "今天是周日，请做「周度复盘」。回顾本周新闻的主要叙事线，提炼出本周最关键的 2-3 个转折点或主题演变，判断哪些是噪音、哪些是真正的信号。与前几周对比，趋势是在加速还是反转？",
    sectionHint: "## 📅 周度复盘\n提炼本周核心主题和转折点。",
  },
  {
    day: 1,
    label: "宏观全景",
    instruction:
      "今天是周一，请从「宏观全景」视角出发。聚焦全球经济格局、央行政策走向、地缘政治大图。不要局限于单一市场，把美股、A股、欧洲、新兴市场放在同一张地图上看。哪些力量在同步？哪些在分化？",
    sectionHint: "## 🌍 宏观全景\n跨市场、跨区域的全局视角。",
  },
  {
    day: 2,
    label: "行业深潜",
    instruction:
      "今天是周二，请做「行业深潜」。从今天新闻中挑出 1-2 个最值得关注的行业/赛道，做垂直分析：产业链上下游在发生什么？竞争格局有何变化？哪些公司受益/受损？不要泛泛谈大盘，深入到行业逻辑里去。",
    sectionHint: "## 🏭 行业深潜\n聚焦 1-2 个行业的垂直分析。",
  },
  {
    day: 3,
    label: "逆向思考",
    instruction:
      "今天是周三，请做「逆向思考」。当前市场共识是什么？这个共识的盲点在哪里？专门找反面论据和被忽略的数据点。如果市场是错的，最可能错在哪里？魔鬼代言人视角。",
    sectionHint: "## 🔄 逆向思考\n挑战市场共识，寻找盲点。",
  },
  {
    day: 4,
    label: "历史镜鉴",
    instruction:
      "今天是周四，请做「历史镜鉴」。将当前市场环境与历史上类似时期进行对比（如 2000 年互联网泡沫、2008 年金融危机、2020 年疫情等）。哪些相似？哪些不同？历史能告诉我们什么？注意不要简单类比，要分析结构性差异。",
    sectionHint: "## 📜 历史镜鉴\n与历史类比，找规律与差异。",
  },
  {
    day: 5,
    label: "数据驱动",
    instruction:
      "今天是周五，请做「数据驱动」分析。重点关注新闻中的具体数字、统计数据、趋势线。哪些数据在发出信号？哪些数据被市场忽略了？用数字说话，减少主观判断，多用对比和量化。",
    sectionHint: "## 📈 数据驱动\n用数字和统计说话。",
  },
  {
    day: 6,
    label: "跨市场联动",
    instruction:
      "今天是周六，请做「跨市场联动」分析。股票、债券、外汇、大宗商品、加密货币之间的传导关系是什么？哪个市场在领先？哪个在跟随？资金在往哪里流动？汇率和利率的变化如何影响风险偏好？",
    sectionHint: "## 🔗 跨市场联动\n分析资产间的传导和资金流向。",
  },
];

// ===== HTTP 请求 =====
function apiCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(urlPath);
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "NASE-Bot/1.0",
      },
      timeout: 120000,
    };
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ error: raw, status: res.statusCode });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("API timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function callDeepSeek(prompt, customSystemPrompt, maxTokens) {
  let lastError = null;

  const systemContent =
    customSystemPrompt ||
    [
      "你是一位专业的新闻分析师，擅长多角度深度分析。",
      "你的分析必须有独到见解，拒绝套话和模板化表达。",
      "每次分析都要带来新的思考角度，而不是重复市场共识。",
      "输出纯文本格式，使用 Markdown 标记。",
    ].join("");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await apiCall("POST", `${API_URL}/v1/chat/completions`, {
        model: MODEL,
        messages: [
          {
            role: "system",
            content: systemContent,
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.8,
        max_tokens: maxTokens || (customSystemPrompt ? 5000 : 2500),
      });

      if (res.error) {
        const errStr =
          typeof res.error === "string" ? res.error : JSON.stringify(res.error);
        throw new Error(`API error: ${errStr.slice(0, 200)}`);
      }

      const content = res.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty response from API");

      return content;
    } catch (e) {
      lastError = e;
      const isRetryable =
        e.message.includes("timeout") ||
        e.message.includes("Timeout") ||
        e.message.includes("HTTP 5") ||
        e.message.includes("ECONNRESET") ||
        e.message.includes("ETIMEDOUT") ||
        e.message.includes("Empty response");

      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.warn(
          `⚠️ 第 ${attempt} 次调用失败 (${e.message})，${delay / 1000}s 后重试...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw e;
    }
  }

  throw lastError;
}

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

// 辅助：获取 N 天前的日期字符串
function getDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
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
      const candidates = items.filter((i) => {
        const lower = (i.title || "").toLowerCase();
        return (
          lower.includes(hk.keyword.toLowerCase()) &&
          i.link &&
          !fetchedUrls.has(i.link)
        );
      });
      if (candidates.length === 0) continue;
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
  return results;
}

// ===== 跨日趋势追踪 =====
const TRENDS_FILE = path.join(ANALYSIS_DIR, "trends.json");
const TRENDS_RETENTION_DAYS = 14;

function loadPreviousTrends(currentDateStr) {
  if (!fs.existsSync(TRENDS_FILE)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(TRENDS_FILE, "utf-8"));
    return all.filter((t) => t.date < currentDateStr).slice(-3); // 最近 3 次
  } catch {
    return [];
  }
}

function saveTrends(dateStr, hotKeywords) {
  let all = [];
  try {
    if (fs.existsSync(TRENDS_FILE)) {
      all = JSON.parse(fs.readFileSync(TRENDS_FILE, "utf-8"));
    }
  } catch {
    all = [];
  }

  // 去重（同一天不重复写入）
  all = all.filter((t) => t.date !== dateStr);
  all.push({
    date: dateStr,
    keywords: hotKeywords.slice(0, 10).map((hk) => ({
      keyword: hk.keyword,
      score: hk.score,
      count: hk.count,
    })),
  });

  // 清理旧数据
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TRENDS_RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  all = all.filter((t) => t.date >= cutoffStr);
  all.sort((a, b) => a.date.localeCompare(b.date));

  const tmp = TRENDS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf-8");
  fs.renameSync(tmp, TRENDS_FILE);
}

function buildTrendSection(currentHotKeywords, previousTrends) {
  if (previousTrends.length === 0) return "";

  // 构建历史关键词 map: keyword -> [{date, score}]
  const historyMap = new Map();
  for (const trend of previousTrends) {
    for (const kw of trend.keywords) {
      if (!historyMap.has(kw.keyword)) historyMap.set(kw.keyword, []);
      historyMap.get(kw.keyword).push({ date: trend.date, score: kw.score });
    }
  }

  const trendLines = [];
  for (const hk of currentHotKeywords.slice(0, 10)) {
    const history = historyMap.get(hk.keyword);
    if (!history || history.length === 0) {
      trendLines.push(
        `  - **${hk.keyword}**: 当前热度 ${hk.score}（🆕 新热点）`,
      );
      continue;
    }
    const lastScore = history[history.length - 1].score;
    const lastDate = history[history.length - 1].date;
    const delta = hk.score - lastScore;
    const pct = lastScore > 0 ? Math.round((delta / lastScore) * 100) : 0;
    const arrow = delta > 2 ? "🔺" : delta < -2 ? "🔻" : "➡️";
    const trendDesc =
      delta > 2
        ? `上升 ${pct}%`
        : delta < -2
          ? `下降 ${Math.abs(pct)}%`
          : "持平";
    trendLines.push(
      `  - **${hk.keyword}**: ${hk.score}（${arrow} vs ${lastDate}: ${lastScore} → ${trendDesc}）`,
    );
  }

  if (trendLines.length === 0) return "";

  return `

━━━ 📈 热点趋势变化（与近期对比）━━━
${trendLines.join("\n")}
说明: 🔺 = 热度上升，🔻 = 热度下降，➡️ = 基本持平，🆕 = 首次出现
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// ===== 事件链追踪 =====
const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const MAX_ACTIVE_EVENTS = 20;
const EVENT_STALE_DAYS = 7; // 超过7天无更新自动归档

function loadActiveEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
    return all.filter((e) => e.status === "active");
  } catch {
    return [];
  }
}

function buildEventChainSection(events) {
  if (events.length === 0) return "";
  const lines = events.map((e) => {
    const last = e.timeline[e.timeline.length - 1];
    const days = Math.round((new Date() - new Date(e.firstSeen)) / 86400000);
    return `  - **${e.title}**（${days}天前起始，${e.timeline.length}条动态）→ 最新: ${last.summary}`;
  });
  return `

━━━ 🔗 活跃事件链（跟踪中的持续性事件）━━━
${lines.join("\n")}
说明: 如果今日新闻中有这些事件的后续发展，请在 eventChains 中标注 event_id 并更新。如果事件已结束，标记 status="resolved"。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function updateEvents(existingEvents, eventChains, dateStr, sentiment) {
  if (!Array.isArray(eventChains)) return existingEvents;
  const eventMap = new Map(existingEvents.map((e) => [e.id, e]));

  for (const chain of eventChains) {
    if (chain.status === "resolved" && chain.id && eventMap.has(chain.id)) {
      eventMap.get(chain.id).status = "resolved";
      eventMap.get(chain.id).lastSeen = dateStr;
      continue;
    }
    const summary = chain.summary || "";
    if (!summary) continue;

    if (chain.id && eventMap.has(chain.id)) {
      // 更新已有事件
      const evt = eventMap.get(chain.id);
      evt.timeline.push({ date: dateStr, summary, sentiment });
      evt.lastSeen = dateStr;
      if (chain.keywords)
        evt.relatedKeywords = [
          ...new Set([...evt.relatedKeywords, ...chain.keywords]),
        ];
    } else {
      // 新事件
      const id = `evt-${dateStr}-${(chain.title || summary).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "").slice(0, 20)}`;
      eventMap.set(id, {
        id,
        title: chain.title || summary.slice(0, 40),
        firstSeen: dateStr,
        lastSeen: dateStr,
        status: "active",
        timeline: [{ date: dateStr, summary, sentiment }],
        relatedKeywords: chain.keywords || [],
      });
    }
  }

  // 自动归档超期事件
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - EVENT_STALE_DAYS);
  const cutoffStr = staleCutoff.toISOString().slice(0, 10);
  for (const [, evt] of eventMap) {
    if (evt.status === "active" && evt.lastSeen < cutoffStr) {
      evt.status = "stale";
    }
  }

  // 限制活跃事件数
  const all = [...eventMap.values()];
  const active = all.filter((e) => e.status === "active");
  if (active.length > MAX_ACTIVE_EVENTS) {
    active.sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    const toArchive = active.slice(0, active.length - MAX_ACTIVE_EVENTS);
    for (const e of toArchive) e.status = "stale";
  }

  return all;
}

function saveEvents(events) {
  const tmp = EVENTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2), "utf-8");
  fs.renameSync(tmp, EVENTS_FILE);
}

// ===== 信号仪表盘 =====
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
        allItems.push({
          title: item.title,
          link: item.link || "",
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

// ===== 加载历史分析（用于记忆注入）=====
function loadPreviousAnalyses(currentDateStr, count = 2) {
  const indexPath = path.join(ANALYSIS_DIR, "index.json");
  if (!fs.existsSync(indexPath)) return [];

  let dates = [];
  try {
    dates = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch {
    return [];
  }

  const prevDates = dates.filter((d) => d < currentDateStr);
  if (prevDates.length === 0) return [];

  // 加载所有历史分析（用于语义匹配）
  const allAnalyses = [];
  for (const d of prevDates) {
    const filePath = path.join(ANALYSIS_DIR, `${d}.json`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      allAnalyses.push({
        date: d,
        analysis: data.analysis || "",
        structured: data.structured || {},
        hotKeywords: data.hotKeywords || [],
      });
    } catch {}
  }

  return allAnalyses;
}

// ===== 语义匹配：基于结构化数据的轻量级检索 =====
function computeRelevance(target, candidate) {
  let score = 0;
  const targetThemes = new Set(
    (target.keyThemes || []).map((t) => t.toLowerCase()),
  );
  const targetSectors = new Set(
    (target.sectors || []).map((s) => s.toLowerCase()),
  );
  const targetKws = new Set(
    (target.hotKeywords || []).map((hk) => (hk.keyword || hk).toLowerCase()),
  );
  const candidateThemes = (candidate.structured?.keyThemes || []).map((t) =>
    t.toLowerCase(),
  );
  const candidateSectors = (candidate.structured?.sectors || []).map((s) =>
    s.toLowerCase(),
  );
  const candidateKws = (candidate.hotKeywords || []).map((hk) =>
    (hk.keyword || hk).toLowerCase(),
  );

  // 主题匹配（权重 3）
  for (const t of candidateThemes) {
    if (targetThemes.has(t)) score += 3;
  }

  // 行业匹配（权重 2）
  for (const s of candidateSectors) {
    if (targetSectors.has(s)) score += 2;
  }

  // 关键词匹配（权重 1，关键词交集越多分越高）
  let kwOverlap = 0;
  for (const kw of candidateKws) {
    if (targetKws.has(kw)) kwOverlap++;
  }
  score += kwOverlap;

  // 时间衰减（越近的分析越有参考价值，但不主导匹配）
  const dayDiff = Math.max(
    1,
    (new Date(target.date || Date.now()) - new Date(candidate.date)) / 86400000,
  );
  const recencyBonus = Math.max(0, 1 - dayDiff / 30); // 30天内有递减加分
  score += recencyBonus;

  return score;
}

function selectRelevantAnalyses(
  allAnalyses,
  currentHotKeywords,
  currentStructured,
  count,
) {
  if (allAnalyses.length === 0) return [];

  const todayTarget = {
    date: new Date().toISOString().slice(0, 10),
    hotKeywords: currentHotKeywords || [],
    keyThemes: currentStructured?.keyThemes || [],
    sectors: currentStructured?.sectors || [],
  };

  // 计算每个历史分析的相关度
  const scored = allAnalyses.map((a) => ({
    ...a,
    relevance: computeRelevance(todayTarget, a),
  }));

  // 按相关度排序，取 top N
  scored.sort((a, b) => b.relevance - a.relevance);
  const selected = scored.slice(0, count);

  // 按日期排序（prompt 中需要时间顺序）
  selected.sort((a, b) => a.date.localeCompare(b.date));

  return selected;
}

// ===== 热点关键词提取 =====

// 信源权威度权重（侧重金融经济类）
const SOURCE_WEIGHTS = {
  // Tier 1: 权威财经媒体 — 2.0x
  Reuters: 2.0,
  Bloomberg: 2.0,
  "Financial Times": 2.0,
  WSJ: 2.0,
  CNBC: 1.8,
  华尔街日报: 2.0,
  // Tier 2: 研究/政策机构 — 1.5x
  NBER: 1.5,
  Brookings: 1.5,
  VoxEU: 1.5,
  "Foreign Affairs": 1.5,
  "Pew Research": 1.3,
  // Tier 3: 学术/深度分析 — 1.3x
  "Nature Human Behaviour": 1.3,
  "PNAS Social Science": 1.3,
  "The Conversation": 1.2,
  Aeon: 1.1,
  // Tier 4: 中文财经 — 1.5x
  "36氪": 1.5,
  "36kr": 1.5,
  新浪财经: 1.5,
  东方财富: 1.5,
  第一财经: 1.5,
  投资者商业日报: 1.5,
  观察者: 1.3,
  凤凰科技: 1.2,
  // Google News 聚合
  "Google News Academic": 1.2,
  // Tier 2.5: 独立财经分析/专业媒体 — 1.3~1.5x
  "Crossing Wall Street": 1.4,
  Dealbreaker: 1.4,
  Goldmoney: 1.3,
  ScienceDirect: 1.5,
  "Journal of Financial Economics": 1.5,
  ZeroHedge: 1.3,
  "Wolf Street": 1.3,
  // 默认
  default: 1.0,
};

// 娱乐/社会噪音关键词黑名单（直接从热点中排除）
const NOISE_KEYWORDS = new Set([
  // 娱乐
  "电影",
  "票房",
  "明星",
  "演员",
  "导演",
  "综艺",
  "选秀",
  "偶像",
  "演唱会",
  "歌曲",
  "音乐",
  "专辑",
  "歌手",
  "网红",
  "直播带货",
  "八卦",
  "绯闻",
  "出轨",
  "离婚",
  "结婚",
  "恋情",
  "分手",
  "奥斯卡",
  "格莱美",
  "艾美奖",
  "金球奖",
  "movie",
  "film",
  "actor",
  "actress",
  "director",
  "celebrity",
  "grammy",
  "oscar",
  "emmy",
  "album",
  "concert",
  "song",
  "tiktok",
  "instagram",
  "youtube",
  "twitch",
  // 体育（除非与经济相关，如体育产业）
  "足球",
  "篮球",
  "世界杯",
  "NBA",
  "欧冠",
  "英超",
  "西甲",
  "奥运",
  "金牌",
  "运动员",
  "教练",
  "比赛",
  "football",
  "soccer",
  "basketball",
  "world cup",
  "championship",
  "tournament",
  "athlete",
  "coach",
  "match",
  // 生活/娱乐
  "美食",
  "旅游",
  "穿搭",
  "化妆",
  "护肤",
  "减肥",
  "星座",
  "塔罗",
  "运势",
  "风水",
  "recipe",
  "fashion",
  "makeup",
  "skincare",
  "travel",
  // 社会八卦
  "出轨",
  "小三",
  "家暴",
  "打人",
  "骂人",
  "互撕",
  "撕逼",
  "热搜",
  "上热搜",
  "霸榜",
  "刷屏",
]);

const CN_STOPWORDS = new Set([
  "的",
  "了",
  "在",
  "是",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一个",
  "上",
  "也",
  "很",
  "到",
  "说",
  "要",
  "去",
  "你",
  "会",
  "着",
  "没有",
  "看",
  "好",
  "自己",
  "这",
  "他",
  "她",
  "它",
  "们",
  "那",
  "里",
  "为",
  "什么",
  "怎么",
  "如何",
  "可以",
  "可能",
  "已经",
  "正在",
  "将",
  "被",
  "把",
  "从",
  "对",
  "与",
  "及",
  "或",
  "但",
  "而",
  "却",
  "又",
  "也",
  "还",
  "再",
  "才",
  "就",
  "只",
  "仅",
  "已",
  "新",
  "最",
  "更",
  "比",
  "超",
  "大",
  "小",
  "多",
  "少",
  "高",
  "低",
  "今日",
  "昨天",
  "今天",
  "本周",
  "上周",
  "下周",
  "去年",
  "今年",
  "明年",
  "万",
  "亿",
  "美元",
  "人民币",
  "欧元",
  "日元",
  "港元",
  "英镑",
  "报道",
  "消息",
  "新闻",
  "据悉",
  "显示",
  "指出",
  "认为",
  "表示",
  "透露",
  "来源",
  "图片",
  "视频",
  "编辑",
  "责任编辑",
  "记者",
  "com",
  "http",
  "https",
  "www",
  "html",
  "the",
  "and",
  "for",
  "that",
  "为什么",
  "怎么回事",
  "怎么办",
  "原因",
  "导致",
  "引发",
  "关注",
  "透露",
  "表示",
  "认为",
  "指出",
  "回应",
  "宣布",
  "发布",
  "曝光",
  "事件",
  "情况",
  "问题",
  "方面",
  "相关",
  "进行",
  "通过",
  "其中",
  "以及",
  "包括",
  "同时",
  "由于",
  "因此",
  "不过",
  "然而",
  "仍然",
  "依然",
  "居然",
  "竟然",
  "是否",
  "能否",
  "应该",
  "需要",
  "必须",
  "已经",
  "尚未",
  "目前",
  "当前",
  "截至",
  "截止",
  "此前",
  "之后",
  "之前",
  "以来",
  "最近",
  "近日",
  "近期",
  "日前",
  "据悉",
]);

const EN_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "been",
  "be",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "he",
  "she",
  "they",
  "we",
  "you",
  "i",
  "my",
  "your",
  "his",
  "her",
  "their",
  "our",
  "not",
  "no",
  "so",
  "if",
  "up",
  "out",
  "about",
  "how",
  "what",
  "when",
  "where",
  "who",
  "which",
  "why",
  "all",
  "each",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "new",
  "says",
  "said",
  "report",
  "reuters",
  "bloomberg",
  "wsj",
  "cnbc",
  "bbc",
  "cnn",
  "ft",
  "news",
  "update",
  "breaking",
  "latest",
  "why",
  "how",
  "what",
  "when",
  "where",
  "who",
  "which",
  "because",
  "after",
  "before",
  "during",
  "could",
  "would",
  "should",
  "might",
  "must",
  "shall",
  "into",
  "over",
  "under",
  "between",
  "through",
  "against",
  "among",
  "upon",
  "within",
  "without",
  "across",
  "along",
  "around",
  "behind",
  "below",
  "beneath",
  "beside",
  "beyond",
  "despite",
  "except",
  "following",
  "like",
  "near",
  "off",
  "onto",
  "outside",
  "past",
  "per",
  "since",
  "toward",
  "towards",
  "unlike",
  "until",
  "via",
  "whether",
  "also",
  "just",
  "only",
  "still",
  "even",
  "first",
  "second",
  "third",
  "last",
  "next",
  "much",
  "many",
  "few",
  "little",
  "several",
  "according",
  "based",
  "expected",
  "reported",
  "suggests",
  "shows",
  "reveals",
  "indicates",
  "found",
  "founds",
  "study",
  "research",
  "analysis",
  "report",
  "data",
  "survey",
]);

const DOMAIN_KEYWORDS = new Set([
  "关税",
  "贸易战",
  "贸易摩擦",
  "制裁",
  "脱钩",
  "供应链",
  "降息",
  "加息",
  "利率",
  "通胀",
  "通缩",
  "CPI",
  "PPI",
  "GDP",
  "美联储",
  "央行",
  "人民银行",
  "欧央行",
  "日央行",
  "A股",
  "美股",
  "港股",
  "纳斯达克",
  "标普",
  "道琼斯",
  "上证",
  "深证",
  "原油",
  "黄金",
  "白银",
  "铜",
  "天然气",
  "比特币",
  "以太坊",
  "芯片",
  "半导体",
  "AI",
  "人工智能",
  "大模型",
  "量子",
  "电动车",
  "新能源",
  "光伏",
  "风电",
  "储能",
  "锂电",
  "房地产",
  "楼市",
  "房价",
  "土地",
  "城投",
  "就业",
  "失业率",
  "非农",
  "PMI",
  "制造业",
  "IPO",
  "融资",
  "并购",
  "收购",
  "估值",
  "地缘",
  "冲突",
  "战争",
  "选举",
  "气候",
  "碳排放",
  "ESG",
  "绿色",
  "疫情",
  "疫苗",
  "病毒",
  "公共卫生",
  "tariff",
  "inflation",
  "deflation",
  "recession",
  "stimulus",
  "rate cut",
  "rate hike",
  "federal reserve",
  "fed",
  "ecb",
  "pboc",
  "stock",
  "bond",
  "yield",
  "treasury",
  "equity",
  "crypto",
  "bitcoin",
  "ethereum",
  "blockchain",
  "semiconductor",
  "chip",
  "artificial intelligence",
  "LLM",
  "EV",
  "electric vehicle",
  "renewable",
  "solar",
  "battery",
  "trade war",
  "sanctions",
  "geopolitics",
  "conflict",
  "IPO",
  "merger",
  "acquisition",
  "valuation",
  "funding",
]);

function extractKeywordsFromTitle(title) {
  const keywords = [];
  const lower = title.toLowerCase();

  // 中文: 白名单匹配（精确命中 or 包含白名单词作为子串）
  const cnMatches = lower.match(/[\u4e00-\u9fff]{2,6}/g) || [];
  for (const word of cnMatches) {
    if (CN_STOPWORDS.has(word)) continue;
    if (DOMAIN_KEYWORDS.has(word)) {
      keywords.push(word);
    } else {
      for (const dk of DOMAIN_KEYWORDS) {
        if (dk.length >= 2 && word.includes(dk)) {
          keywords.push(word);
          break;
        }
      }
    }
  }

  // 英文: 白名单匹配（精确 or 子串）
  const enMatches = lower.match(/[a-z]{3,}/g) || [];
  for (const word of enMatches) {
    if (EN_STOPWORDS.has(word)) continue;
    if (DOMAIN_KEYWORDS.has(word)) {
      keywords.push(word);
    } else {
      for (const dk of DOMAIN_KEYWORDS) {
        if (dk.length >= 3 && word.includes(dk)) {
          keywords.push(word);
          break;
        }
      }
    }
  }

  // 英文 2-gram: 只保留白名单命中的组合
  const enWords = lower.match(/[a-z]+/g) || [];
  for (let i = 0; i < enWords.length - 1; i++) {
    if (EN_STOPWORDS.has(enWords[i]) || EN_STOPWORDS.has(enWords[i + 1]))
      continue;
    const gram = enWords[i] + " " + enWords[i + 1];
    if (DOMAIN_KEYWORDS.has(gram)) {
      keywords.push(gram);
    }
  }

  return keywords;
}

function getSourceWeight(sourceName) {
  if (!sourceName) return SOURCE_WEIGHTS.default;
  // 精确匹配
  if (SOURCE_WEIGHTS[sourceName]) return SOURCE_WEIGHTS[sourceName];
  // 模糊匹配（source 名称包含关键词）
  const lower = sourceName.toLowerCase();
  for (const [key, weight] of Object.entries(SOURCE_WEIGHTS)) {
    if (key !== "default" && lower.includes(key.toLowerCase())) return weight;
  }
  return SOURCE_WEIGHTS.default;
}

// 噪音分类（这些分类中的关键词不进入热点排行，除非同时出现在金融/经济分类中）
const NOISE_CATEGORIES = new Set(["其他资讯", "教育与媒体", "心理学与认知"]);

function extractHotKeywords(items, topN = 15) {
  const keywordMap = new Map();
  for (const item of items) {
    const title = item.title || "";
    const category = item.category || "其他";
    const source = item.source || "";
    const sourceWeight = getSourceWeight(source);
    const keywords = extractKeywordsFromTitle(title);
    const uniqueKw = new Set(keywords);
    for (const kw of uniqueKw) {
      // 底线黑名单: 娱乐/体育等明确无关词
      if (NOISE_KEYWORDS.has(kw)) continue;
      if (!keywordMap.has(kw)) {
        keywordMap.set(kw, {
          count: 0,
          weightedCount: 0,
          categories: new Set(),
          sources: new Set(),
          isDomain: DOMAIN_KEYWORDS.has(kw),
          totalSourceWeight: 0,
        });
      }
      const entry = keywordMap.get(kw);
      entry.count++;
      entry.weightedCount += sourceWeight;
      entry.categories.add(category);
      entry.sources.add(source);
      entry.totalSourceWeight += sourceWeight;
    }
  }

  const scored = [];
  const candidateLog = []; // 规则3: 待审核新词

  for (const [keyword, data] of keywordMap) {
    const cats = [...data.categories];
    const crossCat = data.categories.size;
    const crossSource = data.sources.size;
    const avgSourceWeight = data.totalSourceWeight / data.count;

    // ── 规则 1: 白名单词直接通过（count≥1 即可）──
    if (data.isDomain) {
      if (data.count < 1) continue;
      const score =
        data.weightedCount * (1 + 0.5 * crossCat) * 1.5 * avgSourceWeight;
      scored.push({
        keyword,
        score: Math.round(score * 100) / 100,
        count: data.count,
        categories: cats,
        domain: true,
        sourceWeight: Math.round(avgSourceWeight * 100) / 100,
      });
      continue;
    }

    // ── 规则 2: 跨分类/跨信源信号 → 正常权重通过（count≥2）──
    const crossSignal = crossCat >= 2 || crossSource >= 2;
    if (crossSignal) {
      if (data.count < 2) continue;
      const score =
        data.weightedCount * (1 + 0.5 * crossCat) * 1.0 * avgSourceWeight;
      scored.push({
        keyword,
        score: Math.round(score * 100) / 100,
        count: data.count,
        categories: cats,
        domain: false,
        sourceWeight: Math.round(avgSourceWeight * 100) / 100,
      });
      continue;
    }

    // ── 规则 3: 高频新词（count≥3）→ 降级保留 + 记录候选日志 ──
    if (data.count >= 3) {
      const score =
        data.weightedCount * (1 + 0.5 * crossCat) * 0.5 * avgSourceWeight;
      scored.push({
        keyword,
        score: Math.round(score * 100) / 100,
        count: data.count,
        categories: cats,
        domain: false,
        sourceWeight: Math.round(avgSourceWeight * 100) / 100,
      });
      candidateLog.push({
        keyword,
        count: data.count,
        categories: cats,
        sources: [...data.sources],
      });
      continue;
    }

    // 其余: 丢弃（非领域、无跨分类信号、count<3）
  }

  scored.sort((a, b) => b.score - a.score);

  // 保存候选词日志供人工审核
  if (candidateLog.length > 0) {
    saveCandidateLog(candidateLog);
  }

  return scored.slice(0, topN);
}

// ===== 候选关键词日志（规则3: 高频新词供人工审核）=====
const CANDIDATE_LOG_FILE = path.join(DATA_DIR, "candidate-keywords.json");

function saveCandidateLog(newCandidates) {
  let existing = [];
  try {
    if (fs.existsSync(CANDIDATE_LOG_FILE)) {
      existing = JSON.parse(fs.readFileSync(CANDIDATE_LOG_FILE, "utf-8"));
    }
  } catch {
    existing = [];
  }

  const today = new Date().toISOString().slice(0, 10);
  // 合并: 同一天的候选词去重
  const todayEntry = existing.find((e) => e.date === today);
  if (todayEntry) {
    const existingKws = new Set(todayEntry.candidates.map((c) => c.keyword));
    for (const c of newCandidates) {
      if (!existingKws.has(c.keyword)) todayEntry.candidates.push(c);
    }
  } else {
    existing.push({ date: today, candidates: newCandidates });
  }

  // 只保留最近 30 天
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  existing = existing.filter((e) => e.date >= cutoffStr);
  existing.sort((a, b) => a.date.localeCompare(b.date));

  const tmp = CANDIDATE_LOG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), "utf-8");
  fs.renameSync(tmp, CANDIDATE_LOG_FILE);
}

// ===== 热点新闻去重（相似标题合并为一条附多信源）=====
function dedupHotItems(hotItems) {
  const SIMILARITY_THRESHOLD = 0.7;

  function charBigrams(text) {
    const bigrams = new Set();
    for (let i = 0; i < text.length - 1; i++) bigrams.add(text.slice(i, i + 2));
    return bigrams;
  }

  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aBg = charBigrams(a);
    const bBg = charBigrams(b);
    let intersection = 0;
    for (const bg of aBg) if (bBg.has(bg)) intersection++;
    return intersection / (aBg.size + bBg.size - intersection);
  }

  function normTitle(title) {
    return (title || "")
      .replace(/^[\s\-\u2013\u2014\u00B7\uFF5C\uFF1A:]+/, "")
      .replace(
        /\s*[\-\u2013\u2014]\s*(Reuters|Bloomberg|WSJ|CNBC|Financial Times|FT|BBC|CNN|NBER|36\u6C2A|新浪|观察者|凤凰)\s*$/i,
        "",
      )
      .replace(/\.com\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 80);
  }

  const merged = [];
  const normMap = []; // parallel array of normalized titles

  for (const item of hotItems) {
    const norm = normTitle(item.title);
    let matchIdx = -1;

    // Find similar existing item
    for (let i = 0; i < normMap.length; i++) {
      if (
        norm === normMap[i] ||
        similarity(norm, normMap[i]) >= SIMILARITY_THRESHOLD
      ) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx >= 0) {
      // Merge: add source to existing item
      const existing = merged[matchIdx];
      const src = item.source || "";
      if (src && !existing.sources.includes(src)) {
        existing.sources.push(src);
      }
      // Keep the longer title
      if (item.title.length > existing.title.length) {
        existing.title = item.title;
      }
      // Merge hot tags
      for (const tag of item.hotTags || []) {
        if (!existing.hotTags.includes(tag)) existing.hotTags.push(tag);
      }
    } else {
      merged.push({
        ...item,
        sources: [item.source || "unknown"],
        hotTags: [...(item.hotTags || [])],
      });
      normMap.push(norm);
    }
  }

  return merged;
}

function matchHotKeywords(title, hotKeywords) {
  const lower = (title || "").toLowerCase();
  return hotKeywords
    .filter((hk) => lower.includes(hk.keyword.toLowerCase()))
    .map((hk) => hk.keyword);
}

// ===== 从历史分析中提取关键主题 =====
function extractThemes(analysisText) {
  const lines = analysisText.split("\n");
  const themes = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{2,3}\s/.test(trimmed)) {
      themes.push(
        trimmed
          .replace(/^#{2,3}\s+/, "")
          .replace(/[📌🔍📊⚠️🔮📅🌍🏭🔄📜📈🔗]/g, "")
          .trim(),
      );
    }
  }

  const paragraphs = analysisText
    .split("\n\n")
    .filter((p) => p.trim() && !p.trim().startsWith("#"))
    .slice(0, 3);

  const summaries = paragraphs.map((p) => {
    const clean = p.replace(/[*_`#\[\]]/g, "").trim();
    return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
  });

  return { themes, summaries };
}

// ===== 分析生成 =====
function buildPrompt(
  newsData,
  previousAnalyses,
  perspective,
  snippets = [],
  trendSection = "",
) {
  const today = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });

  // 计算热点关键词（与AI分析使用相同的新闻集合）
  const allItems = newsData.items;
  const hotKeywords = extractHotKeywords(allItems, 15);

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

// ===== 日期索引维护 + 旧数据清理 =====
const ANALYSIS_RETENTION_DAYS = 90;

function updateDateIndex(dateStr) {
  const indexPath = path.join(ANALYSIS_DIR, "index.json");
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

// ===== 月度回顾 =====

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

// ===== 主逻辑 =====
const FORCE_FLAG = process.argv.includes("--force");

async function main() {
  console.log(
    "🤖 AI 深度分析引擎 v8.0（记忆 + 语义检索 + 视角轮换 + 热点加权 + 信源权威度 + 噪音过滤 + 权重分层抓取 + 内容深度分析 + 付费墙跳过 + 趋势追踪 + 事件链追踪 + 信号仪表盘 + Token优化 + 重试 + 幂等 + 月度回顾）",
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
      const articlesTmp = articlesPath + ".tmp";
      fs.writeFileSync(articlesTmp, JSON.stringify(articlesData, null, 2), "utf-8");
      fs.renameSync(articlesTmp, articlesPath);
      console.log(`💾 已保存 data/news/articles.json (${snippets.length} 篇文章)`);
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
  } catch (e) {
    console.error(`❌ 分析失败: ${e.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌ 分析失败:", e.message);
  process.exit(1);
});
