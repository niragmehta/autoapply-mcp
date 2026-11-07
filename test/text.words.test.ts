import { describe, expect, it } from "vitest";
import {
  containsPhrase,
  contentTerms,
  escapeRegExp,
  foldAcronymPlurals,
  normalizeTerm,
  normalizeWord,
  shortQuote,
  significantWords,
  singular,
  stem,
  tokens,
  wordCount,
  words,
} from "../src/text/words.js";

describe("singular", () => {
  it("folds regular plurals, -ies and sibilant -es", () => {
    expect(singular("systems")).toBe("system");
    expect(singular("policies")).toBe("policy");
    expect(singular("processes")).toBe("process");
    expect(singular("matches")).toBe("match");
    expect(singular("boxes")).toBe("box");
    expect(singular("pushes")).toBe("push");
    expect(singular("buzzes")).toBe("buzz");
  });

  it("keeps words that only look plural and the -e of -che and -ze words", () => {
    expect(singular("status")).toBe("status");
    expect(singular("analysis")).toBe("analysis");
    expect(singular("access")).toBe("access");
    expect(singular("series")).toBe("series");
    expect(singular("caches")).toBe("cache");
    expect(singular("sizes")).toBe("size");
    expect(singular("optimizes")).toBe("optimize");
    expect(singular("ties")).toBe("tie");
  });

  it("leaves short words and technical tokens alone", () => {
    expect(singular("aws")).toBe("aws");
    expect(singular("k8s")).toBe("k8s");
    expect(singular("node.js")).toBe("node.js");
  });
});

describe("stem", () => {
  it("strips plurals and -ing/-ed so inflections meet", () => {
    expect(stem("guardrails")).toBe("guardrail");
    expect(stem("building")).toBe("build");
    expect(stem("buildings")).toBe("build");
    expect(stem("processes")).toBe("process");
    expect(stem("migrated")).toBe("migrat");
    expect(stem("migrating")).toBe("migrat");
  });

  it("keeps short words and tokens with symbols", () => {
    expect(stem("used")).toBe("used");
    expect(stem("sing")).toBe("sing");
    expect(stem("c++")).toBe("c++");
  });
});

describe("tokens and words", () => {
  it("keeps technical tokens whole and trims edge punctuation and possessives", () => {
    expect(tokens("Shipped C#, .NET and Node.js; owned CI/CD. Alex's team-led \"work\"")).toEqual([
      "shipped",
      "c#",
      ".net",
      "and",
      "node.js",
      "owned",
      "ci/cd",
      "alex",
      "team-led",
      "work",
    ]);
  });

  it("normalises words and phrases the same way everywhere", () => {
    expect(normalizeWord("Systems")).toBe("system");
    expect(normalizeWord("Alex's")).toBe("alex");
    expect(normalizeWord("AWS")).toBe("aws");
    expect(normalizeWord("-policies.")).toBe("policy");
    expect(words("Built APIs and KPIs for Systems")).toEqual(["built", "api", "and", "kpi", "for", "system"]);
    expect(normalizeTerm("Distributed Systems")).toBe(normalizeTerm("distributed system"));
    expect(foldAcronymPlurals("APIs, SDKs and AWS")).toBe("API, SDK and AWS");
  });
});

describe("contentTerms", () => {
  it("drops stop words and filler, stems the rest and keeps short technical terms", () => {
    expect(contentTerms("Experience with the guardrails and AI policies")).toEqual(["guardrail", "ai", "policy"]);
    expect(contentTerms("Strong skills building teams' tools; 5+ years")).toEqual(["tool"]);
  });

  it("returns each term once, in first-seen order", () => {
    expect(contentTerms("Kafka pipelines, Kafka pipeline")).toEqual(["kafka", "pipeline"]);
  });
});

describe("significantWords", () => {
  it("returns long content words, compounds split, without stems", () => {
    expect(significantWords("Kafka-backed pipelines using CI/CD and Node.js, strong experience in 2024")).toEqual([
      "kafka",
      "backed",
      "pipelines",
      "node",
    ]);
  });
});

describe("wordCount", () => {
  it("counts words, not dashes or bullets", () => {
    expect(wordCount("Ship it \u2014 then 2 more \u2022 done ")).toBe(6);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("containsPhrase", () => {  it("matches on word boundaries, in any case", () => {
    expect(containsPhrase("Services in Go and C++", "go")).toBe(true);
    expect(containsPhrase("Going places", "go")).toBe(false);
    expect(containsPhrase("Modern C++ codebase", "C++")).toBe(true);
    expect(containsPhrase("anything", "   ")).toBe(false);
  });

  it("escapes regular expression characters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });
});

describe("shortQuote", () => {
  it("returns short text flattened and cuts long text at a word boundary", () => {
    expect(shortQuote("  one\n two  ")).toBe("one two");
    const quote = shortQuote(`Operate ${"very ".repeat(60)}large clusters`, 40);
    expect(quote.length).toBeLessThanOrEqual(40);
    expect(quote.endsWith("\u2026")).toBe(true);
    expect(quote).not.toMatch(/\s\u2026$/);
  });

  it("cuts inside a word when the text has no early space", () => {
    expect(shortQuote("x".repeat(50), 10)).toBe(`${"x".repeat(9)}\u2026`);
  });
});
