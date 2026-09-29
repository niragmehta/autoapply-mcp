import { describe, expect, it } from "vitest";
import { ashbyEmbedFallbackUrl } from "../src/submission/ashbyEmbed.js";

const JOB = "https://jobs.ashbyhq.com/cursor/94cc6684-9dbf-43f9-8ffc-405614e64ddd";
const NOT_FOUND = "Page not found The page you requested was not found Powered by Privacy Policy";

describe("ashbyEmbedFallbackUrl", () => {
  it("points a hosted application page that is not found at the embedded form", () => {
    expect(ashbyEmbedFallbackUrl(`${JOB}/application`, NOT_FOUND)).toBe(`${JOB}/application?embed=js`);
  });

  it("sends a job description page to the embedded application form", () => {
    expect(ashbyEmbedFallbackUrl(JOB, NOT_FOUND)).toBe(`${JOB}/application?embed=js`);
  });

  it("leaves a hosted page that rendered its form alone", () => {
    expect(ashbyEmbedFallbackUrl(`${JOB}/application`, "Apply for this job Name Email Resume")).toBeNull();
  });

  it("does not retry a page that is already embedded", () => {
    expect(ashbyEmbedFallbackUrl(`${JOB}/application?embed=js`, NOT_FOUND)).toBeNull();
  });

  it("does not treat a missing board root as a job", () => {
    expect(ashbyEmbedFallbackUrl("https://jobs.ashbyhq.com/cursor", NOT_FOUND)).toBeNull();
  });

  it("ignores other hosts and unparseable URLs", () => {
    expect(ashbyEmbedFallbackUrl("https://boards.greenhouse.io/acme/jobs/1", NOT_FOUND)).toBeNull();
    expect(ashbyEmbedFallbackUrl("not a url", NOT_FOUND)).toBeNull();
  });
});
