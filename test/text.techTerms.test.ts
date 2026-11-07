import { describe, expect, it } from "vitest";
import { findKnownTerms, findTechLikeTokens, LOWERCASE_TECH_WORDS, lookupTerm, mentionsTerm, TECH_WORDS } from "../src/text/techTerms.js";
import { SKILL_TERMS, TECH_TERMS } from "../src/text/techVocabulary.js";

const term = (name: string) => {
  const found = lookupTerm(name);
  if (!found) throw new Error(`no term ${name}`);
  return found;
};
const known = (text: string) => findKnownTerms(text).map((entry) => entry.term.term);

describe("the vocabulary", () => {
  it("lists each spelling once and every term with its plural", () => {
    const spellings = TECH_TERMS.flatMap((entry) => entry.forms.map((form) => `${form.caseSensitive}|${form.text}`));
    expect(new Set(spellings).size).toBe(spellings.length);
    expect(term("Kafka").forms.map((form) => form.text)).toEqual(["Kafka", "Kafkas", "Apache Kafka", "Apache Kafkas"]);
    expect(term("Go").forms.map((form) => form.text)).toEqual(["Go", "Golang", "Golangs"]);
  });

  it("keeps named products out of the skills", () => {
    expect(term("GitHub").category).toBe("product");
    expect(SKILL_TERMS.some((entry) => entry.term === "GitHub")).toBe(false);
    expect(SKILL_TERMS.some((entry) => entry.term === "GitHub Actions")).toBe(true);
  });
});

describe("matching", () => {
  it("matches on boundaries and respects case for everyday words", () => {
    expect(mentionsTerm("Strong JavaScript skills", term("Java"))).toBe(false);
    expect(mentionsTerm("C++ and Java", term("Java"))).toBe(true);
    expect(mentionsTerm("Modern C++ codebase", term("C++"))).toBe(true);
    expect(mentionsTerm("We react quickly", term("React"))).toBe(false);
    expect(mentionsTerm("Deploy on k8s clusters", term("Kubernetes"))).toBe(true);
    expect(mentionsTerm("Experience with LLMs", term("LLM"))).toBe(true);
    expect(mentionsTerm("Built on ASP.NET", term(".NET"))).toBe(false);
    expect(findKnownTerms("PostgreSQL and SQL and NoSQL").map((entry) => entry.term.term).sort()).toEqual(["NoSQL", "PostgreSQL", "SQL"]);
  });

  it("reads Go as a language only outside phrasal verbs", () => {
    const go = term("Go");
    expect(mentionsTerm("Services written in Go, Python and Rust", go)).toBe(true);
    expect(mentionsTerm("You will go above and beyond. Go to market fast.", go)).toBe(false);
    expect(mentionsTerm("Our go-to-market team", go)).toBe(false);
    expect(mentionsTerm("We Go deep on reliability", go)).toBe(false);
    expect(mentionsTerm("Golang services", go)).toBe(true);
  });

  it("counts an everyday word mid-sentence or as a list item, never as a sentence's verb", () => {
    expect(known("React to incidents quickly.")).not.toContain("React");
    expect(known("- React, Vue or Svelte")).toEqual(expect.arrayContaining(["React", "Vue", "Svelte"]));
    expect(known("Spark\nGo")).toEqual(expect.arrayContaining(["Spark", "Go"]));
    expect(known("Spark curiosity in others. We use Spark daily.")).toEqual(["Spark"]);
    expect(findKnownTerms("Spark curiosity in others. We use Spark daily.")[0]?.count).toBe(1);
    expect(known("1. Swift and Kotlin")).toEqual(expect.arrayContaining(["Swift", "Kotlin"]));
  });

  it("does not read places, products or prefixed words named alike as the tool", () => {
    expect(known("Our Salt Lake City office uses Ansible, Salt and Puppet")).toEqual(expect.arrayContaining(["Ansible", "Salt", "Puppet"]));
    expect(findKnownTerms("Our Salt Lake City office").map((entry) => entry.term.term)).not.toContain("Salt");
    expect(known("Databricks with Unity Catalog")).not.toContain("Unity");
    expect(known("The e-Beam division builds Apache Beam pipelines")).toEqual(["Beam"]);
    expect(findKnownTerms("The e-Beam division builds Apache Beam pipelines")[0]?.count).toBe(2);
  });

  it("treats a hyphen and a space as the same separator", () => {
    expect(mentionsTerm("an event driven design", term("event-driven"))).toBe(true);
    expect(mentionsTerm("scikit learn models", term("scikit-learn"))).toBe(true);
    expect(mentionsTerm("Kubernetes-based tooling", term("Kubernetes"))).toBe(true);
  });

  it("extracts technical terms from a posting without mistaking ordinary words", () => {
    const terms = known("We use Go, Rust and C++ on Kubernetes (k8s); experience with .NET and CI/CD. Go-to-market experience is a plus. React to incidents.");
    expect(terms).toEqual(expect.arrayContaining(["Go", "Rust", "C++", "Kubernetes", ".NET", "CI/CD"]));
    expect(terms).not.toContain("React");
    expect(known("Go-to-market strategy and growth")).not.toContain("Go");
  });

  it("orders known terms by frequency and leaves out products unless asked", () => {
    const text = "Python, Python and Kafka on GitHub";
    expect(findKnownTerms(text).map((entry) => [entry.term.term, entry.count])).toEqual([
      ["Python", 2],
      ["Kafka", 1],
    ]);
    expect(findKnownTerms(text, TECH_TERMS).map((entry) => entry.term.term)).toContain("GitHub");
  });

  it("looks a free-text skill name up by term or alias in any case", () => {
    expect(lookupTerm(" golang ")?.term).toBe("Go");
    expect(lookupTerm("Postgres")?.term).toBe("PostgreSQL");
    expect(lookupTerm("knitting")).toBeNull();
  });
});

describe("findTechLikeTokens", () => {
  it("finds technical-looking tokens the vocabulary does not know, skipping generic acronyms", () => {
    const tokens = findTechLikeTokens("Experience with ClickPipe, SIEM tuning, ZeroMQ and Foo.js; US-based; EEO; Acme tooling; GitHub", ["Acme"]);
    expect(tokens).toEqual(expect.arrayContaining(["ClickPipe", "ZeroMQ", "Foo.js"]));
    expect(tokens).not.toContain("US");
    expect(tokens).not.toContain("SIEM");
    expect(tokens).not.toContain("GitHub");
  });
});

describe("name sets for the fact check", () => {
  it("separates names a letter may write in lower case from everyday words that count only when capitalised", () => {
    for (const name of ["terraform", "kafka", "snowflake", "dbt", "pandas", "scikit-learn", "k8s", "golang", "github", "zscaler"]) {
      expect(LOWERCASE_TECH_WORDS.has(name), name).toBe(true);
    }
    for (const name of ["go", "rust", "react", "spark", "express", "spring", "notion", "apache"]) {
      expect(LOWERCASE_TECH_WORDS.has(name), name).toBe(false);
      expect(TECH_WORDS.has(name), name).toBe(true);
    }
  });

  it("leaves practices and descriptive aliases out of the names", () => {
    for (const word of ["observability", "serverless", "microservices", "containerization", "guardrails", "firmware"]) {
      expect(TECH_WORDS.has(word), word).toBe(false);
    }
  });
});
