#!/usr/bin/env node
/**
 * 裁剪分类新闻数据，每个分类最多保留 MAX_ITEMS 条（按日期倒序）
 * 用法: node trim-data.js [--max=200] [--dry-run]
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "..", "data", "news");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const maxArg = args.find((a) => a.startsWith("--max="));
const MAX_ITEMS = maxArg ? parseInt(maxArg.split("=")[1], 10) : 40;

// 跳过的文件
const SKIP = new Set([
  "meta.json",
  "dashboard.json",
  "events.json",
  "latest.json",
  "articles.json",
  "candidate-keywords.json",
]);

function trimFile(filePath) {
  const name = path.basename(filePath);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    console.error(`  ✗ ${name}: 解析失败 - ${e.message}`);
    return null;
  }

  if (!Array.isArray(data.items)) {
    console.log(`  - ${name}: 无 items 数组，跳过`);
    return null;
  }

  const original = data.items.length;
  if (original <= MAX_ITEMS) {
    console.log(`  - ${name}: ${original} 条，无需裁剪`);
    return null;
  }

  // 按日期倒序排列，保留最新的
  data.items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const removed = original - MAX_ITEMS;
  const oldestKept = data.items[MAX_ITEMS - 1]?.date || "?";
  data.items = data.items.slice(0, MAX_ITEMS);

  // P3: 确保裁剪后按日期倒序排列
  data.items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (!dryRun) {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
    fs.renameSync(tmp, filePath);
  }

  console.log(
    `  ${dryRun ? "🔍" : "✓"} ${name}: ${original} → ${MAX_ITEMS} (移除 ${removed} 条，最早保留: ${oldestKept})`,
  );
  return { file: name, original, kept: MAX_ITEMS, removed, oldestKept };
}

// 更新 meta.json 中的 count
function updateMetaCounts(trimResults) {
  const metaPath = path.join(DATA_DIR, "meta.json");
  if (!fs.existsSync(metaPath)) return;

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return;
  }

  let updated = 0;
  for (const r of trimResults) {
    if (!r) continue;
    const baseName = r.file.replace(".json", "");
    const cat = meta.categories.find((c) => c.file === baseName);
    if (cat && cat.count !== r.kept) {
      cat.count = r.kept;
      updated++;
    }
  }

  if (updated > 0 && !dryRun) {
    const tmp = metaPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf-8");
    fs.renameSync(tmp, metaPath);
    console.log(`\n  ✓ meta.json: 更新了 ${updated} 个分类的 count`);
  }
}

// 主逻辑
console.log(
  `\n📂 数据裁剪 (最多保留 ${MAX_ITEMS} 条/分类${dryRun ? ", dry-run 模式" : ""})\n`,
);

const files = fs
  .readdirSync(DATA_DIR)
  .filter((f) => f.endsWith(".json") && !SKIP.has(f))
  .sort();

const results = [];
for (const f of files) {
  const r = trimFile(path.join(DATA_DIR, f));
  results.push(r);
}

updateMetaCounts(results);

const trimmed = results.filter(Boolean);
const totalRemoved = trimmed.reduce((s, r) => s + r.removed, 0);
console.log(
  `\n📊 总计: 处理 ${files.length} 个文件，裁剪 ${trimmed.length} 个，移除 ${totalRemoved} 条\n`,
);
