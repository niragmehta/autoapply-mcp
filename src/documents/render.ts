import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, toErrorMessage } from "../util/errors.js";

/**
 * HTML to PDF through Playwright's Chromium, the same engine the original
 * resume script printed with. Playwright is an optional peer dependency, so it
 * is imported only when a document is rendered.
 */

type PageSize = "A4" | "Letter";

type PdfPage = {
  setContent: (html: string, options?: Record<string, unknown>) => Promise<void>;
  evaluate: (expression: string) => Promise<unknown>;
  pdf: (options: Record<string, unknown>) => Promise<Uint8Array>;
  close: () => Promise<void>;
};
type PdfBrowser = { newPage: () => Promise<PdfPage>; close: () => Promise<void> };
type Chromium = { launch: (options?: Record<string, unknown>) => Promise<PdfBrowser> };

export type PdfRenderer = {
  render: (html: string, pageSize: PageSize) => Promise<Buffer>;
  close: () => Promise<void>;
};

type WrittenPdf = { path: string; bytes: number; sha256: string };

const RENDER_TIMEOUT_MS = 30_000;

async function loadChromium(): Promise<Chromium> {
  // A variable specifier keeps the optional dependency out of type resolution.
  const specifier = "playwright";
  let loaded: { chromium?: Chromium };
  try {
    loaded = (await import(specifier)) as { chromium?: Chromium };
  } catch {
    throw new AppError(
      "playwright_missing",
      'rendering PDFs needs Playwright. Install it with "npm install playwright" and "npx playwright install chromium".',
    );
  }
  if (!loaded.chromium) throw new AppError("playwright_missing", "Playwright is installed but its chromium driver is unavailable");
  return loaded.chromium;
}

/** Starts one headless Chromium for any number of renders; close it when done. */
export async function openPdfRenderer(): Promise<PdfRenderer> {
  const chromium = await loadChromium();
  let browser: PdfBrowser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new AppError(
      "pdf_renderer_unavailable",
      `Chromium could not start (${toErrorMessage(error).split("\n")[0]}). Install it with "npx playwright install chromium".`,
    );
  }
  return {
    async render(html, pageSize) {
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
        // Embedded fonts decode asynchronously; printing before they are ready
        // silently sets the whole document in the fallback face.
        await page.evaluate("document.fonts.ready.then(() => true)");
        // The template's @page rule sets size and margins; format only applies
        // if a document ever lacks one.
        const bytes = await page.pdf({ format: pageSize, preferCSSPageSize: true, printBackground: true, timeout: RENDER_TIMEOUT_MS });
        return Buffer.from(bytes);
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    close: () => browser.close(),
  };
}

export async function withPdfRenderer<T>(work: (renderer: PdfRenderer) => Promise<T>): Promise<T> {
  const renderer = await openPdfRenderer();
  try {
    return await work(renderer);
  } finally {
    await renderer.close().catch(() => undefined);
  }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Writes a PDF through a staged file, so a reader never sees half a document. */
export function writePdf(path: string, bytes: Uint8Array): WrittenPdf {
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.tmp`;
  writeFileSync(staged, bytes);
  renameSync(staged, path);
  return { path, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

/** Renders one HTML document to a PDF file. */
export async function renderPdf(html: string, outPath: string, options: { pageSize: PageSize }): Promise<WrittenPdf> {
  const bytes = await withPdfRenderer((renderer) => renderer.render(html, options.pageSize));
  return writePdf(outPath, bytes);
}
