import { afterEach, describe, expect, it, vi } from "vitest";
import { listSourceCatalog } from "../src/sources/catalog.js";

afterEach(() => vi.unstubAllEnvs());

describe("permanent source catalog", () => {
  it("includes the shortlisted ATS, aggregator, community and portfolio sources", () => {
    const catalog = listSourceCatalog();
    expect(catalog.map((source) => source.id).sort()).toEqual([
      "a16z", "ashby", "builtinsf", "foorilla", "greenhouse", "hackernews", "himalayas",
      "lever", "recruitee", "sequoia", "smartrecruiters", "workable", "workday", "yc",
    ]);
    for (const source of catalog) {
      expect(source.label.length).toBeGreaterThan(0);
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.docs).toMatch(/^https:\/\//);
      expect(source.integration).toBeTruthy();
      expect(source.access).toBeTruthy();
      expect(source.limitations.length).toBeGreaterThan(0);
    }
  });

  it.each(["smartrecruiters", "recruitee", "workable"])("describes %s as discovery-only", (id) => {
    const source = listSourceCatalog().find((entry) => entry.id === id)!;
    expect(source.kind).toBe("ats");
    expect(source.integration).toBe("discovery-only");
    expect(source.submission).toBe("manual-only");
    expect(source.limitations.join(" ")).toMatch(/browser support/i);
    expect(source.limitations.join(" ")).toMatch(/domains.*company permission/i);
  });

  it.each(["a16z", "sequoia", "yc", "builtinsf"])("does not advertise %s as an anonymous API", (id) => {
    const source = listSourceCatalog().find((entry) => entry.id === id)!;
    expect(source.kind).toBe("lead-page");
    expect(source.integration).toBe("page-scan");
    expect(source.readiness).toBe("ready");
    expect(source.submission).toBe("not-supported");
    expect(source.limitations.join(" ")).toMatch(/not.*anonymous.*bulk.*API/i);
  });

  it("reflects only runtime Foorilla key presence without disclosing or verifying the key", () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", undefined);
    expect(listSourceCatalog().find((source) => source.id === "foorilla")?.readiness).toBe("credentials-required");
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    const source = listSourceCatalog().find((entry) => entry.id === "foorilla")!;
    expect(source.readiness).toBe("credentials-configured");
    expect(source.access).toBe("api-key-pro-plus");
    expect(source.limitations.join(" ")).toMatch(/not.*verified/i);
    expect(JSON.stringify(source)).not.toContain("test-only-credential");
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "  ");
    expect(listSourceCatalog().find((entry) => entry.id === "foorilla")?.readiness).toBe("credentials-required");
  });

  it("keeps aggregation separate from verified employer jobs and preserves reuse obligations", () => {
    for (const id of ["himalayas", "foorilla"]) {
      const source = listSourceCatalog().find((entry) => entry.id === id)!;
      expect(source.kind).toBe("aggregator");
      expect(source.integration).toBe("lead-search");
      expect(source.submission).toBe("not-supported");
      expect(source.limitations.join(" ")).toMatch(/verify.*employer/i);
    }
    expect(listSourceCatalog().find((entry) => entry.id === "himalayas")?.limitations.join(" "))
      .toMatch(/third-party job/i);
    expect(listSourceCatalog().find((entry) => entry.id === "foorilla")?.limitations.join(" "))
      .toMatch(/CC BY-SA 4.0/);
  });

  it("returns independent catalog snapshots", () => {
    const first = listSourceCatalog();
    const second = listSourceCatalog();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.limitations).not.toBe(second[0]?.limitations);
  });
});
