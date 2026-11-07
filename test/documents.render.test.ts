import { afterAll, describe, expect, it } from "vitest";
import { NO_FONTS } from "../src/documents/fonts.js";
import { applyVariant } from "../src/documents/model.js";
import { renderPdf, sha256Bytes, withPdfRenderer, writePdf, type PdfRenderer } from "../src/documents/render.js";
import { resumeExpectations } from "../src/documents/resumeService.js";
import { renderResumeHtml } from "../src/documents/templates/resume.js";
import { countPdfPages, extractPdfText, hasType3Fonts, verifyPdf } from "../src/documents/verifyPdf.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromiumAvailable, exampleResume, removeScratch, scratchDir } from "./documents.fixtures.js";

/** Rendering through Playwright's Chromium; skipped where Chromium cannot start. */

const available = await chromiumAvailable();
const dir = scratchDir("render");
afterAll(() => removeScratch(dir));

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>@page { size: A4; margin: 0.5in; } body { font-family: serif; font-size: 12pt; }</style></head><body>${body}</body></html>`;

async function render(html: string): Promise<Buffer> {
  return withPdfRenderer((renderer: PdfRenderer) => renderer.render(html, "A4"));
}

describe("page structure without pdfjs", () => {
  it("counts pages and spots Type3 fonts from the raw PDF", () => {
    const raw = Buffer.from("<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >> << /Subtype /Type3 >>", "latin1");
    expect(countPdfPages(raw)).toBe(2);
    expect(hasType3Fonts(raw)).toBe(true);
    expect(hasType3Fonts(Buffer.from("<< /Subtype /TrueType >>", "latin1"))).toBe(false);
  });

  it("writes a PDF through a staged file and hashes what it wrote", () => {
    const bytes = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");
    const written = writePdf(join(dir, "nested", "doc.pdf"), bytes);
    expect(written).toEqual({ path: join(dir, "nested", "doc.pdf"), bytes: bytes.length, sha256: sha256Bytes(bytes) });
    expect(readFileSync(written.path)).toEqual(bytes);
  });
});

describe.skipIf(!available)("rendering and verifying PDFs", () => {
  it("renders every example variant on one page with all of its text intact", async () => {
    await withPdfRenderer(async (renderer) => {
      for (const variant of ["backend", "platform", "data"]) {
        const document = applyVariant(exampleResume(), variant).document;
        const bytes = await renderer.render(renderResumeHtml(document, NO_FONTS), document.theme.pageSize);
        const checks = await verifyPdf(bytes, resumeExpectations(document));
        expect(checks, variant).toMatchObject({ ok: true, textChecked: true, pages: 1, issues: [] });
      }
    });
  }, 60_000);

  it("keeps the text layer in reading order with bullets, bold figures and kept-whole terms", async () => {
    const document = applyVariant(exampleResume(), "backend").document;
    const text = await extractPdfText(await render(renderResumeHtml(document, NO_FONTS)));
    const lines = text?.lines ?? [];
    const joined = lines.join("\n");
    expect(joined.indexOf("Alex Candidate")).toBeLessThan(joined.indexOf("Experience"));
    expect(lines.some((line) => line.includes("\u2022 Scaled a payments API from 2k to 40k"))).toBe(true);
    expect(lines.some((line) => line.includes("CI/CD"))).toBe(true);
    expect(joined).not.toMatch(/[\ufb00-\ufb06\u00ad]/);
  }, 60_000);

  it("honours a Letter page size", async () => {
    const letter = await render(page("<p>Letter</p>").replace("size: A4", "size: Letter"));
    const raw = letter.toString("latin1");
    expect(raw).toMatch(/\/MediaBox \[0 0 612 792\]/);
  }, 60_000);

  it("writes a rendered file with its hash", async () => {
    const result = await renderPdf(page("<p>Hello</p>"), join(dir, "hello.pdf"), { pageSize: "A4" });
    const bytes = readFileSync(result.path);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(result.sha256).toBe(sha256Bytes(bytes));
    expect(result.bytes).toBe(bytes.length);
  }, 60_000);

  it("reports ligature glyphs, hyphenation, split terms, missing text and overflow", async () => {
    const ligature = await verifyPdf(await render(page("<p>An e\uFB03cient o\uFB00ice</p>")), { maxPages: 1, texts: [], terms: [] });
    expect(ligature.issues.map((issue) => issue.code)).toEqual(["ligature"]);

    const hyphenated = await verifyPdf(
      await render(page('<div lang="en" style="width: 90px; hyphens: auto">extraordinarily incomprehensibilities</div>')),
      { maxPages: 1, texts: ["extraordinarily incomprehensibilities"], terms: [] },
    );
    expect(hyphenated.issues.map((issue) => issue.code)).toContain("hyphenation");

    const split = await verifyPdf(await render(page('<div style="width: 30px">aaaa end-to-end bbbb</div>')), {
      maxPages: 1,
      texts: ["aaaa end-to-end bbbb"],
      terms: ["end-to-end"],
    });
    expect(split.issues).toEqual([{ code: "split-term", detail: '"end-to-end" is split across a line break' }]);

    const missing = await verifyPdf(await render(page("<p>Present text</p>")), { maxPages: 1, texts: ["Present text", "Absent bullet"], terms: [] });
    expect(missing.issues).toEqual([{ code: "missing-text", detail: 'text missing from the PDF: "Absent bullet"' }]);

    const long = await render(page(Array.from({ length: 120 }, (_, index) => `<p>Paragraph ${index}</p>`).join("")));
    const overflow = await verifyPdf(long, { maxPages: 1, texts: [], terms: [] });
    expect(overflow.ok).toBe(false);
    expect(overflow.pages).toBe(countPdfPages(long));
    expect(overflow.issues[0]?.code).toBe("page-count");
    expect((await verifyPdf(long, { maxPages: overflow.pages, texts: [], terms: [] })).ok).toBe(true);
  }, 60_000);

  it("flags a soft hyphen written into the source", async () => {
    const checks = await verifyPdf(await render(page("<p>soft\u00adware</p>")), { maxPages: 1, texts: ["soft\u00adware"], terms: [] });
    expect(checks.issues.map((issue) => issue.code)).toEqual(["soft-hyphen"]);
  }, 60_000);
});
