/**
 * 源解析器注册表 — 替代 fetchSource 中的 if/else 分派
 * 新增源类型只需：(1) 写解析函数 (2) 注册到 parsers (3) 在 topics.json 配置
 */

/**
 * RSS/Atom 解析器
 * @param {string} xml - 原始 XML 内容
 * @param {RegExp|null} filterRegex - 标题过滤正则
 * @returns {Array<{title: string, link: string}>}
 */
function parseRss(xml, filterRegex) {
  const items = [];

  const rssBlocks = extractBlocks(xml, "<item>", "</item>");
  for (const block of rssBlocks) {
    const title = extractTitle(block);
    if (!title) continue;
    if (filterRegex && !filterRegex.test(title)) continue;
    const link = extractLink(block);
    items.push({ title, link: link || "" });
  }

  if (items.length === 0) {
    const atomBlocks = extractBlocks(xml, "<entry>", "</entry>");
    for (const block of atomBlocks) {
      const title = extractTitle(block);
      if (!title) continue;
      if (filterRegex && !filterRegex.test(title)) continue;
      const link = extractLink(block);
      items.push({ title, link: link || "" });
    }
  }

  return items;
}

/**
 * 36氪 API 解析器
 * @param {object} data - JSON 响应
 * @returns {Array<{title: string, link: string}>}
 */
function parse36kr(data) {
  const items = [];
  const list = data?.data?.items || data?.data?.word_items || [];
  for (const item of list) {
    const info = item.item || item;
    const title = (info.title || "").replace(/<[^>]+>/g, "").trim();
    const link = info.id ? `https://36kr.com/p/${info.id}` : "";
    if (title) items.push({ title, link });
  }
  return items;
}

/**
 * 新浪财经 API 解析器
 * @param {object} data - JSON 响应
 * @param {RegExp|null} filterRegex - 标题过滤正则
 * @returns {Array<{title: string, link: string}>}
 */
function parseSina(data, filterRegex) {
  const items = [];
  const list = data?.result?.data || [];
  for (const item of list) {
    const title = (item.title || "").trim();
    const link = item.url || "";
    if (title && (!filterRegex || filterRegex.test(title))) {
      items.push({ title, link });
    }
  }
  return items;
}

// ===== 解析器注册表 =====
// key: source.type（或 source.type + "_" + source.parse 用于 API 子类型）
const parsers = {
  rss: (source, rawContent) => {
    const filter = source.filter ? new RegExp(source.filter, "i") : null;
    return parseRss(rawContent, filter);
  },
  api_36kr: (_source, rawContent) => {
    return parse36kr(JSON.parse(rawContent));
  },
  api_sina: (source, rawContent) => {
    const filter = source.filter ? new RegExp(source.filter, "i") : null;
    return parseSina(JSON.parse(rawContent), filter);
  },
};

/**
 * 获取源的解析器
 * @param {object} source - 源配置对象（需含 type 和可选 parse 字段）
 * @returns {Function|null} (source, rawContent) => items[]
 */
function getParser(source) {
  // 优先匹配 type + parse 组合（如 api_36kr, api_sina）
  if (source.parse) {
    const key = `${source.type}_${source.parse}`;
    if (parsers[key]) return parsers[key];
  }
  // 回退到 type 级别（如 rss）
  return parsers[source.type] || null;
}

/**
 * 注册新解析器
 * @param {string} key - 解析器 key（如 "scraper", "api_custom"）
 * @param {Function} fn - (source, rawContent) => items[]
 */
function registerParser(key, fn) {
  parsers[key] = fn;
}

// ===== XML 工具函数 =====

function extractTitle(block) {
  const cdataMatch = block.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/);
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = block.match(/<title[^>]*>(.*?)<\/title>/);
  if (plainMatch) return plainMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/, "$1").trim();
  return "";
}

function extractLink(block) {
  const hrefMatch = block.match(/<link[^>]*href="([^"]+)"/);
  if (hrefMatch) return hrefMatch[1].trim();
  const contentMatch = block.match(/<link[^>]*>(.*?)<\/link>/);
  if (contentMatch) return contentMatch[1].trim();
  return "";
}

function extractBlocks(xml, openTag, closeTag) {
  const blocks = [];
  let pos = 0;
  let start = xml.indexOf(openTag, pos);
  while (start !== -1) {
    const end = xml.indexOf(closeTag, start);
    if (end === -1) break;
    blocks.push(xml.slice(start, end + closeTag.length));
    pos = end + closeTag.length;
    start = xml.indexOf(openTag, pos);
  }
  return blocks;
}

module.exports = { parseRss, parse36kr, parseSina, getParser, registerParser, parsers };
