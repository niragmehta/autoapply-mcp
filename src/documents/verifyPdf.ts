import { logger } from "../util/logger.js";

/**
 * Checks a rendered PDF the way an ATS will read it: through its text layer.
 *
 * Text comes from pdfjs-dist, a development dependency; where it is not
 * installed only the page count is checked and a warning says so.
 */

export type PdfExpectations = {
  maxPages: number;
  /** Texts that must appear, compared without whitespace: bullets, paragraphs, the name. */
  texts: readonly string[];
  /** Hyphenated or slashed terms that must sit whole on one line. */
  terms: readonly string[];
};

type PdfIssueCode = "page-count" | "ligature" | "soft-hyphen" | "hyphenation" | "split-term" | "missing-text" | "unreadable";
type PdfIssue = { code: PdfIssueCode; detail: string };

export type PdfVerification = {
  ok: boolean;
  /** False when pdfjs-dist is unavailable and only the page count was checked. */
  textChecked: boolean;
  pages: number;
  issues: PdfIssue[];
  warnings: string[];
};

type PdfText = { pages: number; lines: string[] };

type TextItem = { str?: unknown; hasEOL?: unknown };
type PdfDocument = {
  numPages: number;
  getPage: (index: number) => Promise<{ getTextContent: (options?: Record<string, unknown>) => Promise<{ items: unknown[] }> }>;
};
type LoadingTask = { promise: Promise<PdfDocument>; destroy: () => Promise<void> };
type PdfJs = { getDocument: (params: Record<string, unknown>) => LoadingTask };

let pdfjs: Promise<PdfJs | null> | null = null;

function loadPdfJs(): Promise<PdfJs | null> {
  pdfjs ??= (async () => {
    // A variable specifier keeps the development dependency out of type resolution.
    const specifier = "pdfjs-dist/legacy/build/pdf.mjs";
    try {
      const loaded = (await import(specifier)) as Partial<PdfJs>;
      return typeof loaded.getDocument === "function" ? (loaded as PdfJs) : null;
    } catch {
      return null;
    }
  })();
  return pdfjs;
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** Page count from the PDF structure itself; Chromium writes page objects uncompressed. */
export function countPdfPages(bytes: Uint8Array): number {
  return (latin1(bytes).match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

/** Type3 fonts carry no real text encoding; ATS parsers often read them as noise. */
export function hasType3Fonts(bytes: Uint8Array): boolean {
  return /\/Subtype\s*\/Type3\b/.test(latin1(bytes));
}

/** The PDF's text, line by line in reading order, or null without pdfjs-dist. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText | null> {
  const library = await loadPdfJs();
  if (!library) return null;
  // pdfjs takes ownership of the buffer it is given, so it gets a copy.
  const task = library.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
  try {
    const document = await task.promise;
    const lines: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      // Raw text: pdfjs would otherwise expand a ligature glyph back into letters and hide it.
      const content = await page.getTextContent({ disableNormalization: true });
      const pageLines = (content.items as TextItem[]).reduce<{ done: string[]; current: string }>(
        (state, item) => {
          const current = state.current + (typeof item.str === "string" ? item.str : "");
          return item.hasEOL === true ? { done: [...state.done, current], current: "" } : { done: state.done, current };
        },
        { done: [], current: "" },
      );
      lines.push(...pageLines.done, ...(pageLines.current.length > 0 ? [pageLines.current] : []));
    }
    return { pages: document.numPages, lines };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

const compact = (text: string) => text.replace(/[\s\u00a0\u00ad]+/g, "");

function pageIssues(pages: number, maxPages: number): PdfIssue[] {
  return pages > maxPages ? [{ code: "page-count", detail: `the document runs to ${pages} pages; at most ${maxPages} allowed` }] : [];
}

function glyphIssues(lines: readonly string[], texts: readonly string[]): PdfIssue[] {
  const excerpt = (line: string) => `"${line.trim().slice(0, 80)}"`;
  return [
    ...lines.flatMap((line) => [
      ...(/[\ufb00-\ufb06]/.test(line) ? [{ code: "ligature" as const, detail: `ligature glyph in ${excerpt(line)}` }] : []),
      ...(line.includes("\u00ad") ? [{ code: "soft-hyphen" as const, detail: `soft hyphen in ${excerpt(line)}` }] : []),
    ]),
    // Chromium drops an unbroken soft hyphen from the text layer, so the source is checked too.
    ...texts.filter((text) => text.includes("\u00ad")).map((text) => ({ code: "soft-hyphen" as const, detail: `soft hyphen in the source text ${excerpt(text)}` })),
  ];
}

/**
 * A word broken across lines by hyphenation. Chromium marks a break it made
 * itself with U+2010 rather than the typed hyphen, so that is always reported;
 * a typed hyphen at a line end only when the source writes the word whole.
 */
function hyphenationIssues(lines: readonly string[], texts: readonly string[]): PdfIssue[] {
  const source = ` ${texts.join(" ").toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ")} `;
  return lines.flatMap((line, index) => {
    const tail = /(\p{L}+)([-\u2010\u2011\u00ad])$/u.exec(line.trimEnd());
    const head = /^\s*(\p{L}+)/u.exec(lines[index + 1] ?? "");
    if (!tail?.[1] || !head?.[1]) return [];
    const joined = `${tail[1]}${head[1]}`.toLowerCase();
    const inserted = tail[2] !== "-";
    const brokenWord = inserted || source.includes(` ${joined} `) || (source.includes(joined) && !source.includes(`${tail[1]}-${head[1]}`.toLowerCase()));
    return brokenWord ? [{ code: "hyphenation" as const, detail: `"${joined}" is hyphenated across a line break` }] : [];
  });
}

function splitTermIssues(lines: readonly string[], terms: readonly string[]): PdfIssue[] {
  const compactLines = lines.map(compact);
  const whole = compactLines.join("");
  return [...new Set(terms)].flatMap((term) => {
    const target = compact(term);
    if (target.length === 0 || compactLines.some((line) => line.includes(target)) || !whole.includes(target)) return [];
    return [{ code: "split-term" as const, detail: `"${term}" is split across a line break` }];
  });
}

function missingTextIssues(lines: readonly string[], texts: readonly string[]): PdfIssue[] {
  const whole = compact(lines.join(""));
  return texts.flatMap((text) => {
    const target = compact(text);
    if (target.length === 0 || whole.includes(target)) return [];
    return [{ code: "missing-text" as const, detail: `text missing from the PDF: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"` }];
  });
}

export async function verifyPdf(bytes: Uint8Array, expectations: PdfExpectations): Promise<PdfVerification> {
  const warnings = hasType3Fonts(bytes)
    ? ["the PDF embeds Type3 fonts, which ATS parsers read poorly; supply the TrueType fonts described in docs/DOCUMENTS.md"]
    : [];
  let text: PdfText | null;
  try {
    text = await extractPdfText(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, textChecked: false, pages: countPdfPages(bytes), issues: [{ code: "unreadable", detail }], warnings };
  }
  if (!text) {
    logger.warn("pdfjs-dist is not installed; PDF text checks skipped");
    const pages = countPdfPages(bytes);
    const issues = pageIssues(pages, expectations.maxPages);
    return {
      ok: issues.length === 0,
      textChecked: false,
      pages,
      issues,
      warnings: [...warnings, "pdfjs-dist is not installed, so only the page count was checked"],
    };
  }
  const issues = [
    ...pageIssues(text.pages, expectations.maxPages),
    ...glyphIssues(text.lines, expectations.texts),
    ...hyphenationIssues(text.lines, expectations.texts),
    ...splitTermIssues(text.lines, expectations.terms),
    ...missingTextIssues(text.lines, expectations.texts),
  ];
  return { ok: issues.length === 0, textChecked: true, pages: text.pages, issues, warnings };
}
