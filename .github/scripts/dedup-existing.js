/**
 * 一次性清理脚本：去除现有分类文件中的重复条目
 * 
 * 运行方式：node .github/scripts/dedup-existing.js
 * 
 * 修复以下 bug 导致的重复数据：
 *   1. link 字段在写入时被丢弃，URL 去重失效
 *   2. 翻译后用英文标题去重但历史数据是中文，语言不匹配
 *   3. normalizeTitle 未覆盖中文源名后缀
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(ROOT, "data/news");
const SIMILARITY_THRESHOLD = 0.75;

// ==================== normalizeTitle (与 update-news.js 一致) ====================
function normalizeTitle(title) {
  return (title || "")
    .replace(
      /^[\u{1F4B8}\u{1F393}\u{1F4F1}\u{1F4F0}\u{1F6E2}\u{1F4C8}\u{1F3E6}\u{1F4B0}\u{1F5A5}\u{1F30D}\u{1F916}\u{1F9E0}\u{1F465}\u{1F3DB}\u{1F4D6}\u{2699}\u{1F3E5}\u{1F4DA}\u{2696}\u{1F697}\u{1F3E0}\u{1F4CA}\u{1F4B8}\u{1F393}\u{1F4F1}\u{1F4F0}\u{1F6E2}\u{1F4C8}\u{1F3E6}\u{1F4B0}\u{1F5A5}\u{1F30D}\u{1F916}\u{1F9E0}\u{1F465}\u{1F3DB}\u{1F4D6}\u{2699}\u{1F3E5}\u{1F4DA}\u{2696}\u{1F697}\u{1F3E0}\u{1F4CA}]+/gu,
      "",
    )
    .replace(/^[\s\-\u2013\u2014\u00B7\uFF5C\uFF1A:]+/, "")
    .replace(
      /\s*[\-\u2013\u2014]\s*(Reuters|Bloomberg\.com|Bloomberg|WSJ|CNBC|Financial Times|FT|BBC|CNN|NBER|36\u6C2A|IT\u4E4B\u5BB6|\u65B0\u6D6A\u8D22\u7ECF|\u89C2\u5BDF\u8005|\u7231\u8303\u513F|Sohu|\u4E1C\u65B9\u8D22\u5BCC|\u51E4\u51F0\u7F51\u79D1\u6280|\u6295\u8D44\u8005\u5546\u4E1A\u65E5\u62A5|\u534E\u5C14\u8857\u65E5\u62A5|\u96C5\u864E\u8D22\u7ECF|\u5F6D\u535A\u793E|\u534A\u5C9B\u7535\u89C6\u53F0|\u300A\u7ECF\u6D4E\u5B66\u4EBA\u300B|\u300A\u534E\u5C14\u8857\u65E5\u62A5\u300B|\u300A\u91D1\u878D\u65F6\u62A5\u300B|\u300A\u524D\u6CBF\u300B|\u82F1\u56FD\u300A\u91D1\u878D\u65F6\u62A5\u300B|\u82F1\u56FD\u300A\u91D1\u878D\u65F6\u62A5\u300B|\u534E\u5C14\u8857\u65E5\u62A5|\u91D1\u878D\u65F6\u62A5|\u7ECF\u6D4E\u5B66\u4EBA|\u300A\u829D\u52A0\u54E5\u8BBA\u575B\u62A5\u300B|\u300A\u534B\u76DB\u987F\u90AE\u62A5\u300B|PBS|KERA News|CEPR|\u76D6\u6D1B\u666E\u65B0\u95FB|\u65F6\u4EE3\u6742\u5FD7|\u9EA6\u80AF\u9521\u516C\u53F8|Investopedia|The Conversation|Foreign Affairs|Pew Research|Google News Academic|Moneycontrol\.com|NBER|MacroMicro|Economics Observatory)\s*$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ==================== bigram 相似度 ====================
function charBigrams(text) {
  const bigrams = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    bigrams.add(text.slice(i, i + 2));
  }
  return bigrams;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aBg = charBigrams(a);
  const bBg = charBigrams(b);
  let intersection = 0;
  for (const bg of aBg) {
    if (bBg.has(bg)) intersection++;
  }
  return intersection / (aBg.size + bBg.size - intersection);
}

// ==================== 去重 ====================
function dedupItems(items) {
  const seenUrls = new Set();
  const seenNorms = [];
  const result = [];

  for (const item of items) {
    // URL 去重
    if (item.link) {
      if (seenUrls.has(item.link)) continue;
      seenUrls.add(item.link);
    }

    const norm = normalizeTitle(item.title).slice(0, 80);
    if (!norm) {
      result.push(item);
      continue;
    }

    // 精确标题匹配
    if (seenNorms.includes(norm)) continue;

    // 模糊匹配
    let isDup = false;
    for (const sn of seenNorms) {
      if (similarity(norm, sn) >= SIMILARITY_THRESHOLD) {
        isDup = true;
        break;
      }
    }
    if (isDup) continue;

    seenNorms.push(norm);
    result.push(item);
  }

  return result;
}

// ==================== 主逻辑 ====================
function main() {
  console.log("🧹 清理重复数据...\n");

  if (!fs.existsSync(DATA_DIR)) {
    console.error("❌ data/news 目录不存在");
    process.exit(1);
  }

  const catFiles = fs
    .readdirSync(DATA_DIR)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        f !== "meta.json" &&
        f !== "data.json" &&
        f !== "index.json" &&
        f !== "latest.json" &&
        f !== "analysis.json" &&
        !f.endsWith("_archive.json") &&
        !/^\d{4}-\d{2}-\d{2}\.json$/.test(f),
    );

  let totalBefore = 0;
  let totalAfter = 0;

  for (const file of catFiles) {
    const filePath = path.join(DATA_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const items = data.items || [];
      const before = items.length;
      totalBefore += before;

      const deduped = dedupItems(items);
      const after = deduped.length;
      totalAfter += after;

      if (before !== after) {
        data.items = deduped;
        data.updatedAt = new Date().toISOString();
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
        fs.renameSync(tmp, filePath);
        console.log(`  ✅ ${file}: ${before} → ${after} (-${before - after})`);
      } else {
        console.log(`  ⏭️  ${file}: ${before} 条，无重复`);
      }
    } catch (e) {
      console.error(`  ❌ ${file}: ${e.message}`);
    }
  }

  console.log(`\n📊 总计: ${totalBefore} → ${totalAfter} (清理 ${totalBefore - totalAfter} 条重复)`);
}

main();
