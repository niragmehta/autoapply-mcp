import { describe, expect, it } from "vitest";
// @ts-expect-error The dashboard's browser modules are plain JavaScript with no type declarations.
import { safeHref } from "../web/lib/urls.js";

describe("dashboard external links", () => {
  it.each([
    ["https://jobs.example.com/acme/123", "https://jobs.example.com/acme/123"],
    ["http://example.com/x", "http://example.com/x"],
  ])("keeps the web link %s", (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "/api/applications", "vbscript:x", "not a url", ""])(
    "refuses to turn %s into a link",
    (input) => {
      expect(safeHref(input)).toBeNull();
    },
  );
});
