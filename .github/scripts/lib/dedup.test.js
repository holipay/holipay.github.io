const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTitle, dedup, buildLengthBuckets, getCandidates, SIMILARITY_THRESHOLD } = require("./dedup.js");
const { similarity, SHORT_TITLE_LENGTH } = require("../shared.js");

describe("normalizeTitle", () => {
  it("strips leading emojis", () => {
    const result = normalizeTitle("💰 Breaking News: Market Up");
    assert.ok(result.startsWith("breaking"), `Got: ${result}`);
  });

  it("strips leading dashes and whitespace", () => {
    assert.equal(normalizeTitle("  - Hello World"), "hello world");
  });

  it("strips source names at end", () => {
    const result = normalizeTitle("Market Rally Continues - Reuters");
    assert.ok(!result.includes("reuters"), `Got: ${result}`);
    assert.ok(result.includes("market"), `Got: ${result}`);
  });

  it("strips multiple source names", () => {
    assert.ok(!normalizeTitle("Title - Bloomberg").includes("bloomberg"));
    assert.ok(!normalizeTitle("Title - CNBC").includes("cnbc"));
    assert.ok(!normalizeTitle("Title - Financial Times").includes("financial times"));
  });

  it("collapses whitespace", () => {
    assert.equal(normalizeTitle("Hello   World"), "hello world");
  });

  it("lowercases", () => {
    assert.equal(normalizeTitle("HELLO WORLD"), "hello world");
  });

  it("handles null/undefined/empty", () => {
    assert.equal(normalizeTitle(null), "");
    assert.equal(normalizeTitle(undefined), "");
    assert.equal(normalizeTitle(""), "");
  });

  it("preserves Chinese text", () => {
    const result = normalizeTitle("中国经济增长加速");
    assert.equal(result, "中国经济增长加速");
  });
});

describe("buildLengthBuckets", () => {
  it("groups titles by length", () => {
    const buckets = buildLengthBuckets(["abc", "de", "fgh", "ij"]);
    assert.equal(buckets.get(2).length, 2);
    assert.equal(buckets.get(3).length, 2);
  });

  it("handles empty array", () => {
    const buckets = buildLengthBuckets([]);
    assert.equal(buckets.size, 0);
  });
});

describe("getCandidates", () => {
  it("returns candidates within length range", () => {
    const buckets = new Map();
    buckets.set(5, ["hello"]);
    buckets.set(6, ["world!"]);
    buckets.set(10, ["longtext!!"]);

    const candidates = getCandidates(buckets, 5, 0.75);
    const candidateTexts = candidates;
    assert.ok(candidateTexts.includes("hello"));
    assert.ok(candidateTexts.includes("world!"));
    assert.ok(!candidateTexts.includes("longtext!!"));
  });
});

describe("dedup", () => {
  it("removes duplicate URLs", () => {
    const items = [
      { title: "A", link: "http://a.com" },
      { title: "B", link: "http://a.com" },
      { title: "C", link: "http://c.com" },
    ];
    const result = dedup(items);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, "A");
    assert.equal(result[1].title, "C");
  });

  it("removes exact title matches", () => {
    const items = [
      { title: "Market Rally", link: "http://a.com" },
      { title: "Market Rally", link: "http://b.com" },
    ];
    const result = dedup(items);
    assert.equal(result.length, 1);
  });

  it("removes fuzzy title matches above threshold", () => {
    const items = [
      { title: "The Global Economy Is Growing Strongly", link: "http://a.com" },
      { title: "The Global Economy Is Growing Strong", link: "http://b.com" },
    ];
    const result = dedup(items);
    assert.equal(result.length, 1);
  });

  it("keeps distinct titles", () => {
    const items = [
      { title: "Market Rally Continues", link: "http://a.com" },
      { title: "Tech Stocks Decline Sharply", link: "http://b.com" },
    ];
    const result = dedup(items);
    assert.equal(result.length, 2);
  });

  it("deduplicates against existing titles", () => {
    const items = [
      { title: "Market Rally Continues", link: "http://a.com" },
    ];
    const existing = ["market rally continues"];
    const result = dedup(items, existing);
    assert.equal(result.length, 0);
  });

  it("handles empty input", () => {
    assert.deepEqual(dedup([]), []);
  });

  it("handles items without links", () => {
    const items = [
      { title: "Hello World" },
      { title: "Hello World" },
    ];
    const result = dedup(items);
    assert.equal(result.length, 1);
  });

  it("uses titleEN when available", () => {
    const items = [
      { title: "你好世界", titleEN: "Hello World", link: "http://a.com" },
      { title: "世界你好", titleEN: "Hello World", link: "http://b.com" },
    ];
    const result = dedup(items);
    assert.equal(result.length, 1);
  });
});
