// ===== nase.me 公共工具库 =====

// LRU 缓存
class LRU {
  constructor(max) { this._m = new Map(); this._max = max; }
  get(k) { const m = this._m; if (!m.has(k)) return null; const v = m.get(k); m.delete(k); m.set(k, v); return v; }
  set(k, v) { const m = this._m; if (m.has(k)) m.delete(k); else if (m.size >= this._max) m.delete(m.keys().next().value); m.set(k, v); }
  has(k) { return this._m.has(k); }
}

// HTML 转义
const _escEl = document.createElement("div");
const _escRe = /[&<>"']/g;
const _escMap = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => { if (s == null) return ""; _escEl.textContent = s; return _escEl.innerHTML.replace(_escRe, c => _escMap[c]); };

// URL 安全检查
function safeHref(url) { try { const u = new URL(url); if (u.protocol === "http:" || u.protocol === "https:") return url; } catch { return ""; } return ""; }

// Fetch + 超时
function fetchT(u, ms = 10000) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(u, { signal: c.signal }).finally(() => clearTimeout(t)); }

// ===== Markdown 解析（单遍扫描） =====
function parseMarkdown(text) {
  let body = esc(text);
  body = body.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  body = body.replace(/`([^`]+)`/g, '<code>$1</code>');
  body = body.replace(/((?:^\|.+\|$\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;
    const isSep = r => /^\|[\s:-]+\|$/.test(r.trim());
    const header = rows[0];
    const bodyRows = rows.slice(1).filter(r => !isSep(r));
    const parseCells = (row, tag) => row.split('|').slice(1, -1).map(c => `<${tag}>${c.trim()}</${tag}>`).join('');
    const thead = `<thead><tr>${parseCells(header, 'th')}</tr></thead>`;
    const tbody = bodyRows.length ? `<tbody>${bodyRows.map(r => `<tr>${parseCells(r, 'td')}</tr>`).join('')}</tbody>` : '';
    return `<table>${thead}${tbody}</table>`;
  });
  body = body.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  body = body.replace(/(<\/blockquote>\n*<blockquote>)+/g, '<br>');
  body = body.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  body = body.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  body = body.replace(/^- (.+)$/gm, '<li>$1</li>');
  body = body.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  body = body.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  body = body.replace(/\*(.+?)\*/g, '<em>$1</em>');
  body = body.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  body = body.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  body = body.replace(/^-{3,}\s*$/gm, '<hr>');
  body = body.replace(/\n\n/g, '</p><p>');
  body = `<p>${body}</p>`;
  body = body.replace(/<p>\s*<\/p>/g, '');
  body = body.replace(/<p>\s*(<h[34]>|<table|<blockquote|<pre|<ul|<hr)/g, '$1');
  body = body.replace(/(<\/h[34]>|<\/table>|<\/blockquote>|<\/pre>|<\/ul>|<hr>)\s*<\/p>/g, '$1');
  return body;
}

// ===== 权重排序 =====
function sortByWeight(items, scoreMap) {
  return [...items].sort((a, b) => (scoreMap.get(b) || 0) - (scoreMap.get(a) || 0));
}

// ===== 渲染结构化标签 =====
function renderStructuredTags(data) {
  const per = data.perspective ? ` · ${data.perspective}` : "";
  let tags = ""; const s = data.structured;
  if (s) {
    const sm = s.sentiment || "中性", rk = s.riskLevel || "中";
    const smC = { "看涨": "badge-up", "看跌": "badge-down", "分化": "badge-mix" }[sm] || "badge-flat";
    const rkC = { "高": "badge-risk-h", "低": "badge-risk-l" }[rk] || "badge-risk-m";
    const smI = { "看涨": "📈", "看跌": "📉", "分化": "🔀" }[sm] || "➡️";
    const rkI = { "高": "🔴", "低": "🟢" }[rk] || "🟡";
    const b = `<span class="badge ${smC}">${smI} ${sm}</span><span class="badge ${rkC}">${rkI} 风险${rk}</span>`;
    const kwMap = new Map((data.hotKeywords || []).map(h => [h.keyword, h.score]));
    const themes = sortByWeight(s.keyThemes || [], kwMap);
    const sectors = sortByWeight(s.sectors || [], kwMap);
    const t = themes.map(x => `<span class="tag">${esc(x)}</span>`).join("");
    const sec = sectors.map(x => `<span class="tag">🏭 ${esc(x)}</span>`).join("");
    const o = s.outlook ? `<div class="outlook">${esc(s.outlook)}</div>` : "";
    tags = `<div class="a-tags">${b}${t}${sec}</div>${o}`;
  }
  const hotKw = (data.hotKeywords || []).slice(0, 8);
  const hotHtml = hotKw.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--bdr)">${hotKw.map(hk => `<span class="tag" style="background:rgba(239,68,68,.08);color:#ef4444;border-color:rgba(239,68,68,.2)">🔥 ${esc(hk.keyword)} <span style="opacity:.6;margin-left:2px">${hk.score}</span></span>`).join("")}</div>` : "";
  return { tags, hotHtml, per };
}

// ===== 渲染分析卡片 =====
function renderAnalysis(data) {
  if (!data || !data.analysis) return '<div class="empty"><div class="empty-icon">📭</div><p>暂无分析数据</p></div>';
  const date = data.date || (data.generatedAt ? new Date(data.generatedAt).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }) : "");
  const { tags, hotHtml, per } = renderStructuredTags(data);
  const body = parseMarkdown(data.analysis);
  return `<div class="card a-card">
    <div class="a-head"><span class="a-icon">🤖</span><span class="a-title">AI 深度分析</span><span class="a-meta">${date} · ${data.newsCount} 条新闻${per}</span></div>
    ${tags}${hotHtml}<div class="a-body">${body}</div></div>`;
}

// ===== 渲染新闻条目 =====
function renderNewsItem(it) {
  const href = it.link ? safeHref(it.link) : "";
  const t = href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(it.title)}</a>` : esc(it.title);
  const s = it.source ? `<span class="news-src">${esc(it.source)}</span>` : "";
  const d = it.date ? `<span class="news-date">${esc(it.date)}</span>` : "";
  return `<div class="news-item"><span class="news-title">${t}</span>${d}${s}</div>`;
}

// ===== 服务端渲染工具 =====
function renderNewsHead(catIcon, catTitle, count) {
  return `<div class="news-head"><span class="news-head-icon">${catIcon}</span><span class="news-head-title">${esc(catTitle)}</span><span class="news-head-count">${count} 条</span></div>`;
}

// ===== 新闻分类加载（所有日期，倒序）=====
const rawCatCache = new LRU(16);
async function loadNewsCat(file) {
  const cached = rawCatCache.get(file);
  if (cached) return cached;
  let data;
  try { const r = await fetchT(`data/news/${encodeURIComponent(file)}.json`); data = await r.json(); }
  catch { data = { items: [] }; }
  const items = (data.items || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  rawCatCache.set(file, items);
  return items;
}

// ===== 分析数据加载 =====
const analysisFullCache = new LRU(16);
async function loadAnalysisForDate(date) {
  const cached = analysisFullCache.get(date);
  if (cached) return cached;
  try { const r = await fetchT(`data/news/analysis/${date}.json`); const d = await r.json(); analysisFullCache.set(date, d); return d; }
  catch { return null; }
}

// ===== Meta 加载 =====
let _meta = null;
async function loadMeta() {
  if (_meta) return _meta;
  try { const r = await fetchT("data/news/meta.json"); _meta = await r.json(); } catch { _meta = { categories: [] }; }
  return _meta;
}

// ===== 日期列表 =====
let _allDates = null;
async function loadAllDates() {
  if (_allDates) return _allDates;
  try { _allDates = await fetchT("data/news/analysis/index.json").then(r => r.json()); } catch { _allDates = []; }
  return _allDates;
}
