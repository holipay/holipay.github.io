# 2026-05-24 系统性审查与功能扩展

## 概览

本次会话对 nase.me 的 AI 分析系统进行了一次完整的系统性审查，涵盖：数据保留策略评估、前端交互优化、代码 bug 扫描、死代码清理、以及 4 项新功能的架构设计与实现。

涉及文件：`analyze.js`、`update-news.js`、`news.html`、`README.md`、`update-news.yml`

共 6 次提交：

| 提交 | 内容 |
|------|------|
| `c902b6e` | 保留期 30→90 天 + 移除日历控件 |
| `e4cc307` | 修复 5 个 bug |
| `28f0c89` | 清理死代码 |
| `7d22ead` | 事件链追踪 + 信号仪表盘 |
| `92d273b` | 月度报告增加异常检测 + 深度专题 |
| `677724e` | 历史分析语义检索 |

---

## 一、数据保留策略评估

### 背景

系统原有 30 天数据保留策略，用户提出疑问：是否太短？

### 分析过程

1. **读取代码**确认实际保留范围：
   - `update-news.js` 中 `RETENTION_DAYS = 30`
   - `analyze.js` 中 `ANALYSIS_RETENTION_DAYS = 30`
   - 每日分析文件 `YYYY-MM-DD.json` 保留 30 天
   - 月度分析也是同样的 30 天保留期

2. **关键问题识别**：月度回顾在每月 1-3 号生成，回顾上月数据。但 30 天保留期意味着到下个月 1 号时，上月初的分析可能已被删除——月度回顾只能看到不完整的数据。

3. **存储估算**：即使保留 90 天，所有 JSON 文件总大小 < 5MB，远低于 GitHub Pages 1GB 限制。

### 决策

- `RETENTION_DAYS`: 30 → 90（新闻数据）
- `ANALYSIS_RETENTION_DAYS`: 30 → 90（AI 分析文件）
- `TRENDS_RETENTION_DAYS` 保持 14 天不变（短期趋势追踪）
- `RECENT_DAYS` 保持 14 天不变（前端分片策略）

### 副作用处理

保留期延长后，`news.html` 前端只读主文件（14 天），第 15-90 天的数据存在 `_archive.json` 中但前端无法访问。这是一个**功能回退**，在后续 bug 修复中解决。

---

## 二、前端交互优化：移除日历控件

### 思考过程

月度报告保留多份后，日期跨度变大（可能跨 3 个月），日历选择器的价值下降——用户不太会精确记得某天有什么分析。前后翻页 + 正文中的日期显示已经足够。

### 改动

- `news.html`：`<input type="date">` → `<span class="date-text">`
- 删除 `.date-picker` / `.date-picker:focus` CSS
- 删除 `datePicker` 的 `change` 事件监听
- 删除 `index.json` 的 `<link rel="preload">`（不再需要选日期跳转）

**效果**：导航栏变为 `◀ 2026-05-22 ▶ 最新`，更简洁。

---

## 三、Bug 扫描与修复

对 `update-news.js` 和 `analyze.js` 进行了完整代码审查，发现 5 个 bug：

### Bug 1：`dedup()` 缺少 O(1) 精确匹配（🔴 性能）

**问题**：`dedup` 函数用 `seenNorms.includes(norm)` 做标题去重，O(n) 复杂度。历史标题越多，性能越差。

**修复**：新增 `seenNormsSet`（Set）用于 O(1) 精确匹配，`seenNormsArr`（Array）保留用于模糊匹配。同时为模糊匹配添加长度预过滤（bigram 相似度不可能超过 `min(a,b)/max(a,b)`），跳过不可能匹配的项。

### Bug 2：翻译缓存清理硬编码 30 天（🔴 功能）

**问题**：`saveCache()` 中清理过期缓存硬编码 `30 * 24 * 60 * 60 * 1000`，与 `RETENTION_DAYS` 脱节。数据保留 90 天但翻译缓存 30 天就清了，导致 60-90 天前的新闻去重时无法命中缓存，重复调用翻译 API。

**修复**：改为 `RETENTION_DAYS * 24 * 60 * 60 * 1000`。

### Bug 3：`loadLastMonthAnalyses` 误加载月度回顾文件（🟡 数据质量）

**问题**：过滤条件 `f.startsWith(prefix) && f.endsWith(".json")` 会匹配 `YYYY-MM-DD.json`（日度）和 `YYYY-MM.json`（月度）。如果上月 1 号生成了月度回顾，它会被混入日度分析数据中。

**修复**：添加 `/^\d{4}-\d{2}-\d{2}\.json$/` 正则过滤，只加载日度文件。

### Bug 4：前端不读 archive 文件（🔴 功能回退）

**问题**：`loadNewsForDate` 只读 `股市与市场.json`（14 天），从不读 `股市与市场_archive.json`（14-90 天）。保留期延长后，用户只能看到最近 14 天的新闻。

**修复**：`loadNewsForDate` 同时请求主文件 + `_archive.json`，用 `Promise.allSettled` 并行获取，合并后按日期过滤。

### Bug 5：`hotKeywords` 重复计算（🟢 性能）

**问题**：`main()` 中 `extractHotKeywords` 被调用两次（try 块内外），同名变量遮蔽。

**修复**：删除 try 块内的重复声明，复用外层变量。

---

## 四、死代码清理

### 删除 `dedup-existing.js`

一次性清理脚本，用于修复历史数据中的重复条目。工作流不引用，任何脚本不导入。已完成历史使命，删除。

### 删除 `isDuplicateOfHistory()` 函数

定义在 `update-news.js` 中的去重函数，接收 `existingTitlesSet` 参数用于 O(1) 精确匹配。但**从未被调用**——`dedup` 函数内自己实现了完整的去重逻辑。是死代码。

### 精简 `loadExistingTitles()`

该函数有三个 fallback 路径：
1. 读取分类文件（主路径）✅
2. 回退：读取 `data.json` ❌
3. 回退：扫描旧的按日期拆分的文件 ❌

`migrateToCategoryFiles` 在 `loadExistingTitles` 之前执行，会删除 `data.json` 和旧日期文件。Fallback 路径 2 和 3 永远不会成功——是防御性代码，删除后逻辑更清晰。

**净减少 221 行代码。**

---

## 五、新功能：事件链追踪

### 设计动机

每日分析是孤立的——今天分析"美联储维持利率"，明天分析"市场对鸽派信号反应"，但系统不知道这两条新闻是同一事件的延续。事件链追踪让 AI 能跨日追踪事件发展脉络。

### 数据结构

```json
// data/news/events.json
[
  {
    "id": "evt-20260520-美联储利率决策",
    "title": "美联储利率决策",
    "firstSeen": "2026-05-20",
    "lastSeen": "2026-05-24",
    "status": "active",
    "timeline": [
      {"date": "2026-05-20", "summary": "美联储维持利率不变", "sentiment": "中性"},
      {"date": "2026-05-24", "summary": "市场预期9月降息概率上升至60%", "sentiment": "看涨"}
    ],
    "relatedKeywords": ["美联储", "利率", "降息"]
  }
]
```

### 工作流程

1. **分析前**：`loadActiveEvents()` 加载活跃事件，`buildEventChainSection()` 注入 prompt
2. **AI 输出**：结构化摘要中新增 `eventChains` 字段，标注新闻与事件的关联
3. **分析后**：`updateEvents()` 合并更新，7 天无更新自动归档（`status: "stale"`），活跃上限 20 个

### 设计权衡

- **不单独生成文件**：事件链数据存在 `events.json` 中，由 `git add data/news/` 自动提交，workflow 无需修改
- **token 控制**：事件链上下文只注入活跃事件的标题和最新动态（~500 字），不注入完整 timeline，避免 prompt 膨胀
- **自动归档**：7 天无更新的事件标记为 stale，不删除（保留历史记录）

---

## 六、新功能：信号仪表盘

### 设计动机

每日分析的结构化数据（sentiment、riskLevel、hotKeywords）是宝贵的时序信号，但分析完就散落在各日文件中，无法看到趋势。仪表盘将这些信号累积起来，为前端可视化提供数据源。

### 数据结构

```json
// data/news/dashboard.json
{
  "days": [
    {
      "date": "2026-05-24",
      "sentiment": "看涨",
      "riskLevel": "中",
      "keyThemes": ["美联储", "AI芯片"],
      "sectors": ["科技", "金融"],
      "topKeywords": [{"keyword": "美联储", "score": 12.5, "count": 8}]
    }
  ],
  "keywordTrends": [
    {
      "keyword": "美联储",
      "avgScore7d": 11.2,
      "avgScore30d": 8.5,
      "trend": 32,
      "frequency7d": 6,
      "frequency30d": 18
    }
  ],
  "signals": [
    {"date": "2026-05-24", "sentiment": "看涨", "riskLevel": "中", "keywordCount": 10}
  ]
}
```

### 三个维度

| 字段 | 用途 | 前端用途 |
|------|------|----------|
| `days[]` | 90 天每日详情 | 表格/卡片展示 |
| `keywordTrends[]` | Top 30 关键词的 7d vs 30d 趋势 | 关键词云/趋势表 |
| `signals[]` | 精简时序 | 情绪/风险折线图 |

### 趋势计算

`keywordTrends` 通过 `aggregateKeywords()` 函数计算：
- 将 7 天和 30 天窗口内的关键词分数取平均
- `trend = (avgScore7d - avgScore30d) / avgScore30d * 100`
- 正值 = 升温，负值 = 降温

---

## 七、月度报告增强：异常检测 + 深度专题

### 思考过程

用户提出 #4（异常检测）和 #5（深度专题报告）两个功能。原始方案是独立生成文件，但用户指出这会"打破按时间顺序读取报告"。因此将两者融入月度回顾，作为新增的维度三和维度四。

### 维度三：异常信号深度解读

在 `buildMonthlyReviewPrompt` 中，函数自动从每日分析数据中检测三类异常：

1. **情绪急转**：相邻日 sentiment 从中性以外跳变（如看涨→看跌）
2. **关键词异动**：后半月首次出现且热度 > 5 的关键词（新主题涌现）
3. **风险升级**：riskLevel 从低/中跳升到高

检测结果作为结构化数据注入 prompt，AI 对每个异常进行深度解读：原因分析、影响评估、噪音/信号判断。

### 维度四：月度深度专题

从月度热点关键词中选出 2-3 个最值得关注的主题，进行垂直深度分析：
- 演变脉络（时间线）
- 驱动因素
- 关键参与者
- 联动关系
- 下月展望

### token 调整

月度回顾新增两个维度后，5000 tokens 不够用。修改 `callDeepSeek` 支持可选的 `maxTokens` 参数，月度回顾调用时传入 8000。

---

## 八、历史分析语义检索

### 设计动机

`loadPreviousAnalyses` 原来简单地取"最近 N 条"历史分析注入 prompt 作为记忆。问题是：最近的分析可能和今天的话题完全无关，浪费 token 且无法延续分析脉络。

### 方案选择

| 方案 | 优点 | 缺点 |
|------|------|------|
| 外部 Embedding API（OpenAI/Cohere） | 语义理解最强 | 需要额外 API key、增加延迟和成本 |
| 本地 embedding 模型 | 无外部依赖 | Node.js 生态不成熟，模型文件大 |
| **基于结构化数据的关键词匹配** | 零依赖、零成本、即时生效 | 语义理解有限，依赖 AI 输出质量 |

选择方案三——系统已经有 `keyThemes`、`sectors`、`hotKeywords` 等高质量结构化数据，直接复用。

### 实现

```javascript
function computeRelevance(target, candidate) {
  let score = 0;
  // 主题匹配（权重 3）
  for (const t of candidateThemes) {
    if (targetThemes.has(t)) score += 3;
  }
  // 行业匹配（权重 2）
  for (const s of candidateSectors) {
    if (targetSectors.has(s)) score += 2;
  }
  // 关键词重叠（权重 1）
  score += kwOverlap;
  // 时间衰减（30天内递减加分）
  score += recencyBonus;
  return score;
}
```

### 权重设计逻辑

- **主题 ×3**：keyThemes 是 AI 从分析中提炼的核心概念，匹配度最高
- **行业 ×2**：sectors 反映分析的行业视角，跨行业分析参考价值有限
- **关键词 ×1**：hotKeywords 是原始数据，粒度最细但噪音最多
- **时间衰减 +0~1**：同等匹配度下偏好近期分析，但不主导结果

### 效果

- 今日热点"美联储+降息"→ 自动选出历史上也讨论过美联储的分析
- 避免重复：最近几天都在分析同一话题时，会选出角度不同的历史分析
- 延续脉络：上周深度分析过的话题再次出现时能自动关联

---

## 技术笔记

### GitHub API 提交

在本次会话后期，`git clone`/`git push` 频繁因 GnuTLS 网络错误失败。改用 GitHub Contents API 直接提交单文件：

```bash
# 1. 获取文件 SHA
SHA=$(curl -sL -H "Authorization: token $TOKEN" \
  "https://api.github.com/repos/$REPO/contents/$FILE" | python3 -c "...")

# 2. Base64 编码 + 构造 payload
CONTENT=$(base64 -w0 analyze.js)
python3 -c 'import json; json.dump({...}, open("payload.json","w"))'

# 3. PUT 提交
curl -sL -X PUT -H "Authorization: token $TOKEN" \
  -d @payload.json \
  "https://api.github.com/repos/$REPO/contents/$FILE"
```

**适用场景**：网络不稳定时提交单文件修改。多文件修改仍需 `git push`。

### Node.js 语法检查

每次修改后用 `node -c analyze.js` 做语法检查，避免提交有语法错误的代码。
