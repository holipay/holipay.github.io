# nase.me AI 分析引擎 v3 及前端优化记录

> 2026-05-20 会话记录

---

## 背景与问题

### 分析内容同质化

连续多天的 AI 深度分析高度雷同。对比 5-15、5-17、5-19 三天的分析：

| 日期 | 主要叙事 | 结构 |
|------|---------|------|
| 5-15 | K型经济、脱钩、旧经济、地缘政治 | 今日要点 → 深度解读 → 市场信号 → 风险提示 → 前瞻展望 |
| 5-17 | K型经济、脱钩、旧经济、地缘政治 | 完全相同 |
| 5-19 | K型经济、脱钩、旧经济、地缘政治 | 完全相同 |

**根因**：`analyze.js` 的 prompt 是静态的，每天用相同的格式要求、相同的 system prompt，导致模型反复输出相同的叙事框架。新闻标题本身也有重复（财经新闻周期性相似），但更关键的是 prompt 没有"记忆"机制。

### 页面头部占空间过多

`index.html` 中品牌名和描述分两行居中显示，加上 padding 和 margin，头部占约 70px 垂直空间，首屏分析内容被压缩。

---

## 一、分析引擎 v3：记忆注入 + 视角轮换

### 1.1 设计思路

**方案一（每日视角轮换）**：按星期几切换分析侧重方向，让每天的关注点自然不同。

| 星期 | 视角 | 侧重 |
|------|------|------|
| 日 | 周度复盘 | 回顾本周叙事线，提炼转折点 |
| 一 | 宏观全景 | 全球格局、央行政策、跨市场联动 |
| 二 | 行业深潜 | 挑 1-2 个行业做垂直分析 |
| 三 | 逆向思考 | 挑战市场共识，找盲点和反面论据 |
| 四 | 历史镜鉴 | 与历史类似时期对比 |
| 五 | 数据驱动 | 关注数字、统计、量化信号 |
| 六 | 跨市场联动 | 股/债/汇/商品/加密的传导关系 |

**方案二（记忆注入）**：加载前 2 次分析，提取主题关键词和内容摘要，注入 prompt 告诉模型"这些说过了，换角度"。

**最终方案**：两者合并。

### 1.2 核心改动

#### 新增 `DAILY_PERSPECTIVES` 配置表

```javascript
const DAILY_PERSPECTIVES = [
  {
    day: 0,  // 周日
    label: "周度复盘",
    instruction: "今天是周日，请做「周度复盘」。回顾本周新闻的主要叙事线...",
    sectionHint: "## 📅 周度复盘\n提炼本周核心主题和转折点。",
  },
  // ... 共 7 天
];
```

每个视角包含：
- `instruction`：给 AI 的专项指令，影响分析切入点
- `sectionHint`：输出结构中的专属板块标题

#### 新增 `loadPreviousAnalyses()`

```javascript
function loadPreviousAnalyses(currentDateStr, count = 2) {
  // 从 analysis/index.json 读日期索引
  // 过滤掉当天，取最近 N 天
  // 读取对应 JSON 文件的 analysis 字段
}
```

#### 新增 `extractThemes()`

```javascript
function extractThemes(analysisText) {
  // 提取 ##/### 标题行 → 主题关键词
  // 提取前 3 段正文前 80 字 → 内容摘要
  return { themes, summaries };
}
```

#### Prompt 结构变化

注入两段新内容：

```
━━━ 历史分析记忆（请务必避免重复以下内容）━━━
【2026-05-19】已覆盖主题: 今日要点、深度解读、市场信号...
内容摘要: 2026年5月19日的新闻头条呈现出一种前所未有的深度撕裂...

【2026-05-17】已覆盖主题: 今日要点、深度解读、市场信号...
内容摘要: 2026年5月17日的新闻集中呈现了一个核心矛盾...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ 今日分析视角: 行业深潜 ━━━
今天是周二，请做「行业深潜」。从今天新闻中挑出 1-2 个最值得关注的行业...
```

加上 4 条硬性要求：
1. 避免重复已覆盖的角度和叙事框架
2. 如果出现过「K型经济」「脱钩」等已反复讨论的概念，寻找新维度
3. 今日视角必须真正影响分析切入点
4. 保持客观、专业，有独到见解

#### 其他微调

| 参数 | 之前 | 之后 | 原因 |
|------|------|------|------|
| temperature | 0.7 | 0.8 | 增加创造性，减少模板化 |
| max_tokens | 2000 | 2500 | 给视角专属板块腾空间 |
| system prompt | 泛泛的"专业分析师" | 强调"拒绝套话、新角度" | 提升输出质量 |

#### 输出 JSON 新增字段

```json
{
  "date": "2026-05-20",
  "perspective": "行业深潜",  // 新增：记录当天视角
  "analysis": "...",
  "sources": [...]
}
```

### 1.3 效果预期

- 每天分析角度不同（7 天一轮回）
- 即使新闻相似，AI 也会从不同维度切入
- 历史记忆机制防止"换汤不换药"式的重复

---

## 二、分析输出结构化字段

### 2.1 设计思路

让 DeepSeek 在 Markdown 分析正文后输出一段结构化 JSON，前端可以渲染为可视化元素（徽章、标签、卡片），而非纯文字墙。

### 2.2 Prompt 末尾追加指令

```
最后，在分析正文结束后，另起一行输出一个结构化摘要，格式如下:

---STRUCTURED---
```json
{
  "sentiment": "看涨|看跌|中性|分化",
  "riskLevel": "低|中|高",
  "keyThemes": ["主题1", "主题2", "主题3"],
  "sectors": ["行业1", "行业2"],
  "outlook": "一句话前瞻判断"
}
```
```

### 2.3 解析逻辑

```javascript
function parseStructuredOutput(rawAnalysis) {
  // 1. 用 ---STRUCTURED--- 标记分割正文和 JSON
  // 2. 提取 ```json 代码块
  // 3. JSON.parse + 字段校验
  // 4. 解析失败 → 返回默认值，不影响正文
}
```

**容错设计**：
- 标记不存在 → 整段作为正文，structured 用默认值
- JSON 格式错误 → 同上
- 字段值不在允许范围 → 使用默认值
- 数组超长 → 截断到 5 个

### 2.4 前端渲染

分析卡片头部下方新增一行：

```
[📈 看涨] [🟡 风险中] [AI] [地缘政治] [能源] [🏭 旧经济]
🔮 短期维持高位震荡，关注美联储议息会议

（正文 Markdown...）
```

| 元素 | 样式 | 数据源 |
|------|------|--------|
| 情绪徽章 | 看涨(绿)/看跌(红)/分化(橙)/中性(蓝) | `structured.sentiment` |
| 风险徽章 | 🟢低/🟡中/🔴高 | `structured.riskLevel` |
| 主题标签 | 蓝色药丸 | `structured.keyThemes` |
| 行业标签 | 带 🏭 前缀 | `structured.sectors` |
| 前瞻判断 | 左蓝边框 + 🔮 | `structured.outlook` |

**兼容性**：旧数据（无 `structured` 字段）不渲染徽章区域，无闪烁或报错。

---

## 三、DeepSeek 调用重试机制

### 3.1 问题

`callDeepSeek` 没有重试逻辑。GitHub Actions 运行环境网络不稳定，API 偶发超时或 5xx 错误，直接导致整个分析流程失败。

### 3.2 方案

```javascript
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 3000; // 3s, 6s, 12s

async function callDeepSeek(prompt) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 正常调用
      return content;
    } catch (e) {
      // 判断是否可重试
      const isRetryable = e.message.includes("timeout") ||
                          e.message.includes("HTTP 5") ||
                          e.message.includes("ECONNRESET") ||
                          e.message.includes("Empty response");

      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        console.warn(`⚠️ 第 ${attempt} 次调用失败，${delay/1000}s 后重试...`);
        await sleep(delay);
        continue;
      }
      throw e; // 不可重试或重试耗尽
    }
  }
}
```

**指数退避**：3s → 6s → 12s，避免频繁重试加重服务端负担。

**可重试错误**：timeout、HTTP 5xx、ECONNRESET、ETIMEDOUT、空响应。
**不可重试错误**：认证失败、参数错误等。

---

## 四、幂等保护

### 4.1 问题

GitHub Actions 可能被手动触发两次，或者 cron 调度和手动触发重叠，导致同一天生成两份分析，后者覆盖前者。

### 4.2 方案

```javascript
function checkExistingAnalysis(dateStr) {
  // 读取 analysis/YYYY-MM-DD.json
  // 检查 generatedAt 是否是今天（Asia/Shanghai）
  // 同日 + 有 structured 字段 → 跳过
}

// 主逻辑开头
const FORCE_FLAG = process.argv.includes("--force");

const existing = checkExistingAnalysis(dateStr);
if (existing && !FORCE_FLAG) {
  console.log("⏭️ 今日分析已存在，跳过");
  process.exit(0);
}
```

**Workflow 配合**：

```yaml
- name: AI analysis
  run: |
    if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
      node .github/scripts/analyze.js --force
    else
      node .github/scripts/analyze.js
    fi
```

| 触发方式 | 行为 |
|----------|------|
| cron 定时 | 同日已有分析 → 跳过 |
| 手动触发 | 总是重新生成（--force） |

---

## 五、新闻列表展示

### 5.1 问题

前端只展示 AI 分析卡片，大量结构化新闻数据（15 个分类、数千条）完全没有被呈现。用户无法验证 AI 分析是否覆盖了原始新闻，也无法自己浏览感兴趣的条目。

### 5.2 方案

在分析卡片下方新增可折叠的新闻列表：

```
[📰 今日新闻]                    [247 条 · 12 个分类] ▼

  ▶ 📈 股市与市场 (50)
  ▶ 🖥️ 科技与企业 (45)
  ▶ 💰 宏观经济 (32)
  ...
```

**数据加载策略**：
- 分析卡片和新闻列表**并行加载**（`Promise.all`）
- 新闻数据按分类独立请求，任一失败不影响其他
- 结果缓存在 `state.newsCache`，切换日期不重复请求

**交互设计**：
- 默认折叠，点击展开
- 每个分类也可独立折叠
- 点击分类标题自动展开父面板
- 新闻标题可点击跳转原文

### 5.3 数据源

使用 `data/news/{分类}.json` 文件，按 `date` 字段过滤：

```javascript
async function loadNewsForDate(dateStr) {
  const meta = await loadMeta(); // meta.json 获取分类列表
  const results = await Promise.allSettled(
    meta.categories.map(async (cat) => {
      const data = await fetch(`data/news/${cat.file}.json`);
      const items = data.items.filter(i => i.date === dateStr);
      return { icon: cat.icon, title: cat.title, items };
    })
  );
  return results.filter(r => r.value.items.length > 0)
                .sort((a, b) => b.items.length - a.items.length);
}
```

---

## 六、页面头部精简

### 6.1 改动

| 元素 | 之前 | 之后 |
|------|------|------|
| 布局 | 两行居中（品牌名 + 描述） | 单行 topbar（左品牌、右描述） |
| `.main` padding-top | 32px | 20px |
| `.brand` padding | 24px 0 4px | 8px 0 12px |
| `.brand-desc` | 独立行 + margin-bottom: 20px | inline 在 topbar 内 |
| `.card` padding | 16px | 20px |
| 分析正文字号 | 13.5px | 14px |

### 6.2 效果

头部从约 70px 压缩到约 40px，省出约 30px 给内容区域。分析卡片内边距和字号同步增大，内容更突出。

---

## 七、翻译 DeepSeek 兜底

### 7.1 问题

翻译链路依赖免费 API（MyMemory + Google Translate），随时可能被限流或封禁。一旦翻译全部失败，英文标题原样入库，影响分析质量。

### 7.2 方案

在现有翻译链路末尾增加 DeepSeek 作为第三级兜底：

```
MyMemory (免费，快)
    ↓ 失败
Google Translate (免费，300ms 延迟)
    ↓ 失败
DeepSeek (付费 API，500ms 延迟，最后兜底)
```

```javascript
async function translateDeepSeek(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  // 调用 DeepSeek Chat API
  // system prompt: "你是翻译引擎。只输出翻译结果，不加任何解释。"
  // temperature: 0.1（确定性翻译）
  // max_tokens: 200（标题不需要长输出）
}
```

### 7.3 成本控制

- 仅当前两级都失败时才调用 DeepSeek
- 日志标记 `🤖 DeepSeek 翻译兜底` 方便追踪调用量
- 正常情况下 95%+ 的翻译由免费 API 完成，DeepSeek 调用量极少

### 7.4 Workflow 变更

```yaml
# 之前：只有 AI analysis 步骤有 DEEPSEEK_API_KEY
# 之后：Fetch news 步骤也传入
- name: Fetch news
  env:
    TZ: Asia/Shanghai
    DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

---

## 八、SW 缓存版本自动化

### 8.1 问题

`sw.js` 中 `CACHE_NAME` 硬编码为 `"nase-v4"`。更新 HTML/CSS/JS 后，用户浏览器仍使用旧缓存，除非手动清除或改版本号。每次发版都需要记得改，容易遗漏。

### 8.2 方案

Workflow 新增步骤，每次运行自动更新：

```yaml
- name: Update SW cache version
  run: |
    SW_DATE=$(TZ=Asia/Shanghai date +%Y%m%d)
    sed -i "s/const CACHE_NAME = \"nase-[^\"]*\"/const CACHE_NAME = \"nase-${SW_DATE}\"/" sw.js
```

`git add` 覆盖 `sw.js`，随其他变更一起提交。

### 8.3 效果

- 每次 Actions 运行后 `CACHE_NAME` 自动更新为 `nase-20260520` 格式
- Service Worker 检测到新版本 → `activate` 事件清除旧缓存 → 用户自动获取最新内容
- 无需手动维护版本号

---

## 九、Prompt 优化：分类感知

### 9.1 问题

原始 prompt 中新闻列表是扁平的：

```
- 标题1 (来源, 日期)
- 标题2 (来源, 日期)
...
```

AI 看不到新闻的分类分布，容易只关注占比最大的财经类新闻，忽略科技、社科等领域。

### 9.2 方案

按分类组织新闻输入：

```
新闻列表（按分类）:

【股市与市场】
  - 标题1 (来源)
  - 标题2 (来源)

【宏观经济】
  - 标题3 (来源)

【科技与研究】
  - 标题4 (来源)
...
```

prompt 新增第 4 条要求：

> 新闻覆盖了多个领域（金融、科技、社科、健康、环境等），不要只盯着股市和宏观经济，请关注更广泛的议题。

---

## 十、改动文件汇总

| 文件 | 改动内容 |
|------|----------|
| `.github/scripts/analyze.js` | 视角轮换、记忆注入、重试机制、结构化输出、幂等保护 |
| `.github/scripts/update-news.js` | 翻译 DeepSeek 兜底 |
| `.github/workflows/update-news.yml` | DeepSeek key 传递、SW 版本自动化、手动触发 force |
| `index.html` | 头部精简、新闻列表、结构化徽章展示 |
| `sw.js` | 缓存版本号待自动化更新 |

### 输出 JSON 结构（新）

```json
{
  "date": "2026-05-20",
  "generatedAt": "2026-05-20T02:30:33.461Z",
  "newsCount": 50,
  "perspective": "行业深潜",
  "analysis": "## 📌 今日要点\n...",
  "structured": {
    "sentiment": "分化",
    "riskLevel": "中",
    "keyThemes": ["AI", "地缘政治", "能源转型"],
    "sectors": ["科技", "能源"],
    "outlook": "短期维持高位震荡，关注美联储议息会议"
  },
  "sources": [...]
}
```
