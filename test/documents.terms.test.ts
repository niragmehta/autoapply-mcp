import { describe, expect, it } from "vitest";
import { aliasMap, extractJobTerms, scoreTerms, SECTION_WEIGHT, termSet, textTerms } from "../src/documents/terms.js";
import { normalizeTerm } from "../src/text/words.js";
import { docJob, docProfile } from "./documents.fixtures.js";

describe("term extraction", () => {
  it("weighs the title and requirements above everything and ignores the boilerplate", () => {
    const terms = extractJobTerms(docJob(), aliasMap(docProfile()));
    const weight = (term: string) => terms.get(normalizeTerm(term))?.weight ?? 0;
    expect(weight("platform engineer")).toBeGreaterThan(weight("terraform"));
    expect(weight("kubernetes")).toBeGreaterThan(weight("terraform"));
    expect(weight("terraform")).toBeGreaterThan(weight("rust"));
    expect(weight("rust")).toBeGreaterThan(0);
    // Benefits text never counts, and neither do generic words.
    for (const absent of ["swag", "parental leave", "experience", "senior", "years", "deep experience", "operating kafka"]) {
      expect(terms.has(normalizeTerm(absent))).toBe(false);
    }
    expect(terms.get(normalizeTerm("rust"))?.sections).toEqual(["preferred"]);
  });

  it("gives every boilerplate section no weight", () => {
    expect([SECTION_WEIGHT.about, SECTION_WEIGHT.benefits, SECTION_WEIGHT.compensation, SECTION_WEIGHT.legal]).toEqual([0, 0, 0, 0]);
    const terms = extractJobTerms(docJob({ descriptionText: "Compensation\n- Equity in Kafka Corp\nRequirements\n- Terraform" }));
    expect(terms.has("kafka")).toBe(false);
    expect(terms.get("terraform")?.sections).toEqual(["requirements"]);
  });

  it("is deterministic and sorted by weight", () => {
    const first = [...extractJobTerms(docJob()).values()];
    const second = [...extractJobTerms(docJob()).values()];
    expect(second).toEqual(first);
    expect(first.map((term) => term.weight)).toEqual([...first.map((term) => term.weight)].sort((a, b) => b - a));
  });

  it("folds a skill's aliases onto its name", () => {
    const aliases = aliasMap(docProfile());
    expect(aliases.get("k8s")).toBe(normalizeTerm("Kubernetes"));
    const terms = extractJobTerms(docJob({ title: "Platform Engineer", descriptionText: "Requirements\n- Run k8s and Postgres" }), aliases);
    expect(terms.has(normalizeTerm("Kubernetes"))).toBe(true);
    expect(terms.has(normalizeTerm("PostgreSQL"))).toBe(true);
  });

  it("keeps technical tokens whole and phrases inside punctuation", () => {
    const found = textTerms("Shipped C#, .NET and Node.js services; owned the CI/CD pipeline.").map((entry) => entry.term);
    expect(found).toEqual(expect.arrayContaining(["c#", ".net", "node.js", "ci/cd", "ci/cd pipeline"]));
    expect(found).not.toContain("net node.js");
  });

  it("folds -es plurals onto their singular", () => {
    expect(termSet(["Automated review processes and branches"])).toEqual(termSet(["Automated review process and branch"]));
  });
});

describe("term scoring", () => {
  it("counts a phrase once instead of again for each of its words", () => {
    const jobTerms = extractJobTerms(docJob());
    const match = scoreTerms(termSet(["Owned incident response for the payments API"]), jobTerms);
    expect(match.terms).toContain("incident response");
    expect(match.terms).not.toContain("incident");
    expect(match.terms).not.toContain("response");
    expect(match.score).toBe(jobTerms.get("incident response")?.weight);
    expect(scoreTerms(termSet(["Baked bread"]), jobTerms)).toEqual({ score: 0, terms: [] });
  });
});
