/**
 * DeepSeek API 调用封装
 * 从 analyze.js 提取
 */

const { apiCall } = require("./http.js");

const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_URL = "https://api.deepseek.com";
const MODEL = "deepseek-v4-pro";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 3000; // 3s, 6s, 12s

if (!API_KEY) {
  console.error("❌ 缺少 DEEPSEEK_API_KEY 环境变量");
  process.exit(1);
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
      const res = await apiCall(
        `${API_URL}/v1/chat/completions`,
        {
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
        },
        {
          headers: { Authorization: `Bearer ${API_KEY}` },
          timeout: 120000,
        },
      );

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

module.exports = {
  callDeepSeek,
  API_KEY,
  API_URL,
  MODEL,
};
