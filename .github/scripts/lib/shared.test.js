const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isEnglish, similarity, charBigrams, SHORT_TITLE_LENGTH } = require("../shared.js");

describe("isEnglish", () => {
  it("returns true for pure English text", () => {
    assert.equal(isEnglish("Market rally continues"), true);
  });

  it("returns false for pure Chinese text", () => {
    assert.equal(isEnglish("中国经济增长"), false);
  });

  it("returns true for English-dominant mixed text", () => {
    assert.equal(isEnglish("GDP growth in China accelerated"), true);
  });

  it("returns true for mixed text with ASCII letters (intended behavior)", () => {
    assert.equal(isEnglish("中国的经济增长加速了ABC"), true);
  });

  it("handles numbers-only text", () => {
    assert.equal(isEnglish("12345"), false);
  });

  it("handles empty string", () => {
    assert.equal(isEnglish(""), false);
  });
});

describe("charBigrams", () => {
  it("extracts bigrams from string", () => {
    const bg = charBigrams("abc");
    assert.ok(bg.has("ab"));
    assert.ok(bg.has("bc"));
    assert.equal(bg.size, 2);
  });

  it("returns empty set for single char", () => {
    const bg = charBigrams("a");
    assert.equal(bg.size, 0);
  });

  it("returns empty set for empty string", () => {
    const bg = charBigrams("");
    assert.equal(bg.size, 0);
  });
});

describe("similarity", () => {
  it("returns 1 for identical strings", () => {
    assert.equal(similarity("hello", "hello"), 1);
  });

  it("returns 0 for completely different strings", () => {
    const s = similarity("abc", "xyz");
    assert.ok(s < 0.1, `Got: ${s}`);
  });

  it("returns high value for similar strings", () => {
    const s = similarity("hello world", "hello worlds");
    assert.ok(s > 0.8, `Got: ${s}`);
  });

  it("returns 0 for null/undefined inputs", () => {
    assert.equal(similarity(null, "a"), 0);
    assert.equal(similarity("a", null), 0);
    assert.equal(similarity(undefined, "a"), 0);
  });

  it("handles short title strict mode", () => {
    const s = similarity("ab", "abc", true);
    assert.ok(s > 0, `Got: ${s}`);
  });

  it("short title containment gives high score", () => {
    const s = similarity("abc", "abcd", true);
    assert.ok(s >= 0.7, `Got: ${s}`);
  });
});
