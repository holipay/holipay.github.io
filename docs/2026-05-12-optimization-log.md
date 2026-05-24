# nase.me 优化与 AI 信息处理探索记录

> 2026-05-12 会话记录

---

## 一、网站加载速度优化

### 问题诊断

| 指标 | 优化前 | 问题 |
|------|--------|------|
| TTFB | 2276ms | GitHub Pages 冷启动 + CNAME DNS 解析 |
| DOMContentLoaded | 3282ms | 同步 JS/CSS 阻塞渲染 |
| 数据就绪 | ~6.8s | 串行加载 3 个 JSON（~249KB） |

### 实施的优化（已上线）

1. **`<script>` 加 `defer`** — JS 不再阻塞 HTML 解析，省 ~1s
2. **内联首屏关键 CSS** — 约 3KB 布局样式直接写入 HTML，消除 CSS 渲染阻塞
3. **`styles.css` 改异步加载** — 用 `preload + onload` 技巧
4. **补充 preload** — `meta.json`、`analysis.json` 加上 preload 标签
5. **内联数据预取脚本** — 底部 `<script>` 立即发起 fetch，与 `app.js` 解析并行
6. **`_resolveOrFetch()` 方法** — 优先消费预取数据，避免重复请求
7. **Service Worker 升级 v2** — install 阶段预缓存数据文件

### 精简为纯 AI 分析模式（已上线）

去掉新闻列表、搜索、筛选、热词、摘要卡片，只保留 AI 深度分析：

| 对比项 | 精简前 | 精简后 |
|--------|--------|--------|
| `app.js` | 754 行 / 25KB | 130 行 / 5KB |
| 数据传输 | ~249 KB | ~3.4 KB |
| 功能 | 新闻列表+搜索+筛选+热词+AI分析 | 仅 AI 深度分析 |
| 首屏 FCP | ~3.3s | <500ms |
| 数据就绪 | ~6.8s | <1s |

### 未实施但建议的优化

- **Cloudflare CDN** — TTFB 可从 2.2s 降至 100-300ms（需要操作域名 DNS）
- **关键 CSS 提取工具** — 用 critters 或 puppeteer 自动提取首屏 CSS

---

## 二、AI 信息处理方案探索

### 2.1 当前方案：抓取 → 翻译 → 分类 → AI 摘要

```
Node.js 抓取脚本 → MyMemory/Google Translate 翻译 → 分类脚本 → LLM 摘要 → 静态生成
```

**问题**：链条长、环节多、维护成本高（抓取脚本反爬、翻译 API 配额、分类 prompt 调优）

### 2.2 Deep Research Agent（深度研究代理）

2025 年最火的方向。给 AI 一个主题，它自己去搜索、筛选、综合、写分析。

**代表产品**：
- Google Deep Research — 自动规划搜索策略、多轮检索、交叉验证、生成报告
- OpenAI / Anthropic 同类 — ChatGPT "Deep Research" 模式
- [STORM](https://github.com/stanford-oval/storm)（斯坦福）— 自动模拟"作者+审稿人"对话生成百科文章

**对 nase.me 的意义**：可替代"抓取+翻译+分类+摘要"整条链路，不需要维护抓取脚本。

### 2.3 RSS + LLM Pipeline（轻量级）✅ 已实施

```
RSS 订阅源 → 去重/筛选 → LLM 摘要 → 推送/展示
```

**开源项目参考**：
- [Feedless](https://github.com/nicehash/feedless) — RSS 聚合 + AI 过滤
- [Miniflux](https://miniflux.app/) + LLM 插件 — 自托管 RSS 阅读器
- [Huginn](https://github.com/huginn/huginn) — 类 IFTTT 自动化引擎
- [n8n](https://n8n.io/) — 低代码自动化，有 RSS+AI 模板

**优势**：比传统爬虫简单，RSS 是结构化数据，不用写抓取脚本。

**已在 nase.me 实施**：`rss-prototype/` 目录，GitHub Actions 每日运行。

### 2.4 AI Agent 自主浏览（Browser Agent）

让 AI 像人一样打开网页、阅读、提取信息。

**开源项目**：
- [Browser Use](https://github.com/browser-use/browser-use) — LLM 控制浏览器完成任务
- [Stagehand](https://github.com/browserbase/stagehand) — AI 浏览器自动化框架
- [Firecrawl](https://github.com/mendableai/firecrawl) — 网页→结构化数据，专为 AI 设计

**优势**：覆盖没有 RSS 的源，不需要维护 CSS 选择器和反爬逻辑。
**劣势**：成本更高，速度更慢。

### 2.5 多 Agent 协作系统

多个 AI 角色分工协作：

```
研究员 Agent（搜索+抓取）
    ↓
分析师 Agent（交叉验证+深度分析）
    ↓
编辑 Agent（生成可读报告）
    ↓
发布 Agent（推送到网站/邮件/Telegram）
```

**开源框架**：
- [CrewAI](https://github.com/crewAIInc/crewAI) — 多 Agent 编排
- [AutoGen](https://github.com/microsoft/autogen) — 微软多 Agent 框架
- [LangGraph](https://github.com/langchain-ai/langgraph) — 状态图驱动 Agent 工作流

### 2.6 方案对比

| 方案 | 复杂度 | 维护成本 | 数据质量 | 适合场景 |
|------|--------|----------|----------|----------|
| 传统爬虫（当前） | ⭐⭐⭐⭐ | 高 | 中 | 需要精确控制抓取逻辑 |
| **RSS + LLM** ✅ | ⭐⭐ | **低** | 高 | 标准化信息源，快速上线 |
| Deep Research Agent | ⭐⭐⭐ | 中 | **最高** | 深度分析，不依赖固定源 |
| Browser Agent | ⭐⭐⭐⭐ | 中 | 高 | 无 RSS 的网站 |
| 多 Agent 系统 | ⭐⭐⭐⭐⭐ | 高 | 最高 | 企业级情报系统 |

---

## 三、RSS + LLM 实施细节

### 架构

```
config.json          ← RSS 源配置（3 个主题，15+ 分类）
src/
├── feeds.js         ← RSS 抓取 + 去重 + 关键词过滤
├── llm.js           ← LLM 客户端（兼容任何 OpenAI API）
├── analyze.js       ← 分析生成 + 分类
└── index.js         ← 主入口
.github/workflows/
└── rss-update.yml   ← GitHub Actions 每日定时任务
```

### 测试验证的 RSS 源

| 源 | 状态 | 条目数 |
|----|------|--------|
| 36kr.com/feed | ✅ | 30 |
| 36kr.com/feed-article | ✅ | 50 |
| ithome.com/rss/ | ✅ | 60 |
| geekpark.net/rss | ✅ | 30 |
| qbitai.com/feed | ✅ | 10 |
| sspai.com/feed | ✅ | 10 |
| chinanews.com.cn/rss/finance.xml | ✅ | 30 |
| BBC / Reuters / NYT | ✅ (GitHub Actions) | — |

### 首次运行结果

- 抓取新闻：**189 条**
- AI 分析：**3363 字符**
- DeepSeek 调用耗时：~15s
- 总耗时：~3 分钟

### LLM 提供商兼容性

任何 OpenAI 兼容 API 都支持：

| 提供商 | BASE_URL | MODEL |
|--------|----------|-------|
| DeepSeek | https://api.deepseek.com/v1 | deepseek-chat |
| OpenAI | https://api.openai.com/v1 | gpt-4o-mini |
| 硅基流动 | https://api.siliconflow.cn/v1 | Qwen/Qwen2.5-7B-Instruct |
| 本地 Ollama | http://localhost:11434/v1 | qwen2.5:7b |

---

## 四、下一步建议

1. **短期**：观察 RSS + LLM pipeline 每日运行稳定性，调整 RSS 源和关键词过滤
2. **中期**：接入 Cloudflare CDN 降低 TTFB；考虑用 Deep Research Agent 提升分析深度
3. **长期**：探索多 Agent 系统，实现"搜索→验证→分析→发布"全自动闭环
