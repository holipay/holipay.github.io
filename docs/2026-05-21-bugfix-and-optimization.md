# 2026-05-21 Bug 修复与性能优化

## 概览

本次更新修复了"加载更多"按钮失效的 bug，解决了多个 XSS 安全漏洞，并对前端性能和数据存储策略进行了全面优化。

涉及文件：`index.html`、`news.html`、`sw.js`、`.github/scripts/analyze.js`、`.github/scripts/update-news.js`

---

## 一、Bug 修复

### 1. "加载更多"按钮失效

**问题**：点击分类新闻页面的"加载更多"按钮无反应，始终只显示第一页内容。

**根因**：`main.onclick` 处理器中从 `S.newsCache` 读取数据，但 `loadNewsCat()` 实际使用的是 `rawCatCache`，`S.newsCache` 从未被写入，永远返回空数组。

```javascript
// ❌ 修复前：读取空缓存
const items = S.newsCache.get(catObj.file + "@" + S.date) || [];

// ✅ 修复后：从正确的缓存获取
const items = await loadNewsCat(catObj.file);
```

**Commit**：`76c1a50`

---

## 二、安全修复

### 1. XSS：`javascript:` 协议链接（高危）

**问题**：新闻链接直接插入 `href` 属性，未验证 URL 协议。若数据中存在 `javascript:alert(1)` 类型的链接，用户点击即执行恶意脚本。

**修复**：新增 `safeHref()` 函数，只允许 `http:` 和 `https:` 协议：

```javascript
function safeHref(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return url;
  } catch { return ""; }
  return "";
}
```

所有 `<a href="...">` 均先过 `safeHref()` 验证。

### 2. XSS：HTML 属性引号未转义（中危）

**问题**：`esc()` 函数通过 `textContent` 赋值做 HTML 转义，但不会转义 `"`。用于 HTML 属性时（如 `data-cat="${esc(catTitle)}"`），可被注入属性。

**修复**：`esc()` 增加引号转义：

```javascript
// ❌ 修复前
const esc = s => { d.textContent = s; return d.innerHTML };

// ✅ 修复后
const esc = s => { d.textContent = s; return d.innerHTML.replace(/"/g, "&quot;") };
```

**Commit**：`59e9084`（index.html）、`1a4ab31`（news.html）

---

## 三、性能优化

### 1. LRU 缓存（内存控制）

**问题**：`rawCatCache` 使用普通 `Map`，15 个分类 × 1500 条数据全部驻留内存，无驱逐策略。

**修复**：实现 LRU（最近最少使用）缓存，限制最大条目数：

```javascript
const RAW_CACHE_MAX = 8;       // 分类原始数据最多缓存 8 个
const FILTERED_CACHE_MAX = 32; // 按日期过滤后的结果最多缓存 32 个
```

超过限制时自动驱逐最久未使用的条目。

**Commit**：`2533f10`

### 2. "加载更多"追加式 DOM

**问题**：每次点击"加载更多"后 `main.innerHTML = renderNews(...)` 销毁全部 DOM 再重建，造成不必要的重排重绘和滚动位置丢失。

**修复**：改为只追加新节点到 `#newsList`，已有 DOM 不动：

```javascript
// 只创建新节点追加，不重建整个列表
const frag = document.createElement("div");
frag.innerHTML = result.newHtml;
while (frag.firstChild) listEl.appendChild(frag.firstChild);
```

**Commit**：`2533f10`

### 3. 视口自适应页面大小 + 缓存

**问题**：`calcPageSize()` 在每次"加载更多"时重新计算，但此时 `main.clientHeight` 已因追加内容变大，导致每次加载数量递增。

**修复**：首次计算后缓存到 `S._pageSize`，切换分类/日期时重置：

```javascript
function getPageSize() {
  if (!S._pageSize) S._pageSize = calcPageSize();
  return S._pageSize;
}

// 切换分类/日期时重置
S._pageSize = 0;
```

各平台自适应效果：
- 手机（~500px）：20 条/次
- 桌面（~900px）：22 条/次
- 大屏（~1200px）：31 条/次

**Commit**：`2faf424`

### 4. CSS `content-visibility: auto`

**问题**：长列表中所有新闻条目同时渲染，包括屏外不可见的。

**修复**：为 `.news-item` 添加 CSS 属性，浏览器自动跳过屏外元素的布局和绘制：

```css
.news-item {
  content-visibility: auto;
  contain-intrinsic-size: auto 36px;
}
```

**Commit**：`2533f10`（index.html）、`c91605f`（news.html）

### 5. 预加载数量优化

**问题**：idle 时预加载 5 个分类文件，占用过多初始带宽。

**修复**：减少为 2 个：

```javascript
const top = S.meta.categories.slice(0, 2); // 从 5 减少到 2
```

**Commit**：`2533f10`

### 6. Service Worker 缓存驱逐

**问题**：JSON 响应使用 stale-while-revalidate 策略缓存，但无大小限制，缓存持续增长。

**修复**：添加最大条目数限制（50 条），超过时淘汰最旧条目：

```javascript
const MAX_CACHE_ENTRIES = 50;

async function evictOldEntries(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  const toDelete = keys.slice(0, keys.length - MAX_CACHE_ENTRIES);
  await Promise.all(toDelete.map((req) => cache.delete(req)));
}
```

**Commit**：`2b0d284`

---

## 四、数据保留策略（30 天）

### 已有策略（无需修改）

| 数据 | 保留策略 | 机制 |
|------|---------|------|
| 分类 JSON（股市与市场.json 等） | 30 天 | `RETENTION_DAYS = 30`，每次运行过滤 |
| translations-cache.json | 30 天 | `saveCache()` 清除 30 天前条目 |
| *_archive.json（有新数据的分类） | 30 天 | 每次运行重写，过滤过期数据 |
| latest.json | 固定 50 条 | 每次覆盖生成 |
| analysis.json | 仅最新 1 份 | 每次覆盖 |

### 本次修复

#### 1. 分析文件无限增长

**问题**：`analyze.js` 每天生成 `analysis/YYYY-MM-DD.json`（~8KB），从不删除。index.json 也只追加不修剪。

**修复**：新增 `cleanupOldAnalyses()` 函数 + `updateDateIndex()` 自动修剪：

```javascript
const ANALYSIS_RETENTION_DAYS = 30;

function cleanupOldAnalyses() {
  const cutoff = /* 30 天前的日期字符串 */;
  // 删除过期的分析文件
  for (const file of files) {
    if (date < cutoff) fs.unlinkSync(path.join(ANALYSIS_DIR, file));
  }
}

function updateDateIndex(dateStr) {
  // 添加新日期 + 过滤掉过期日期
  dates = dates.filter((d) => d >= cutoff);
}
```

每次运行时自动执行清理（包括幂等跳过时也会清理）。

**Commit**：`f932c1e`

#### 2. 无新数据分类的 archive 文件不清理

**问题**：`update-news.js` section 9 清理无新数据分类的主文件，但忽略对应的 `_archive.json`。

**修复**：section 9 现在也清理 archive 文件，空文件直接删除：

```javascript
const archivePath = path.join(dataDir, `${catTitle}_archive.json`);
if (fs.existsSync(archivePath)) {
  const archData = JSON.parse(fs.readFileSync(archivePath, "utf-8"));
  archData.items = (archData.items || []).filter(item => item.date >= cutoff);
  if (archData.items.length > 0) {
    atomicWrite(archivePath, JSON.stringify(archData, null, 2));
  } else {
    fs.unlinkSync(archivePath); // 无数据则删除
  }
}
```

**Commit**：`ffb9545`

### 数据增长预估

| 时间跨度 | 分类 JSON | 分析文件 | 翻译缓存 | 总计 |
|---------|----------|---------|---------|------|
| 当前 | ~790 KB | ~47 KB | ~515 KB | ~1.3 MB |
| 30 天稳态 | ~790 KB | ~240 KB | ~515 KB | ~1.5 MB |
| 无限增长（修复前） | ~790 KB | ~2.9 MB/年 | ~515 KB | 持续增长 |

修复后所有数据严格控制在 30 天窗口内，总大小稳定在 ~1.5 MB。

---

## Commit 汇总

| Commit | 文件 | 说明 |
|--------|------|------|
| `76c1a50` | index.html | 修复 load-more 按钮失效 |
| `59e9084` | index.html | XSS 安全修复 |
| `1a4ab31` | news.html | XSS 安全修复 |
| `2533f10` | index.html | LRU 缓存 + 追加式加载 + content-visibility |
| `2b0d284` | sw.js | 缓存条目数限制 |
| `c91605f` | news.html | content-visibility |
| `2faf424` | index.html | 视口自适应页面大小缓存 |
| `f932c1e` | analyze.js | 30 天分析文件清理 |
| `ffb9545` | update-news.js | archive 文件清理 |
