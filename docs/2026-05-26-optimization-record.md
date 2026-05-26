# 2026-05-26 全栈优化记录

> 本次优化覆盖前端性能、UI/UX、数据抓取管道、AI 分析引擎，共 12 次提交。

---

## 一、前端优化

### 1.1 Bug 修复：模板字符串转义导致页面白屏

**提交**: `f0573b9`

**问题**: `index.html` 第 320-324 行 `analysisHistoryHtml` 函数中，模板字符串反引号 `` ` `` 被错误转义为 `\``，导致 JavaScript 解析失败（`Invalid or unexpected token`），整个页面脚本无法执行。

**修复**: 将 4 行中的 `\`` → `` ` `` 和 `\$` → `$`。

---

### 1.2 UI/UX：历史日期布局优化

**提交**: `c4d67cb`

**改动**:
- 历史日期区域从 `flex-wrap` 改为 `grid` 布局（`grid-template-columns: repeat(auto-fill, minmax(80px, 1fr))`）
- 默认折叠显示 2 行（`max-height: 120px`），超过 7 个日期自动出现「展开全部」按钮
- 日期格式从 `2026-05-26` 改为 `5月26日`（hover 显示完整日期）
- 分析正文 h3 标题之间增加 `border-top` 分段线，提升层次感
- 侧边栏增加 `position: sticky; top: 0`，跟随视口滚动

---

### 1.3 日期导航条

**提交**: `223fdd7`

**改动**:
- 在页面顶部（main 区域之外）增加日期导航条：`‹ 2026年5月26日 ›` + 分析数量
- 使用 CSS Grid `grid-template-rows: auto 1fr` 布局，导航条横跨全宽
- 点击 ‹ › 可前后切换日期，URL hash 同步更新
- 首日/末日按钮自动禁用
- 移动端自动隐藏「N 个分析」标签

**关键设计**: 导航条放在 `.layout` 层而非 `.main` 内部，避免被 `loadView()` 的 `innerHTML` 覆盖。

---

### 1.4 首屏数据内联

**提交**: `de8fab6`

**改动**:
- 将 `index.json`（日期列表）、`meta.json`（分类元数据）、最新一天的分析数据内联到 HTML 的 `<script type="application/json" id="boot-data">` 标签
- JS 初始化时优先读取内联数据，首次渲染不依赖任何网络请求
- 移除 `<link rel="preload">` 标签（不再需要）

**效果**:
| 指标 | 优化前 | 优化后 |
|---|---|---|
| 首屏请求数 | 4 次 | 1 次 |
| 首屏传输量 | ~36KB | ~14KB |
| 首屏延迟 | 3×RTT | 0 |

---

## 二、数据管道优化

### 2.1 P0: JSON 压缩

**提交**: `99ef96e`  
**文件**: `trim-data.js`

将 `JSON.stringify(data, null, 2)` 改为 `JSON.stringify(data)`。每个分类文件减少约 28% 体积（~32KB → ~25KB）。`meta.json` 保持 pretty-print（2KB，便于人工查看）。

---

### 2.2 P0: 批量翻译

**提交**: `80673af`  
**文件**: `.github/scripts/update-news.js`

**改动**:
- 新增 `translateBatchDeepSeek()` 函数：单次 API 调用翻译 15 条标题
- `translateItems()` 重写：先查缓存 → 批量翻译 → 失败条目逐条回退（MyMemory → Google → DeepSeek）
- 批次间 1s 延迟防止限流

**效果**:
| 指标 | 之前 | 之后 |
|---|---|---|
| DeepSeek API 调用 | ~100次/运行 | ~7次/运行 |
| 翻译耗时 | ~3-5分钟 | ~30-60秒 |
| API 成本 | 高 | 降低 ~90% |

---

### 2.3 P1: 直接 RSS 源

**提交**: `af816a5`  
**文件**: `.github/scripts/topics.json`

将 7 个通过 Google News 代理的源替换为直接 RSS：

| 源 | 旧 URL | 新 URL |
|---|---|---|
| Reuters | `news.google.com/rss/search?q=...` | `reutersagency.com/feed/...` |
| Bloomberg | `news.google.com/rss/search?q=...` | `feeds.bloomberg.com/markets/news.rss` |
| Financial Times | `news.google.com/rss/search?q=...` | `ft.com/rss/home` |
| CNBC | `news.google.com/rss/search?q=...` | `search.cnbc.com/rs/search/...` |
| WSJ | `news.google.com/rss/search?q=...` | `feeds.a.dj.com/rss/RSSMarketsMain.xml` |
| Crossing Wall Street | `news.google.com/rss/search?q=...` | `crossingwallstreet.com/feed/` |
| Goldmoney | `news.google.com/rss/search?q=...` | `goldmoney.com/research/feed` |

**收益**: 直接 RSS 更稳定（不受 Google News 频率限制），数据更完整（可获取作者、完整发布时间等元数据）。

---

### 2.4 P1: 输出质量校验

**提交**: `f88ff754`  
**文件**: `.github/scripts/analyze.js`

新增 `validateAnalysis()` 函数，6 项检查：
1. `hasAnalysis`: 分析文本 > 200 字符
2. `hasSentiment`: 情绪值为看涨/看跌/分化/中性之一
3. `hasRiskLevel`: 风险值为高/中/低之一
4. `hasThemes`: 至少 1 个主题
5. `hasOutlook`: 前瞻文本 > 10 字符
6. `hasKeywords`: 至少 1 个热点关键词

不通过时输出告警日志，但仍保存分析结果（避免数据丢失）。

---

### 2.5 P1: 增量追加

**提交**: `af2f416`  
**文件**: `.github/scripts/update-news.js`

**改动**: 分类文件写入逻辑从「全量重写」改为「增量追加」：
1. 对新条目做去重（对比现有条目的标准化标题）
2. 新条目 prepend 到现有数据前面
3. 清理过期数据 + 截断到 MAX_ITEMS_PER_CATEGORY

**收益**: 减少文件 IO（只写入变化部分），加速运行。

---

### 2.6 P2: LLM 辅助分类

**提交**: `af2f416`  
**文件**: `.github/scripts/update-news.js`

新增 `llmClassify()` 函数：对落入「其他资讯」默认分类的条目（> 5 条时），调用 DeepSeek 批量二次分类。每批 20 条，输出 JSON 数组，将条目重新分配到正确的分类中。

---

### 2.7 P2: 拆分 AI 调用

**提交**: `f88ff754`  
**文件**: `.github/scripts/analyze.js`

**改动**: 将原来的单次 DeepSeek 调用拆分为两步：
1. **调用 1**（`extractStructuredSignals`）：轻量级结构化信号提取（~300 tokens），输出情绪/风险/主题/行业/前瞻的 JSON
2. **调用 2**：深度分析正文生成（~2500 tokens），注入预提取信号作为参考

**合并策略**: 分析结果优先，预提取信号做兜底。如果深度分析的结构化输出为空，使用预提取结果。

**收益**: 
- 结构化信号提取更快、更稳定（JSON schema 约束）
- 单步失败只重试该步，不影响整体
- 预提取信号可作为分析 prompt 的上下文，减少重复提取

---

### 2.8 P2: 源健康监控

**提交**: `af2f416`  
**文件**: `.github/scripts/update-news.js`

在 `processTopic` 中记录每个源的抓取状态（成功/失败/条数），运行结束后输出健康报告：

```
⚠️ 源健康报告: 3/21 个源失败:
  ❌ Reuters: HTTP 429
  ❌ Bloomberg: Timeout
  ❌ ZeroHedge: HTTP 403
```

---

### 2.9 P3: 语义去重

**提交**: `91d7ece`  
**文件**: `.github/scripts/update-news.js`

新增 `semanticDedup()` 函数：
- 对标题长度接近的条目对做 LLM 批量语义判断
- 每批最多 50 对，DeepSeek 输出 JSON 数组标记重复对
- 移除较短的标题（保留信息量更大的）
- 跳过条目数 < 5 的场景（无需语义去重）

**适用场景**: 检测跨语言重复（如英文原文和中文翻译同时存在）和改写重复。

---

### 2.10 P3: 分层调度

**提交**: `ef4001e`  
**文件**: `.github/workflows/update-news.yml`

**改动**:
- Cron 从每 2 天改为每天（`0 0 * * *`）
- 新增 `workflow_dispatch` 手动触发，支持 3 种模式：
  - `full`: 全量更新 + AI 分析（默认）
  - `finance-only`: 仅抓取新闻，跳过 AI 分析
  - `analysis-only`: 仅运行 AI 分析，跳过新闻抓取

---

## 三、提交清单

| # | SHA | 类型 | 说明 |
|---|---|---|---|
| 1 | `f0573b9` | fix | 修复模板字符串转义导致页面白屏 |
| 2 | `c4d67cb` | feat | 历史日期网格+折叠+短日期+日期导航 |
| 3 | `223fdd7` | fix | 日期导航移至顶层布局 |
| 4 | `de8fab6` | perf | 首屏数据内联，消除 3 个 JSON 请求 |
| 5 | `99ef96e` | perf | trim-data.js JSON 压缩 |
| 6 | `80673af` | perf | 批量翻译，减少 90% API 调用 |
| 7 | `af816a5` | perf | 替换 Google News 代理为直接 RSS |
| 8 | `af2f416` | feat | 增量追加 + LLM 分类 + 源健康监控 |
| 9 | `f88ff754` | feat | 质量校验 + 拆分 AI 调用 |
| 10 | `91d7ece` | feat | 语义去重 |
| 11 | `ef4001e` | feat | 分层调度 |
| 12 | `0f2937c` | feat | 分层调度（旧版，被 #11 覆盖） |

---

## 四、关键架构决策

1. **首屏内联 vs 持续预加载**: 选择内联，因为首屏数据量小（~5KB minified, ~1.5KB gzip），且消除 RTT 的收益远大于 HTML 体积增加
2. **批量翻译 vs 逐条翻译**: DeepSeek 支持长上下文，单次翻译 15 条标题的效果与逐条相当，但 API 调用减少 90%
3. **增量追加 vs 全量重写**: 增量追加减少 IO，但需要额外的去重逻辑。选择在新条目侧做去重（O(1) Set 查找），性能可接受
4. **拆分 AI 调用 vs 单次调用**: 两步调用增加一次 API round-trip，但结构化信号更稳定、可做兜底，整体质量提升
5. **语义去重放在最后**: 语义去重是可选的增强步骤，放在常规去重之后，只对候选条目做，避免影响主流程速度
