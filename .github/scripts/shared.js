/**
 * 共享工具函数 — update-news.js 和 analyze.js 共用
 */

// 短标题阈值：低于此长度使用更严格的匹配策略
const SHORT_TITLE_LENGTH = 10;

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
 * v2: 对短标题（<10字符）使用更严格的策略
 */
function similarity(a, b, strictForShort = false) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  // 短标题优化：如果任一标题很短，使用更严格的匹配
  if (strictForShort && (a.length < SHORT_TITLE_LENGTH || b.length < SHORT_TITLE_LENGTH)) {
    // 短标题策略1：包含关系检查
    if (a.includes(b) || b.includes(a)) {
      // 较短的那个占较长的比例 >= 0.7 才视为重复
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      if (shorter.length / longer.length >= 0.7) return 0.9;
    }
    // 短标题策略2：编辑距离相似度（更准确但计算量大）
    return editDistanceSimilarity(a, b);
  }

  const aBg = charBigrams(a);
  const bBg = charBigrams(b);
  let intersection = 0;
  for (const bg of aBg) {
    if (bBg.has(bg)) intersection++;
  }
  return intersection / (aBg.size + bBg.size - intersection);
}

/**
 * 基于编辑距离的相似度计算（适用于短标题）
 * 归一化编辑距离 = 1 - (编辑距离 / max(len_a, len_b))
 */
function editDistanceSimilarity(a, b) {
  const lenA = a.length;
  const lenB = b.length;
  const maxLen = Math.max(lenA, lenB);
  if (maxLen === 0) return 1;

  // 动态规划计算编辑距离
  const dp = Array.from({ length: lenA + 1 }, () => Array(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // 删除
        dp[i][j - 1] + 1,      // 插入
        dp[i - 1][j - 1] + cost // 替换
      );
    }
  }

  const editDist = dp[lenA][lenB];
  return 1 - (editDist / maxLen);
}

module.exports = { isEnglish, charBigrams, similarity, SHORT_TITLE_LENGTH };
