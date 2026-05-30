/**
 * 事件链管理
 * 从 analyze.js 提取
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./date-utils.js");

const EVENTS_FILE = path.join(DATA_DIR, "events.json");
const MAX_ACTIVE_EVENTS = 20;
const EVENT_STALE_DAYS = 7; // 超过7天无更新自动归档

function loadActiveEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf-8"));
    return all.filter((e) => e.status === "active");
  } catch {
    return [];
  }
}

function buildEventChainSection(events) {
  if (events.length === 0) return "";
  const lines = events
    .filter((e) => Array.isArray(e.timeline) && e.timeline.length > 0)
    .map((e) => {
      const last = e.timeline[e.timeline.length - 1];
      const days = Math.round((new Date() - new Date(e.firstSeen)) / 86400000);
      return `  - **${e.title}**（${days}天前起始，${e.timeline.length}条动态）→ 最新: ${last.summary}`;
    });
  if (lines.length === 0) return "";
  return `

━━━ 🔗 活跃事件链（跟踪中的持续性事件）━━━
${lines.join("\n")}
说明: 如果今日新闻中有这些事件的后续发展，请在 eventChains 中标注 event_id 并更新。如果事件已结束，标记 status="resolved"。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function updateEvents(existingEvents, eventChains, dateStr, sentiment) {
  if (!Array.isArray(eventChains)) return existingEvents;
  const eventMap = new Map(existingEvents.map((e) => [e.id, e]));

  for (const chain of eventChains) {
    if (chain.status === "resolved" && chain.id && eventMap.has(chain.id)) {
      eventMap.get(chain.id).status = "resolved";
      eventMap.get(chain.id).lastSeen = dateStr;
      continue;
    }
    const summary = chain.summary || "";
    if (!summary) continue;

    if (chain.id && eventMap.has(chain.id)) {
      // 更新已有事件
      const evt = eventMap.get(chain.id);
      evt.timeline.push({ date: dateStr, summary, sentiment });
      evt.lastSeen = dateStr;
      if (chain.keywords)
        evt.relatedKeywords = [
          ...new Set([...evt.relatedKeywords, ...chain.keywords]),
        ];
    } else {
      // 新事件
      const id = `evt-${dateStr}-${(chain.title || summary).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "").slice(0, 20)}`;
      eventMap.set(id, {
        id,
        title: chain.title || summary.slice(0, 40),
        firstSeen: dateStr,
        lastSeen: dateStr,
        status: "active",
        timeline: [{ date: dateStr, summary, sentiment }],
        relatedKeywords: chain.keywords || [],
      });
    }
  }

  // 自动归档超期事件
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - EVENT_STALE_DAYS);
  const cutoffStr = staleCutoff.toISOString().slice(0, 10);
  for (const [, evt] of eventMap) {
    if (evt.status === "active" && evt.lastSeen < cutoffStr) {
      evt.status = "stale";
    }
  }

  // 限制活跃事件数
  const all = [...eventMap.values()];
  const active = all.filter((e) => e.status === "active");
  if (active.length > MAX_ACTIVE_EVENTS) {
    active.sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    const toArchive = active.slice(0, active.length - MAX_ACTIVE_EVENTS);
    for (const e of toArchive) e.status = "stale";
  }

  return all;
}

function saveEvents(events) {
  const tmp = EVENTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2), "utf-8");
  fs.renameSync(tmp, EVENTS_FILE);
}

module.exports = {
  loadActiveEvents,
  buildEventChainSection,
  updateEvents,
  saveEvents,
};
