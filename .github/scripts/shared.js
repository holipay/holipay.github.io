/**
 * 共享工具函数 — update-news.js 和 analyze.js 共用
 */

/**
 * 判断文本是否为英文（或英中混合偏英文）
 * v2: 快速路径 — 无中文字符时直接检查是否有英文字母，避免昂贵正则替换
 */
function isEnglish(text) {
  if (!/[\u4e00-\u9fff]/.test(text)) {
    return /[a-zA-Z]/.test(text);
  }
  const letters = text.replace(
    /[\s\d.,!?@#$%^&*()\-+='";:/<>[\]{}|\\`~\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g,
    "",
  );
  if (!letters.length) return false;
  const ascii = letters.replace(/[^\x00-\x7F]/g, "");
  return ascii.length / letters.length > 0.7;
}

/**
 * 提取字符串的字符二元组 (bigrams)
 */
function charBigrams(text) {
  const bigrams = new Set();
  for (let i = 0; i < text.length - 1; i++) {
    bigrams.add(text.slice(i, i + 2));
  }
  return bigrams;
}

/**
 * 计算两个字符串的 Jaccard 相似度 (0~1)
 */
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

module.exports = { isEnglish, charBigrams, similarity };
