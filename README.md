# 📰 纳思 — 海纳百思

每日自动聚合全球金融、社科前沿、科技资讯的多元思考。

🔗 **在线访问**：https://nase.me

## 内容板块

### 💹 全球金融
聚合全球财经资讯：
- 📈 股市与市场
- 💰 宏观经济
- 🏦 央行与利率
- 🛢️ 大宗商品与能源
- 🖥️ 科技与企业
- 🌍 国际财经

### 🎓 社科前沿
覆盖社会科学各领域：
- 👥 社会与人口
- 🏛️ 政治与治理
- 💰 经济与金融
- 🤖 科技与研究
- 🏥 健康与公共卫生
- 📚 教育与媒体
- ⚖️ 法律与伦理

### 📱 小米资讯
自动抓取并分类小米相关新闻：
- 🚗 小米汽车
- 🤖 AI / 大模型
- 📱 手机市场
- 📊 公司动态
- 🏠 IoT / 生态链

## 数据来源

**中文源**：Google News、36氪、IT之家、新浪科技

**英文源**：Google News EN、GSMArena、Android Authority、Gizchina、Gizmochina 等

## 技术栈

- 纯静态 HTML（单文件，零依赖，无框架）
- CSS：`content-visibility: auto` 跳过屏外渲染，`contain` 限制重排范围
- JS：按日期拆分文件按需加载，topic 级内存缓存，hover 预加载相邻 topic
- Node.js 脚本抓取、翻译、分类（MyMemory + Google Translate 双通道）
- GitHub Actions 定时任务
- GitHub Pages 托管

## 数据结构

```
data/
  {topic}/
    index.json          # 日期索引（最近 365 天）
    2026-05-03.json     # 按天拆分的新闻数据
    2026-05-02.json
    ...
```

每个 topic 独立目录，前端只加载需要的那一天，减少传输量。

## 自动更新

| 主题 | 频率 |
|------|------|
| 💹 全球金融 | 每 2 天 |
| 📱 小米资讯 | 每周一 |
| 🎓 社科前沿 | 每月 1 号 |

北京时间 8:00 通过 GitHub Actions 自动运行，也可在 Actions 页面手动触发。

## License

MIT
