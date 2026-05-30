const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { cacheKey, getTranslation, setTranslation } = require("./translation.js");

describe("cacheKey", () => {
  it("returns lowercase for short text", () => {
    assert.equal(cacheKey("Hello World"), "hello world");
  });

  it("trims whitespace", () => {
    assert.equal(cacheKey("  hello  "), "hello");
  });

  it("truncates long text: first 80 + last 20", () => {
    const longText = "a".repeat(100);
    const key = cacheKey(longText);
    assert.equal(key.length, 100);
    assert.ok(key.startsWith("a".repeat(80)));
    assert.ok(key.endsWith("a".repeat(20)));
  });

  it("handles 80-char text without truncation", () => {
    const text = "a".repeat(80);
    const key = cacheKey(text);
    assert.equal(key, text.toLowerCase());
  });

  it("for 81-char text, key is first 80 + last 20 = 100 chars", () => {
    const text = "a".repeat(81);
    const key = cacheKey(text);
    assert.equal(key.length, 100);
  });
});

describe("getTranslation / setTranslation", () => {
  it("returns null for uncached text", () => {
    const result = getTranslation("uncached text " + Date.now());
    assert.equal(result, null);
  });

  it("stores and retrieves translation", () => {
    const text = "test " + Date.now();
    setTranslation(text, "测试翻译");
    const result = getTranslation(text);
    assert.equal(result, "测试翻译");
  });
});
