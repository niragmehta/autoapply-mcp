import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { applyVariant, orderByIds, placedBullets } from "../src/documents/model.js";
import { loadResumeSource, loadResumeSourceIfPresent, parseResumeSource, stripMetricMarkers } from "../src/documents/resumeSource.js";
import { DocumentsPolicySchema } from "../src/domain/policies/documents.js";
import { AppError } from "../src/util/errors.js";
import { exampleResume, exampleResumeJson, removeScratch, scratchDir } from "./documents.fixtures.js";

const dir = scratchDir("source");
afterAll(() => removeScratch(dir));

const minimal = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  header: { name: "Alex Candidate" },
  experience: [
    {
      organization: "Northwind Logistics",
      roles: [
        {
          title: "Software Engineer",
          dates: "2020 \u2013 Present",
          groups: [{ id: "main", bullets: [{ id: "one", text: "Built [[3]] services." }, { id: "two", text: "Ran on-call." }] }],
        },
      ],
    },
  ],
  ...overrides,
});

function failure(value: unknown): string {
  try {
    parseResumeSource(value);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("resume_source_invalid");
    return (error as AppError).message;
  }
  throw new Error("expected the source to be rejected");
}

describe("resume source schema", () => {
  it("accepts the shipped example", () => {
    const source = exampleResume();
    expect(source.header.name).toBe("Alex Candidate");
    expect(placedBullets(source)).toHaveLength(11);
    expect(Object.keys(source.variants)).toEqual(["backend", "platform", "data"]);
  });

  it("fills theme, section titles and page budget with the original design's defaults", () => {
    const source = parseResumeSource(minimal());
    expect(source.theme).toEqual({ accent: "#FF6A3D", linkColor: "#3A95D7", pageSize: "A4", align: "left" });
    expect(source.sectionTitles).toEqual({
      experience: "Experience",
      additional: "Previous Roles",
      education: "Education",
      skills: "Technical Skills",
    });
    expect(source.maxPages).toBe(1);
    expect(source.variants).toEqual({});
  });

  it("names duplicate ids and variant references to content that does not exist", () => {
    const message = failure(
      minimal({
        experience: [
          {
            organization: "Northwind Logistics",
            roles: [{ title: "Engineer", dates: "2020", groups: [{ id: "g", bullets: [{ id: "same", text: "A." }, { id: "same", text: "B." }] }] }],
          },
        ],
        variants: { backend: { groupOrder: ["nope"], excludeBullets: ["ghost"], skillOrder: ["missing"] } },
      }),
    );
    expect(message).toContain('duplicate bullet id "same"');
    expect(message).toContain('variants.backend.groupOrder.0: unknown group id "nope"');
    expect(message).toContain('unknown bullet id "ghost"');
    expect(message).toContain('unknown skill category id "missing"');
  });

  it("rejects an unclosed metric marker", () => {
    const source = minimal();
    const broken = JSON.parse(JSON.stringify(source).replace("Built [[3]] services.", "Built [[3 services."));
    expect(failure(broken)).toContain("every [[ must close");
  });

  it("only lets theme values through that cannot escape their CSS declaration", () => {
    expect(failure(minimal({ theme: { accent: "red; } body { display: none" } }))).toContain("hex colour");
    expect(failure(minimal({ theme: { margins: { top: "1in;", right: "1in", bottom: "1in", left: "1in" } } }))).toContain("length");
  });

  it("refuses script links in the contact line", () => {
    expect(failure(minimal({ header: { name: "Alex Candidate", contact: [{ text: "x", href: "javascript:alert(1)" }] } }))).toContain("links must start");
  });

  it("strips metric markers to the text a reader sees", () => {
    expect(stripMetricMarkers("Cut cost by [[40%]] across [[120+]] services")).toBe("Cut cost by 40% across 120+ services");
  });
});

describe("loading resume.json", () => {
  it("reports a missing file with where it was expected", () => {
    const path = join(dir, "absent.json");
    expect(() => loadResumeSource({ resumeSource: path })).toThrow(/no resume source at/);
    expect(loadResumeSourceIfPresent({ resumeSource: path })).toBeNull();
  });

  it("reads a file with a byte order mark", () => {
    const path = join(dir, "bom.json");
    writeFileSync(path, `\uFEFF${JSON.stringify(exampleResumeJson())}`);
    expect(loadResumeSource({ resumeSource: path }).header.name).toBe("Alex Candidate");
  });

  it("reports invalid JSON and invalid content as resume_source_invalid", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    expect(() => loadResumeSource({ resumeSource: path })).toThrow(/not valid JSON/);
    writeFileSync(path, JSON.stringify({ version: 1 }));
    expect(() => loadResumeSourceIfPresent({ resumeSource: path })).toThrow(/failed validation/);
  });
});

describe("variants", () => {
  it("applies the variant's headline, group order, skill order and exclusions", () => {
    const { document, variantFound } = applyVariant(exampleResume(), "data");
    expect(variantFound).toBe(true);
    expect(document.header.headline).toBe("Software Engineer");
    expect(document.experience[0]?.roles[0]?.groups.map((group) => group.id)).toEqual(["data", "reliability", "platform"]);
    expect(document.skills.map((category) => category.id)).toEqual(["data", "languages", "infrastructure", "practices", "tools"]);
    expect(placedBullets(document).map((spot) => spot.bullet.id)).not.toContain("service-template");

    const backend = applyVariant(exampleResume(), "backend").document;
    expect(backend.header.headline).toBe("Backend Software Engineer");
  });

  it("renders the source as written for an unknown id, even one Object.prototype defines", () => {
    for (const id of ["unknown", "constructor", "__proto__"]) {
      const { document, variantFound } = applyVariant(exampleResume(), id);
      expect(variantFound).toBe(false);
      expect(document.experience[0]?.roles[0]?.groups.map((group) => group.id)).toEqual(["reliability", "platform", "data"]);
    }
  });

  it("keeps only listed bullets when a variant names them, dropping groups left empty", () => {
    const source = parseResumeSource({ ...(exampleResumeJson() as object), variants: { short: { includeBullets: ["k8s-migration", "load-testing"] } } });
    const { document } = applyVariant(source, "short");
    expect(placedBullets(document).map((spot) => spot.bullet.id)).toEqual(["k8s-migration", "load-testing"]);
    expect(document.experience[0]?.roles[0]?.groups.map((group) => group.id)).toEqual(["platform"]);
  });

  it("orders by a preferred id list and keeps everything else in its original order", () => {
    expect(orderByIds(["a", "b", "c", "d"], ["c", "a"], (value) => value)).toEqual(["c", "a", "b", "d"]);
    expect(orderByIds(["a", "b"], undefined, (value) => value)).toEqual(["a", "b"]);
  });
});

describe("documents policy", () => {
  it("is off by default and keeps two bullets per role when fitting", () => {
    expect(DocumentsPolicySchema.parse(undefined)).toEqual({ tailorResume: false, coverLetterPdf: false, minBulletsPerRole: 2 });
  });
});
