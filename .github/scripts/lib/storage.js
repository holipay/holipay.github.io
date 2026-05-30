/**
 * 通用 JSON 缓存存储 + 数据持久化
 * 从 update-news.js 和 analyze.js 提取，消除重复代码
 */

const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");

function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, filePath);
}

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {}
  return null;
}

function saveJson(filePath, data, { compact = true } = {}) {
  const json = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  atomicWrite(filePath, json);
}

function loadJsonCache(filePath, label = "数据") {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const count = Object.keys(data).length;
      if (count > 0) console.log(`📦 加载${label}: ${count} 条`);
      return data;
    }
  } catch {}
  return {};
}

function saveJsonCache(filePath, cache, {
  retentionDays = 30,
  maxSize = 3000,
  compact = true,
  label = "数据",
  dirtyCheck = null,
} = {}) {
  if (dirtyCheck && !dirtyCheck()) {
    console.log(`📦 ${label}未变更，跳过保存`);
    return;
  }

  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const [key, entry] of Object.entries(cache)) {
      if (entry.ts && entry.ts < cutoff) delete cache[key];
    }

    const entries = Object.entries(cache);
    if (entries.length > maxSize) {
      entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
      const evictCount = entries.length - maxSize;
      const toKeep = entries.slice(0, maxSize);
      Object.keys(cache).forEach((k) => delete cache[k]);
      for (const [k, v] of toKeep) cache[k] = v;
      console.log(`🗑️ ${label}淘汰 ${evictCount} 条旧数据，保留 ${maxSize} 条`);
    }

    const json = compact ? JSON.stringify(cache) : JSON.stringify(cache, null, 2);
    atomicWrite(filePath, json);
    console.log(`💾 保存${label}: ${Object.keys(cache).length} 条`);
  } catch (e) {
    console.error(`⚠️ ${label}保存失败:`, e.message);
  }
}

// ===== 数据持久化（新闻分类文件读写） =====

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

function isCategoryFormat(dataDir) {
  if (!fs.existsSync(dataDir)) return false;
  const catFiles = fs
    .readdirSync(dataDir)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        f !== "meta.json" &&
        f !== "data.json" &&
        f !== "index.json" &&
        f !== "titles-index.json" &&
        f !== "latest.json" &&
        !f.endsWith("_archive.json") &&
        !/^\d{4}-\d{2}-\d{2}\.json$/.test(f),
    );
  return catFiles.length > 0;
}

function migrateToCategoryFiles(dataDir, topic, { retentionDays = 30, categoryItemLimits = {} } = {}) {
  if (isCategoryFormat(dataDir)) return;
  if (!fs.existsSync(dataDir)) return;

  const maxItems = 40;

  const dataFile = path.join(dataDir, "data.json");
  if (fs.existsSync(dataFile)) {
    console.log("📦 迁移 data.json 到按分类存储...");
    const data = JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    if (data.sections) {
      const categoryMeta = [];
      for (const sec of data.sections) {
        const catFile = path.join(dataDir, `${sanitizeFilename(sec.title)}.json`);
        atomicWrite(catFile, JSON.stringify({
          icon: sec.icon, title: sec.title,
          updatedAt: new Date().toISOString(), items: sec.items,
        }, null, 2));
        categoryMeta.push({
          icon: sec.icon, title: sec.title,
          file: sanitizeFilename(sec.title), count: sec.items.length,
        });
      }
      atomicWrite(path.join(dataDir, "meta.json"), JSON.stringify({
        topic: topic.id, name: topic.name, icon: topic.icon,
        updatedAt: new Date().toISOString(), categories: categoryMeta,
      }, null, 2));
      fs.unlinkSync(dataFile);
      console.log(`✅ 迁移完成: ${categoryMeta.length} 个分类`);
    }
    return;
  }

  const dayFiles = fs.readdirSync(dataDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (dayFiles.length === 0) return;

  console.log(`📦 迁移 ${dayFiles.length} 个日期文件到按分类存储...`);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const sectionsMap = new Map();
  let migratedCount = 0;

  for (const file of dayFiles) {
    const filePath = path.join(dataDir, file);
    const date = file.replace(".json", "");
    if (date < cutoff) { fs.unlinkSync(filePath); continue; }
    try {
      const dayData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!dayData.sections) { fs.unlinkSync(filePath); continue; }
      for (const sec of dayData.sections) {
        if (!sectionsMap.has(sec.title)) {
          sectionsMap.set(sec.title, { icon: sec.icon, title: sec.title, items: [] });
        }
        for (const item of sec.items) {
          sectionsMap.get(sec.title).items.push({ ...item, date });
          migratedCount++;
        }
      }
      fs.unlinkSync(filePath);
    } catch {}
  }

  const categoryMeta = [];
  for (const [title, sec] of sectionsMap) {
    sec.items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const catLimit = categoryItemLimits[sec.title] || maxItems;
    if (sec.items.length > catLimit) sec.items = sec.items.slice(0, catLimit);
    const catFile = path.join(dataDir, `${sanitizeFilename(title)}.json`);
    atomicWrite(catFile, JSON.stringify({
      icon: sec.icon, title: sec.title,
      updatedAt: new Date().toISOString(), items: sec.items,
    }, null, 2));
    categoryMeta.push({
      icon: sec.icon, title: sec.title,
      file: sanitizeFilename(title), count: sec.items.length,
    });
  }

  atomicWrite(path.join(dataDir, "meta.json"), JSON.stringify({
    topic: topic.id, name: topic.name, icon: topic.icon,
    updatedAt: new Date().toISOString(), categories: categoryMeta,
  }, null, 2));

  const oldIndex = path.join(dataDir, "index.json");
  if (fs.existsSync(oldIndex)) fs.unlinkSync(oldIndex);
  console.log(`✅ 迁移完成: ${migratedCount} 条记录 → ${categoryMeta.length} 个分类`);
}

async function writeCategoryFiles(dataDir, sections, {
  today,
  cutoff,
  recentCutoff,
  categoryItemLimits = {},
  maxItems = 40,
  normalizeTitle,
}) {
  const categoryMeta = [];
  const safeNameMap = new Map(sections.map((s) => [s.title, sanitizeFilename(s.title)]));
  const existingDataMap = new Map();

  const readTasks = sections.map(async (sec) => {
    const safeName = safeNameMap.get(sec.title);
    const catFile = path.join(dataDir, `${safeName}.json`);
    const archiveFile = path.join(dataDir, `${safeName}_archive.json`);
    let items = [];
    try {
      const existing = JSON.parse(await fsPromises.readFile(catFile, "utf-8"));
      items = existing.items || [];
    } catch {}
    try {
      const arch = JSON.parse(await fsPromises.readFile(archiveFile, "utf-8"));
      items = [...items, ...(arch.items || [])];
    } catch {}
    existingDataMap.set(safeName, items);
  });
  await Promise.all(readTasks);

  for (const sec of sections) {
    const safeName = safeNameMap.get(sec.title);
    const catFile = path.join(dataDir, `${safeName}.json`);
    const archiveFile = path.join(dataDir, `${safeName}_archive.json`);
    const existingItems = existingDataMap.get(safeName) || [];

    const newItems = sec.items.map(({ titleEN, ...rest }) => ({ ...rest, date: today }));

    const existingMap = new Map();
    for (const item of existingItems) {
      const norm = normalizeTitle(item.title).slice(0, 80);
      if (norm) existingMap.set(norm, item);
    }
    const trulyNew = [];
    let linkBackfilled = 0;
    for (const item of newItems) {
      const norm = normalizeTitle(item.title).slice(0, 80);
      if (!norm) continue;
      const existing = existingMap.get(norm);
      if (!existing) {
        trulyNew.push(item);
      } else if (!existing.link && item.link) {
        existing.link = item.link;
        linkBackfilled++;
      }
    }
    if (linkBackfilled > 0) console.log(`  🔗 ${sec.title}: 回填 ${linkBackfilled} 条链接`);
    if (trulyNew.length > 0) console.log(`  ➕ ${sec.title}: 新增 ${trulyNew.length} 条`);

    const mergedItems = [...trulyNew, ...existingItems];
    const seenTitles = new Set();
    const filteredItems = mergedItems.filter((item) => {
      if ((item.date || today) < cutoff) return false;
      const norm = normalizeTitle(item.title).slice(0, 80);
      if (!norm) return true;
      if (seenTitles.has(norm)) return false;
      seenTitles.add(norm);
      return true;
    });
    const catLimit = categoryItemLimits[sec.title] || maxItems;
    const finalItems = filteredItems.slice(0, catLimit);
    const dedupeRemoved = mergedItems.filter((i) => (i.date || today) >= cutoff).length - filteredItems.length;
    if (dedupeRemoved > 0) console.log(`  🔄 ${sec.title}: 合并去重移除 ${dedupeRemoved} 条`);

    const recentItems = finalItems.filter((item) => (item.date || today) >= recentCutoff);
    const archiveItems = finalItems.filter((item) => (item.date || today) < recentCutoff);
    recentItems.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    archiveItems.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    atomicWrite(catFile, JSON.stringify({
      icon: sec.icon, title: sec.title,
      updatedAt: new Date().toISOString(), items: recentItems,
    }, null, 2));

    if (archiveItems.length > 0) {
      atomicWrite(archiveFile, JSON.stringify({
        icon: sec.icon, title: sec.title,
        updatedAt: new Date().toISOString(), items: archiveItems,
      }, null, 2));
    } else if (fs.existsSync(archiveFile)) {
      fs.unlinkSync(archiveFile);
    }

    categoryMeta.push({
      icon: sec.icon, title: sec.title, file: safeName,
      count: recentItems.length, archiveCount: archiveItems.length,
    });
  }

  return categoryMeta;
}

function cleanOldCategories(dataDir, categoryMeta, { today, cutoff, maxItems = 40 }) {
  const existingCatFiles = fs.readdirSync(dataDir).filter(
    (f) =>
      f.endsWith(".json") &&
      f !== "meta.json" &&
      f !== "data.json" &&
      f !== "index.json" &&
      f !== "titles-index.json" &&
      f !== "latest.json" &&
      !f.endsWith("_archive.json") &&
      !/^\d{4}-\d{2}-\d{2}\.json$/.test(f),
  );

  for (const file of existingCatFiles) {
    const catTitle = file.replace(".json", "");
    if (categoryMeta.find((c) => sanitizeFilename(c.title) === catTitle)) continue;
    try {
      const catData = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf-8"));
      catData.items = catData.items.filter((item) => (item.date || today) >= cutoff);
      if (catData.items.length > maxItems) catData.items = catData.items.slice(0, maxItems);
      catData.updatedAt = new Date().toISOString();
      atomicWrite(path.join(dataDir, file), JSON.stringify(catData, null, 2));
      categoryMeta.push({
        icon: catData.icon, title: catData.title,
        file: sanitizeFilename(catData.title), count: catData.items.length, archiveCount: 0,
      });
    } catch {}
  }
}

function generateMetaJson(dataDir, topic, categoryMeta) {
  atomicWrite(path.join(dataDir, "meta.json"), JSON.stringify({
    topic: topic.id, name: topic.name, icon: topic.icon,
    updatedAt: new Date().toISOString(), categories: categoryMeta,
  }, null, 2));
}

function generateLatestJson(dataDir, categoryMeta, today) {
  const LATEST_ITEMS = 100;
  const latestAll = [];
  for (const cat of categoryMeta) {
    try {
      const catPath = path.join(dataDir, `${cat.file}.json`);
      const catData = JSON.parse(fs.readFileSync(catPath, "utf-8"));
      for (const item of catData.items || []) {
        latestAll.push({
          title: item.title, source: item.source || "",
          date: item.date || today, category: cat.title,
        });
      }
    } catch {}
  }
  latestAll.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const latestItems = latestAll.slice(0, LATEST_ITEMS);
  atomicWrite(path.join(dataDir, "latest.json"), JSON.stringify({
    updatedAt: new Date().toISOString(), items: latestItems,
  }, null, 2));
  console.log(`⚡ 已生成 latest.json: ${latestItems.length} 条`);
}

function cleanupOldFiles(dataDir) {
  const oldDataFile = path.join(dataDir, "data.json");
  if (fs.existsSync(oldDataFile)) fs.unlinkSync(oldDataFile);
  const oldIndex = path.join(dataDir, "index.json");
  if (fs.existsSync(oldIndex)) fs.unlinkSync(oldIndex);
  const oldDayFiles = fs.readdirSync(dataDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const old of oldDayFiles) fs.unlinkSync(path.join(dataDir, old));
}

function saveTitlesIndex(dataDir, titles) {
  const indexPath = path.join(dataDir, "titles-index.json");
  atomicWrite(indexPath, JSON.stringify({ updatedAt: new Date().toISOString(), titles }));
}

function collectAllTitles(dataDir, categoryMeta, normalizeTitle) {
  const allTitles = new Set();
  for (const cat of categoryMeta) {
    try {
      const catPath = path.join(dataDir, `${cat.file}.json`);
      const catData = JSON.parse(fs.readFileSync(catPath, "utf-8"));
      for (const item of catData.items || []) {
        const norm = normalizeTitle(item.title).slice(0, 80);
        if (norm) allTitles.add(norm);
      }
    } catch {}
    if (cat.archiveCount > 0) {
      try {
        const archPath = path.join(dataDir, `${cat.file}_archive.json`);
        const archData = JSON.parse(fs.readFileSync(archPath, "utf-8"));
        for (const item of archData.items || []) {
          const norm = normalizeTitle(item.title).slice(0, 80);
          if (norm) allTitles.add(norm);
        }
      } catch {}
    }
  }
  return allTitles;
}

module.exports = {
  atomicWrite, loadJson, saveJson, loadJsonCache, saveJsonCache,
  sanitizeFilename, isCategoryFormat, migrateToCategoryFiles,
  writeCategoryFiles, cleanOldCategories, generateMetaJson,
  generateLatestJson, cleanupOldFiles, saveTitlesIndex, collectAllTitles,
};
