# nase.me

自动聚合全球金融、科技、社科资讯的多元思考。

🔗 在线访问：[https://nase.me](https://nase.me)

## 覆盖领域

聚合全球财经资讯：

- 📈 股市与市场
- 💰 宏观经济
- 🏦 央行与利率
- 🛢️ 大宗商品与能源
- 🖥️ 科技与企业
- 🌍 国际财经

覆盖社会科学各领域：

- 👥 社会与人口
- 🏛️ 政治与治理
- 🧠 心理学与认知
- 🤖 科技与研究
- 🏥 健康与公共卫生
- 🌍 环境与能源
- 📚 教育与媒体
- ⚖️ 法律与伦理

## 技术特点

- 纯静态 HTML（单文件，零依赖，无框架）
- CSS：content-visibility: auto 跳过屏外渲染，LRU 缓存控制内存占用
- Node.js 脚本抓取、翻译、分类（MyMemory + Google Translate + DeepSeek 三通道）
- AI 深度分析（DeepSeek），支持每日视角轮换 + 历史记忆注入
- 90 天数据保留策略，自动清理过期数据
- GitHub Actions 定时任务
- GitHub Pages 托管

## 数据结构

```
data/
 news/
  meta.json                  # 分类元数据
  latest.json                # 最新 50 条新闻（首页快速加载）
  analysis.json              # AI 深度分析（最新副本）
  analysis/
   index.json                # 分析日期索引
   YYYY-MM-DD.json           # 每日分析文件（保留 90 天）
  股市与市场.json             # 分类新闻（最近 14 天）
  股市与市场_archive.json     # 分类新闻归档（14~90 天）
  宏观经济.json
  ...
```

## 更新频率

| 主题 | 频率 |
|------|------|
| 📰 全球资讯 | 每 2 天 |

北京时间 8:00 通过 GitHub Actions 自动运行，也可在 Actions 页面手动触发。

## License

MIT
