# nase.me 开发日志

## 2026-05-10 ~ 2026-05-11：性能优化与功能扩展

### 一、首页加载优化

**问题**：首页打开时需要并行加载所有分类 JSON（几百KB），用户等待时间长。

**方案**：增加 `latest.json` 作为首页默认内容。

**改动文件**：
- `app.js` — 首页默认加载 `latest.json`（~10KB），点击分类再按需加载
- `index.html` — preload 改为 `latest.json`
- `.github/scripts/update-news.js` — 构建时自动生成 `latest.json`（最新 50 条）
- `data/*/latest.json` — 三个主题各生成一份

**效果**：首页首屏从几百KB → 10KB，秒开。

---

### 二、P0 优化：Service Worker + 渲染逻辑重构

#### 2.1 Service Worker (`sw.js`)
- 静态资源（HTML/CSS/JS）：`cache-first` 策略，缓存后直接读本地
- 数据 JSON：`stale-while-revalidate` 策略，先返回缓存数据（秒显示），后台更新
- 二次访问秒开，断网也能看已缓存内容

#### 2.2 渲染逻辑重构
| 之前 | 之后 |
|------|------|
| `renderLatest` 和 `renderContent` 各自拼 HTML | 提取 `render.newsItems()` + `render.card()` 公共函数 |
| 两个 `showMore` 函数 | 统一为 `ui.expandMore()` |
| 26 处 `onclick="app.xxx()"` 内联字符串 | 全部改为事件委托 `addEventListener` |
| 每次搜索创建新 RegExp | `getSearchRegex()` 缓存，query 不变时复用 |

---

### 三、P1 优化：dedup 性能

**问题**：构建脚本中 `dedup` 函数对每条新标题遍历全部历史标题做 bigram 相似度计算，O(n×m) 复杂度。

**优化**：
- `seenNorms`：`Array.includes` O(n) → `Set.has` O(1)
- 精确匹配：新增 `existingTitlesSet` 预构建 Set
- 模糊匹配：增加长度比预筛选 `minLen/maxLen < threshold`，跳过不可能匹配的比较

---

### 四、P2 优化：翻译提速 + 分类分片

#### 4.1 翻译并发
- `TRANSLATE_CONCURRENCY`：3 → 8

#### 4.2 分类 JSON 按日期分片
- 构建时自动拆分：`{cat}.json`（最近 14 天）+ `{cat}_archive.json`（更早）
- `meta.json` 增加 `archiveCount` 字段
- 前端按需加载 archive，初始只加载 recent 数据
- 数据老化后自动生效

---

### 五、分类预加载

**问题**：点击分类筛选时首次加载慢（分类 JSON 文件较大）。

**方案**：
1. **后台静默预加载**：首页 `latest.json` 加载完后，后台静默加载前 3 个分类 JSON
2. **Hover 预取**：鼠标移到分类按钮上时，立即开始加载该分类数据

**效果**：大部分用户点击路径（看到 → hover → 点击）都能命中缓存。

---

### 六、每日摘要卡片 + 趋势热词

#### 6.1 每日摘要卡片
- 总资讯数 + 今日新增
- 近 14 天日期分布迷你柱状图
- 来源分布横向条形图（Top 6）
- 搜索时自动隐藏

#### 6.2 趋势热词
- 从标题提取中英文关键词（自动过滤 200+ 停用词）
- 按出现频率排序，显示 Top 20
- 点击热词自动触发搜索
- 仅在非搜索状态下显示

---

### 七、AI 深度分析

**方案**：构建时调用 DeepSeek API → 生成静态 `analysis.json` → 前端直接展示。

**改动文件**：
- `.github/scripts/analyze.js` — AI 分析脚本
- `.github/workflows/*.yml` — 三个 workflow 均集成分析步骤
- `app.js` — 新增分析卡片渲染
- `styles.css` — 分析卡片样式（渐变顶部光效 + Markdown 渲染）

**分析内容**：
- 📌 今日要点
- 🔍 深度解读（2-3 个趋势/事件）
- 📊 市场信号（看涨/看跌/中性）
- ⚠️ 风险提示
- 🔮 前瞻展望

**AI 选型**：

| 模型 | 输入价格 | 输出价格 | 适用场景 |
|------|---------|---------|---------|
| DeepSeek V4-Flash | ¥1/M | ¥2/M | 新闻分析（性价比最优） |
| DeepSeek V4-Pro | ¥0.1/M（限时） | ¥6/M | 需要更强推理能力 |
| MiMo V2-Flash | ¥0.7/M | ¥2.1/M | Agent/全模态任务 |

**日成本估算**：3 主题 × 7K tokens ≈ ¥0.05/天（约 ¥1.5/月）

**配置**：GitHub Secrets 需添加 `DEEPSEEK_API_KEY`

---

### 八、项目文件结构

```
holipay.github.io/
├── index.html              # 首页
├── app.js                  # 前端逻辑
├── styles.css              # 样式
├── sw.js                   # Service Worker
├── data/
│   ├── finance/
│   │   ├── meta.json       # 分类元数据
│   │   ├── latest.json     # 首页快速加载（50条）
│   │   ├── analysis.json   # AI 深度分析
│   │   ├── 宏观经济.json    # 分类数据
│   │   ├── 股市与市场.json
│   │   └── ...
│   ├── social-science/
│   └── xiaomi/
├── docs/                   # 项目文档
│   └── development-log.md
└── .github/
    ├── scripts/
    │   ├── update-news.js  # 新闻抓取引擎
    │   └── analyze.js      # AI 分析引擎
    └── workflows/
        ├── update-finance.yml
        ├── update-xiaomi.yml
        └── update-social-science.yml
```

---

### 九、待办事项

- [ ] GitHub 添加 Secret `DEEPSEEK_API_KEY`
- [ ] 手动触发一次 workflow 验证完整流程
- [ ] 考虑增加 RSS Feed 输出
- [ ] 考虑增加日期分组浏览
- [ ] 考虑增加来源筛选功能
