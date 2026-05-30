/**
 * 统一 HTTP 客户端 — fetch + retry + redirect + gzip + ETag
 * 从 update-news.js 和 analyze.js 提取，消除重复代码
 */

const https = require("https");
const http = require("http");
const zlib = require("zlib");

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_RETRIES = 2;

function fetchUrl(url, maxRedirects = 3, _visited = new Set(), timeout = DEFAULT_TIMEOUT, options = {}) {
  return new Promise((resolve, reject) => {
    if (_visited.has(url))
      return reject(new Error(`Circular redirect: ${url}`));
    _visited.add(url);

    const mod = url.startsWith("https") ? https : http;
    const agent = url.startsWith("https") ? httpsAgent : httpAgent;
    const req = mod.get(
      url,
      {
        agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NewsAggregatorBot/3.0)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate",
          ...(options.conditionalHeaders || {}),
        },
        timeout,
      },
      (res) => {
        if (res.statusCode === 304) {
          res.resume();
          resolve({ notModified: true });
          return;
        }
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          const redirectUrl = new URL(res.headers.location, url).href;
          res.resume();
          return fetchUrl(redirectUrl, maxRedirects - 1, _visited, timeout, options)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        let stream = res;
        const encoding = res.headers["content-encoding"];
        if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());

        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (options.conditionalHeaders) {
            resolve({
              body,
              etag: res.headers.etag,
              lastModified: res.headers["last-modified"],
            });
          } else {
            resolve(body);
          }
        });
        stream.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

async function fetchWithRetry(url, retries = DEFAULT_RETRIES, timeout = DEFAULT_TIMEOUT, options = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchUrl(url, 3, new Set(), timeout, options);
    } catch (e) {
      const msg = e.message || "";
      const isRateLimited = msg.includes("HTTP 429");
      const isTimeout = msg.includes("Timeout");
      const retryable =
        isRateLimited ||
        isTimeout ||
        msg.includes("HTTP 5") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ENOTFOUND") ||
        msg.includes("socket hang up");

      if (isRateLimited && options.onRateLimit) {
        options.onRateLimit(url);
      }

      if (i < retries && retryable) {
        const baseDelay = isRateLimited ? 1000 : 2000;
        const delay = baseDelay * (i + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

function apiCall(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "NASE-Bot/1.0",
        ...(options.headers || {}),
      },
      timeout: options.timeout || 120000,
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

module.exports = { fetchUrl, fetchWithRetry, apiCall, DEFAULT_TIMEOUT, DEFAULT_RETRIES };
