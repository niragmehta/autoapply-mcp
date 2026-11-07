import { afterEach, describe, expect, it, vi } from "vitest";

/** Playwright and pdfjs-dist are optional at runtime; their absence must fail clearly or degrade. */

afterEach(() => {
  vi.doUnmock("playwright");
  vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  vi.resetModules();
});

describe("optional dependencies", () => {
  it("says how to install Playwright when it is missing", async () => {
    vi.doMock("playwright", () => {
      throw new Error("Cannot find package 'playwright'");
    });
    const { openPdfRenderer } = await import("../src/documents/render.js");
    await expect(openPdfRenderer()).rejects.toMatchObject({ code: "playwright_missing", message: expect.stringContaining("npm install playwright") });
  });

  it("refuses a Playwright build without its chromium driver", async () => {
    vi.doMock("playwright", () => ({ chromium: undefined }));
    const { openPdfRenderer } = await import("../src/documents/render.js");
    await expect(openPdfRenderer()).rejects.toMatchObject({ code: "playwright_missing" });
  });

  it("says how to install Chromium when it cannot start", async () => {
    vi.doMock("playwright", () => ({
      chromium: {
        launch: async () => {
          throw new Error("browserType.launch: Executable doesn't exist\n<long installation banner>");
        },
      },
    }));
    const { renderPdf } = await import("../src/documents/render.js");
    await expect(renderPdf("<p>x</p>", "never-written.pdf", { pageSize: "A4" })).rejects.toMatchObject({
      code: "pdf_renderer_unavailable",
      message: expect.stringContaining("npx playwright install chromium"),
    });
  });

  it("checks only the page count when pdfjs-dist is missing", async () => {
    vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: undefined }));
    const { verifyPdf } = await import("../src/documents/verifyPdf.js");
    const bytes = Buffer.from("%PDF-1.4 << /Type /Pages >> << /Type /Page >> << /Type /Page >>", "latin1");
    const result = await verifyPdf(bytes, { maxPages: 1, texts: ["anything"], terms: [] });
    expect(result).toMatchObject({ ok: false, textChecked: false, pages: 2, issues: [{ code: "page-count" }] });
    expect(result.warnings).toContain("pdfjs-dist is not installed, so only the page count was checked");
    expect((await verifyPdf(bytes, { maxPages: 2, texts: [], terms: [] })).ok).toBe(true);
  });

  it("reports a file pdfjs cannot read", async () => {
    const { verifyPdf } = await import("../src/documents/verifyPdf.js");
    const result = await verifyPdf(Buffer.from("not a pdf at all", "latin1"), { maxPages: 1, texts: [], terms: [] });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("unreadable");
  });
});
