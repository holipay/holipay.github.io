# 2026-05-30 架构重构：模块化拆分与数据抽象层

## 一、优化背景

### 问题描述
`analyze.js` 文件膨胀至 **3116行**，包含15+个不相关的职责，严重影响可维护性和扩展性。

### 优化目标
1. **P0**：拆分 analyze.js 为独立模块
2. **P1**：配置外置，支持不改代码调整行为
3. **P1**：数据加载器抽象，为多数据源和API服务做准备
4. **P2**：前端JS拆分（评估后暂缓）

---

## 二、P0：analyze.js 模块化拆分

### 2.1 拆分方案

#### 原始状态
```
analyze.js (3116行)
├── DeepSeek API调用
├── 文章抓取和内容处理
├── 跨日趋势追踪
├── 事件链管理
├── 信号仪表盘
├── 新闻加载和智能选取
├── 历史分析记忆
├── 热词提取和评分
├── Prompt构建
├── 结构化输出解析
├── 月度回顾
├── 日期工具函数
└── 主逻辑
```

#### 目标结构
```
.github/scripts/
├── analyze.js              # 主入口（~350行）
├── lib/
│   ├── date-utils.js       # 日期工具函数
│   ├── deepseek.js         # DeepSeek API调用
│   ├── hotwords.js         # 热词提取、评分、去重
│   ├── articles.js         # 文章抓取和内容处理
│   ├── trends.js           # 跨日趋势追踪
│   ├── events.js           # 事件链管理
│   ├── dashboard.js        # 信号仪表盘
│   ├── news-selector.js    # 新闻加载和智能选取
│   ├── memory.js           # 历史分析记忆和语义匹配
│   ├── prompts.js          # Prompt构建
│   ├── structured.js       # 结构化输出解析和质量校验
│   └── monthly-review.js   # 月度回顾逻辑
```

### 2.2 模块依赖关系

```
analyze.js
├── deepseek.js ──────── http.js
├── articles.js ──────── translation.js
│                    ├── hotwords.js ──── shared.js
│                    └── date-utils.js
├── hotwords.js ──────── shared.js
├── trends.js
├── events.js
├── dashboard.js
├── news-selector.js ─── hotwords.js
│                    └── date-utils.js
├── memory.js
├── prompts.js ────────── hotwords.js
│                    ├── events.js
│                    └── memory.js
├── structured.js ─────── deepseek.js
├── monthly-review.js ─── deepseek.js
│                    ├── structured.js
│                    ├── prompts.js
│                    ├── news-selector.js
│                    ├── hotwords.js
│                    └── date-utils.js
└── date-utils.js ─────── storage.js
```

### 2.3 各模块职责和导出

#### date-utils.js
| 函数 | 说明 |
|------|------|
| `getDateOffset(days)` | 获取N天前的日期字符串 |
| `updateDateIndex(dateStr, dir)` | 更新日期索引 |
| `cleanupOldAnalyses()` | 清理过期分析文件 |
| `checkExistingAnalysis(dateStr)` | 幂等检查 |

#### deepseek.js
| 函数 | 说明 |
|------|------|
| `callDeepSeek(prompt, systemPrompt, maxTokens)` | 调用DeepSeek API |

#### hotwords.js
| 函数 | 说明 |
|------|------|
| `extractHotKeywords(items, topN)` | 提取热点关键词 |
| `getSourceWeight(sourceName)` | 获取信源权重 |
| `matchHotKeywords(title, hotKeywords)` | 匹配热词 |
| `dedupHotItems(hotItems)` | 热点新闻去重 |

#### articles.js
| 函数 | 说明 |
|------|------|
| `fetchWeightedArticles(hotKeywords, items)` | 分层抓取文章 |
| `fetchUrlText(url, maxChars)` | 抓取URL内容 |
| `cleanHtmlContent(html)` | HTML内容清洗 |
| `extractKeyData(text)` | 提取关键数据点 |

#### trends.js
| 函数 | 说明 |
|------|------|
| `loadPreviousTrends(currentDateStr)` | 加载历史趋势 |
| `saveTrends(dateStr, hotKeywords)` | 保存趋势数据 |
| `buildTrendSection(currentHotKeywords, previousTrends)` | 构建趋势对比 |

#### events.js
| 函数 | 说明 |
|------|------|
| `loadActiveEvents()` | 加载活跃事件 |
| `updateEvents(existingEvents, eventChains, dateStr, sentiment)` | 更新事件链 |
| `saveEvents(events)` | 保存事件数据 |
| `buildEventChainSection(events)` | 构建事件链上下文 |

#### dashboard.js
| 函数 | 说明 |
|------|------|
| `loadDashboard()` | 加载仪表盘数据 |
| `updateDashboard(dashboard, dateStr, structured, hotKeywords)` | 更新仪表盘 |
| `saveDashboard(dashboard)` | 保存仪表盘 |

#### news-selector.js
| 函数 | 说明 |
|------|------|
| `loadTodayNews()` | 加载今日新闻 |
| `selectBestNews(allItems, hotKeywords, maxItems)` | 智能新闻选取 |

#### memory.js
| 函数 | 说明 |
|------|------|
| `loadPreviousAnalyses(currentDateStr, count)` | 加载历史分析 |
| `selectRelevantAnalyses(allAnalyses, hotKeywords, structured, count)` | 语义匹配 |
| `extractThemes(analysisText)` | 提取主题 |

#### prompts.js
| 函数 | 说明 |
|------|------|
| `buildPrompt(...)` | 构建日常分析prompt |
| `buildMonthlyReviewPrompt(analyses, todayNews, monthStr)` | 构建月度回顾prompt |

#### structured.js
| 函数 | 说明 |
|------|------|
| `parseStructuredOutput(rawAnalysis)` | 解析结构化输出 |
| `validateAnalysis(result)` | 质量校验 |
| `extractStructuredSignals(newsData, hotKeywords)` | 预提取信号 |

#### monthly-review.js
| 函数 | 说明 |
|------|------|
| `isMonthlyReviewDay(dateStr)` | 检查是否月度回顾日 |
| `runMonthlyReview(dateStr, now)` | 运行月度回顾 |

---

## 三、P1：配置外置

### 3.1 配置文件清单

```
.github/scripts/configs/
├── daily-perspectives.json   # 每日分析视角配置
├── noise-keywords.json       # 噪音关键词黑名单
├── domain-keywords.json      # 领域关键词白名单
├── source-weights.json       # 信源权重配置
├── stopwords.json            # 停用词配置（中英文）
└── keyword-prefixes.json     # 关键词前缀配置
```

### 3.2 配置说明

| 配置文件 | 用途 | 修改场景 |
|----------|------|----------|
| `daily-perspectives.json` | 控制每天的分析方法论 | 调整视角、修改指令 |
| `noise-keywords.json` | 过滤娱乐/体育等无关热点 | 增减噪音词 |
| `domain-keywords.json` | 白名单关键词直接通过热点筛选 | 增加新领域关键词 |
| `source-weights.json` | 控制信源在热点计算中的权重 | 调整信源权威度 |
| `stopwords.json` | 关键词提取时过滤的停用词 | 增减停用词 |
| `keyword-prefixes.json` | 提取关键词时去除的前缀 | 增减前缀 |

### 3.3 配置加载机制

```javascript
// hotwords.js 中的配置加载
function loadJsonConfig(filename, fallback = {}) {
  try {
    const filePath = path.join(CONFIGS_DIR, filename);
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.warn(`⚠️ 无法加载配置文件 ${filename}: ${e.message}`);
    return fallback;
  }
}

// 支持配置文件中包含注释字段（以_开头）
const noiseKeywordsConfig = loadJsonConfig("noise-keywords.json", {});
// 合并所有数组字段
const allNoiseKeywords = Object.entries(noiseKeywordsConfig)
  .filter(([key]) => !key.startsWith("_"))
  .flatMap(([, value]) => value);
```

---

## 四、P1：数据加载器抽象

### 4.1 设计目标
- 统一的数据访问接口
- 支持多种存储后端（本地文件、API、数据库）
- 保持向后兼容性
- 易于扩展

### 4.2 架构设计

```
lib/
├── storage/
│   ├── base.js           # 存储接口基类
│   ├── file-storage.js   # 本地文件存储
│   ├── api-storage.js    # API存储（预留）
│   └── index.js          # 工厂函数
└── data-loader.js        # 统一数据加载器
```

### 4.3 存储接口定义

```javascript
// base.js - 存储接口基类
class BaseStorage {
  async readJson(key, defaultValue = null) {}
  async writeJson(key, data, options = {}) {}
  async exists(key) {}
  async listKeys(prefix) {}
  async delete(key) {}
}
```

### 4.4 数据加载器接口

```javascript
// data-loader.js - 业务级数据访问
class DataLoader {
  // 新闻数据
  async loadNews() {}
  async loadLatestNews() {}
  
  // 分析数据
  async loadAnalyses(currentDateStr, limit) {}
  async loadAnalysis(dateStr) {}
  async saveAnalysis(dateStr, result) {}
  
  // 文章数据
  async saveArticles(dateStr, articlesData) {}
  
  // 趋势数据
  async loadTrends(currentDateStr, limit) {}
  async saveTrends(dateStr, hotKeywords, retentionDays) {}
  
  // 事件链数据
  async loadEvents() {}
  async saveEvents(events) {}
  
  // 仪表盘数据
  async loadDashboard() {}
  async saveDashboard(dashboard) {}
}
```

### 4.5 使用方式

```javascript
// 创建加载器（默认使用本地文件）
const loader = createDataLoader("file", { rootDir: DATA_DIR });

// 使用 API 后端（未来）
const loader = createDataLoader("api", { 
  baseUrl: "https://api.example.com",
  apiKey: "xxx"
});

// 统一的数据访问
const news = await loader.loadNews();
await loader.saveAnalysis(dateStr, result);
```

### 4.6 环境变量配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `STORAGE_TYPE` | 存储类型 | `file` |
| `API_BASE_URL` | API基础URL | - |
| `API_KEY` | API密钥 | - |

---

## 五、P2：前端JS拆分（暂缓）

### 评估结论：暂不建议

| 因素 | 现状 | 影响 |
|------|------|------|
| 代码量 | ~1000-1500行 | 拆分收益有限 |
| 交互需求 | 无交互仪表盘 | 无紧迫需求 |
| 托管方式 | GitHub Pages静态 | 不支持复杂模块化 |

### 建议触发条件

当下述条件**任一满足**时再做：
1. 引入Chart.js/D3等图表库
2. 前端JS超过3000行
3. 引入构建工具（Vite等）
4. 多人协作前端开发

---

## 六、验证结果

### 语法检查
所有新建和修改的模块均通过 `node -c` 语法检查。

### 测试运行
```
ℹ tests 55
ℹ suites 14
ℹ pass 55
ℹ fail 0
```

---

## 七、后续建议

1. **为新模块补充单元测试**：当前测试只覆盖原有模块
2. **使用 `--force` 参数运行完整分析**：验证功能完整性
3. **添加新存储后端**：如需支持数据库，继承 `BaseStorage` 即可
4. **前端优化时机**：待引入构建工具或交互仪表盘时执行

---

## 八、变更文件清单

### 新增文件（18个）
```
.github/scripts/lib/date-utils.js
.github/scripts/lib/deepseek.js
.github/scripts/lib/hotwords.js
.github/scripts/lib/articles.js
.github/scripts/lib/trends.js
.github/scripts/lib/events.js
.github/scripts/lib/dashboard.js
.github/scripts/lib/news-selector.js
.github/scripts/lib/memory.js
.github/scripts/lib/prompts.js
.github/scripts/lib/structured.js
.github/scripts/lib/monthly-review.js
.github/scripts/lib/data-loader.js
.github/scripts/lib/storage/base.js
.github/scripts/lib/storage/file-storage.js
.github/scripts/lib/storage/api-storage.js
.github/scripts/lib/storage/index.js
.github/scripts/configs/*.json (6个配置文件)
```

### 修改文件（1个）
```
.github/scripts/analyze.js  # 3116行 → ~350行
```
