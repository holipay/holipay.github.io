# 📰 小米每日资讯

每日自动整理小米相关新闻，按分类呈现，支持 RSS 订阅。

🔗 **在线访问**：https://holipay.github.io/xiaomi-daily-news/

📡 **RSS 订阅**：https://holipay.github.io/xiaomi-daily-news/feed.xml

## 功能

- 🤖 每日 9:00（北京时间）自动抓取更新
- 📂 智能分类：小米汽车、AI/大模型、手机市场、IoT/生态链、公司动态
- 🔗 每条新闻保留原文链接，点击直达
- 🏷️ 标注新闻来源（Google News、36氪、IT之家、新浪科技）
- 🔍 支持标题搜索
- 🌙 自动适配深色模式
- 📡 标准 RSS 2.0 feed，每条新闻独立 item
- 📱 移动端友好

## 数据来源

### 中文源
| 来源 | 类型 | 说明 |
|------|------|------|
| Google News | RSS | 搜索"小米"关键词 |
| 36氪 | API | 搜索接口 |
| IT之家 | RSS | 全站 RSS 过滤小米相关 |
| 新浪科技 | API | 滚动新闻接口 |

### 英文源
| 来源 | 类型 | 说明 |
|------|------|------|
| Google News EN | RSS | 英文搜索 Xiaomi |
| GSMArena | RSS | 手机评测，过滤小米相关 |
| Android Authority | RSS | 安卓资讯，过滤小米相关 |
| Gizchina | RSS | 中国科技英文媒体 |
| Gizmochina | RSS | 中国科技英文媒体 |

## 技术栈

- 纯静态 HTML（零依赖，无框架）
- Node.js 脚本抓取 + 分类
- GitHub Actions 定时任务
- GitHub Pages 托管

## 自动更新

每天北京时间 9:00 通过 GitHub Actions 自动运行，也可在 Actions 页面手动触发。

## License

MIT
