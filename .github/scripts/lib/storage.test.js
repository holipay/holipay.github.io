const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { atomicWrite, loadJson, saveJson, loadJsonCache, saveJsonCache } = require("./storage.js");

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("atomicWrite", () => {
  it("writes data to file", () => {
    const filePath = path.join(tmpDir, "test.json");
    atomicWrite(filePath, '{"key":"value"}');
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(content.key, "value");
  });

  it("creates parent directories", () => {
    const filePath = path.join(tmpDir, "sub", "dir", "test.json");
    atomicWrite(filePath, '{"ok":true}');
    assert.ok(fs.existsSync(filePath));
  });

  it("overwrites existing file atomically", () => {
    const filePath = path.join(tmpDir, "test.json");
    atomicWrite(filePath, '{"v":1}');
    atomicWrite(filePath, '{"v":2}');
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(content.v, 2);
  });
});

describe("loadJson", () => {
  it("loads existing JSON file", () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, '{"a":1}');
    const result = loadJson(filePath);
    assert.deepEqual(result, { a: 1 });
  });

  it("returns null for non-existent file", () => {
    const result = loadJson(path.join(tmpDir, "nope.json"));
    assert.equal(result, null);
  });

  it("returns null for invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json");
    const result = loadJson(filePath);
    assert.equal(result, null);
  });
});

describe("saveJson", () => {
  it("writes JSON data", () => {
    const filePath = path.join(tmpDir, "out.json");
    saveJson(filePath, { x: 42 });
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(content.x, 42);
  });

  it("supports compact mode (default)", () => {
    const filePath = path.join(tmpDir, "compact.json");
    saveJson(filePath, { a: 1 });
    const raw = fs.readFileSync(filePath, "utf-8");
    assert.ok(!raw.includes("\n"));
  });

  it("supports pretty mode", () => {
    const filePath = path.join(tmpDir, "pretty.json");
    saveJson(filePath, { a: 1 }, { compact: false });
    const raw = fs.readFileSync(filePath, "utf-8");
    assert.ok(raw.includes("\n"));
  });
});

describe("loadJsonCache", () => {
  it("loads cache data and logs count", () => {
    const filePath = path.join(tmpDir, "cache.json");
    fs.writeFileSync(filePath, '{"k1":{"v":1},"k2":{"v":2}}');
    const result = loadJsonCache(filePath, "测试");
    assert.equal(Object.keys(result).length, 2);
  });

  it("returns empty object for missing file", () => {
    const result = loadJsonCache(path.join(tmpDir, "nope.json"));
    assert.deepEqual(result, {});
  });
});

describe("saveJsonCache", () => {
  it("evicts entries exceeding maxSize", () => {
    const cache = {};
    for (let i = 0; i < 5; i++) {
      cache[`key${i}`] = { ts: Date.now() - i * 1000 };
    }
    const filePath = path.join(tmpDir, "cache.json");
    saveJsonCache(filePath, cache, { maxSize: 3, retentionDays: 30 });
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.equal(Object.keys(saved).length, 3);
  });

  it("retains only non-expired entries", () => {
    const cache = {
      fresh: { ts: Date.now() },
      old: { ts: Date.now() - 100 * 24 * 60 * 60 * 1000 },
    };
    const filePath = path.join(tmpDir, "cache.json");
    saveJsonCache(filePath, cache, { retentionDays: 30 });
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assert.ok(saved.fresh);
    assert.ok(!saved.old);
  });

  it("skips save when dirtyCheck returns false", () => {
    const filePath = path.join(tmpDir, "cache.json");
    const cache = { k: { ts: Date.now() } };
    saveJsonCache(filePath, cache, { dirtyCheck: () => false });
    assert.ok(!fs.existsSync(filePath));
  });
});
