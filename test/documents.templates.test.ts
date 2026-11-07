import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fontWarnings, loadFonts, NO_FONTS } from "../src/documents/fonts.js";
import { applyVariant } from "../src/documents/model.js";
import { parseResumeSource } from "../src/documents/resumeSource.js";
import { formatLetterDate, renderCoverLetterHtml, splitLetter } from "../src/documents/templates/coverLetter.js";
import { renderResumeHtml } from "../src/documents/templates/resume.js";
import { keepWhole, keepWholeTerms, markup } from "../src/documents/templates/shared.js";
import { exampleResume, exampleResumeJson, removeScratch, scratchDir } from "./documents.fixtures.js";

const dir = scratchDir("templates");
afterAll(() => removeScratch(dir));

const backend = () => applyVariant(exampleResume(), "backend").document;

describe("resume template", () => {
  it("lays out the header, roles, groups, internships, education and skills like the original", () => {
    const html = renderResumeHtml(backend(), NO_FONTS);
    expect(html).toContain('<div class="name">Alex Candidate</div>');
    expect(html).toContain('<div class="headline">Backend Software Engineer</div>');
    expect(html).toContain(
      'Toronto, Canada <span class="sep">|</span> 555-0100 <span class="sep">|</span> <a href="mailto:alex@example.com">alex@example.com</a>',
    );
    expect(html).toContain(
      '<div class="row org"><span>Northwind Logistics</span><span class="accent">Toronto, Canada</span></div><div class="row title"><span>Senior Software Engineer \u2013 Platform</span><span class="accent">Mar 2021 \u2013 Present</span></div><div class="group">Reliability and scale</div><ul class="">',
    );
    // Later entries sit in a spaced block; a group without a label hangs under the title.
    expect(html).toContain('<div class="block"><div class="row org"><span>Northwind Logistics</span>');
    expect(html).toContain('<ul class="after-title"><li>Built a <span class="nw">load-testing</span> harness');
    expect(html).toContain('<div class="sub">Previous Internships</div>');
    expect(html).toContain(
      '<li><div class="row "><span><b>Bluefin Analytics</b>, Boston, USA \u2014 Software Engineer Intern</span><span class="accent">Jun 2019 \u2013 Aug 2019</span></div></li>',
    );
    expect(html).toContain('<div class="row "><span>Bachelor of Applied Science (BASc), Software Engineering</span>');
    expect(html).toContain('<span class="nw">Go</span>, <span class="nw">Python</span>');
    expect(html).toContain(' <span class="dot">\u2022</span> <span class="nw">PostgreSQL</span>');
  });

  it("sets only figures in bold and keeps hyphenated and slashed terms on one line", () => {
    const html = renderResumeHtml(backend(), NO_FONTS);
    expect(html).toContain("from <b>2k</b> to <b>40k</b> requests");
    expect(html).toContain('<span class="nw">React/Node.js</span>');
    expect(html).toContain('<span class="nw">CI/CD</span> pipeline');
    expect(html).toContain('<span class="nw">zero-downtime</span>');
    expect(markup("[[30-40%]] of R&D-heavy work")).toBe('<b><span class="nw">30-40</span>%</b> of R&amp;<span class="nw">D-heavy</span> work');
    expect(keepWholeTerms("STIG/CIS and end-to-end on Node.js")).toEqual(["STIG/CIS", "end-to-end"]);
  });

  it("writes the original's CSS values, taking colours, page and alignment from the theme", () => {
    const html = renderResumeHtml(backend(), NO_FONTS);
    for (const rule of [
      "@page { size: A4; margin: 0.5in 0.64in 0.45in 0.64in; }",
      '* { hyphens: none; -webkit-hyphens: none; font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "dlig" 0; }',
      ".accent { color: #FF6A3D; }",
      "a { color: #3A95D7; text-decoration: none; }",
      ".name { font-family: ",
      "font-size: 29.7pt; text-align: center; line-height: 1.0; }",
      "h2 { font-weight: 400; font-size: 13.4pt; line-height: 1.22; color: #FF6A3D; margin: 18px 0 9px; padding-bottom: 2px; border-bottom: 0.6pt solid #8a8a8a; }",
      "li { margin: 0; text-align: left; text-wrap: pretty; }",
      'li::before { content: "\\2022\\0020"; white-space: pre; display: inline-block; width: 9.5pt; margin-left: -9.5pt; }',
    ]) {
      expect(html).toContain(rule);
    }

    const themed = parseResumeSource({
      ...(exampleResumeJson() as object),
      theme: { accent: "#123456", linkColor: "#abcdef", pageSize: "Letter", align: "justify", margins: { top: "1in", right: "20mm", bottom: "36pt", left: "1cm" } },
    });
    const custom = renderResumeHtml(applyVariant(themed, "backend").document, NO_FONTS);
    expect(custom).toContain("@page { size: Letter; margin: 1in 20mm 36pt 1cm; }");
    expect(custom).toContain(".accent { color: #123456; }");
    expect(custom).toContain("a { color: #abcdef;");
    expect(custom).toContain("li { margin: 0; text-align: justify;");
  });

  it("escapes every piece of text and loads nothing from outside the document", () => {
    const hostile = parseResumeSource({
      version: 1,
      header: { name: "Alex <script>alert(1)</script>", headline: "A & B", contact: [{ text: "<b>x</b>", href: 'https://example.com/"onmouseover=x' }] },
      experience: [
        {
          organization: "<img src=x onerror=alert(1)>",
          roles: [{ title: "Engineer", dates: "2020", groups: [{ id: "g", label: "<i>label</i>", bullets: [{ id: "b", text: "Used <iframe> & [[5]] tools" }] }] }],
        },
      ],
      skills: { categories: [{ id: "s", label: "<u>", terms: ["</style>"] }] },
    });
    const html = renderResumeHtml(applyVariant(hostile, null).document, NO_FONTS);
    expect(html).not.toMatch(/<script|<img|<iframe|<\/style><\/span>|<u>|<i>label/);
    expect(html).toContain("Alex &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="https://example.com/&quot;onmouseover=x"');
    expect(html).toContain("Used &lt;iframe&gt; &amp; <b>5</b> tools");
    expect(html).not.toMatch(/url\((?!data:)|<link|@import/);
  });

  it("embeds TrueType fonts, refuses CFF ones and falls back to a serif stack without them", () => {
    const fonts = join(dir, "fonts");
    const trueType = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(16)]);
    mkdirSync(fonts, { recursive: true });
    for (const file of ["lmroman10-regular.ttf", "lmroman10-bold.ttf", "lmroman10-italic.ttf", "lmroman12-bold.ttf"]) {
      writeFileSync(join(fonts, file), trueType);
    }
    writeFileSync(join(fonts, "lmroman9-regular.ttf"), Buffer.concat([Buffer.from("OTTO"), Buffer.alloc(16)]));
    const set = loadFonts(fonts);
    expect(Object.keys(set.faces).sort()).toEqual(["bold", "display", "italic", "regular"]);
    expect(set.rejected).toEqual([expect.objectContaining({ role: "small", file: "lmroman9-regular.ttf" })]);
    expect(fontWarnings(set)[0]).toContain("Type3");

    const html = renderResumeHtml(backend(), set);
    expect(html).toContain(`@font-face { font-family: "LMR10"; src: url(data:font/ttf;base64,${trueType.toString("base64")}) format("truetype"); font-weight: 400; font-style: normal; }`);
    expect(html).toContain('body { font-family: "LMR10", serif;');
    expect(html).toContain('.name { font-family: "LMR12B", serif;');
    // The rejected small face falls back to the body face.
    expect(html).toContain('.contact { font-family: "LMR10", serif;');

    const bare = renderResumeHtml(backend(), loadFonts(join(dir, "no-fonts-here")));
    expect(bare).not.toContain("@font-face");
    expect(bare).toContain('body { font-family: "Latin Modern Roman", "CMU Serif", "Times New Roman", Times, serif;');
    expect(fontWarnings(loadFonts(join(dir, "no-fonts-here")))[0]).toContain("fonts not found");
  });
});

describe("cover letter template", () => {
  it("separates salutation, paragraphs and sign-off", () => {
    expect(splitLetter("Dear Hiring Team,\n\nFirst paragraph\nwraps here.\n\nSecond one.\n\nSincerely,\nAlex Candidate")).toEqual({
      salutation: "Dear Hiring Team,",
      paragraphs: ["First paragraph wraps here.", "Second one."],
      closing: "Sincerely,",
      signature: "Alex Candidate",
    });
    expect(splitLetter("Dear Acme team,\nI build platforms.\n\nThanks for reading.\nBest regards,")).toEqual({
      salutation: "Dear Acme team,",
      paragraphs: ["I build platforms.", "Thanks for reading."],
      closing: "Best regards,",
      signature: null,
    });
    expect(splitLetter("Just one paragraph.")).toEqual({ salutation: null, paragraphs: ["Just one paragraph."], closing: null, signature: null });
    // "Thanks," opening a long paragraph is prose, not a sign-off.
    expect(splitLetter("Thanks,\nline two\nline three\nline four\nline five").closing).toBeNull();
  });

  it("renders the resume's header, the recipient as a role row and an escaped body", () => {
    const source = exampleResume();
    const html = renderCoverLetterHtml(
      {
        header: source.header,
        theme: source.theme,
        date: formatLetterDate(new Date(2026, 10, 6)),
        recipient: { company: "Acme <Freight>", role: "Senior Platform Engineer", location: "Toronto, ON" },
        salutation: "Dear Hiring Team,",
        paragraphs: ["I moved 120+ services to Kubernetes & kept them up.", "Second paragraph on CI/CD pipelines."],
        closing: "Sincerely,",
        signature: "Alex Candidate",
      },
      NO_FONTS,
    );
    expect(html).toContain("<title>Alex Candidate - Cover Letter</title>");
    expect(html).toContain('<div class="name">Alex Candidate</div>');
    expect(html).toContain('<div class="row org"><span>Acme &lt;Freight&gt;</span><span class="accent">November 6, 2026</span></div>');
    expect(html).toContain('<div class="row title"><span>Senior Platform Engineer</span><span class="accent">Toronto, ON</span></div>');
    expect(html).toContain('<p class="salutation">Dear Hiring Team,</p>');
    expect(html).toContain("<p>I moved 120+ services to Kubernetes &amp; kept them up.</p>");
    expect(html).toContain('<span class="nw">CI/CD</span> pipelines');
    expect(html).toContain('<div class="signoff">Sincerely,<div class="signature">Alex Candidate</div></div>');
    expect(html).toContain(".accent { color: #FF6A3D; }");
  });

  it("formats the date line in long form", () => {
    expect(formatLetterDate(new Date(2026, 0, 2))).toBe("January 2, 2026");
  });

  it("keeps hyphenated terms whole in letter text", () => {
    expect(keepWhole("end-to-end")).toBe('<span class="nw">end-to-end</span>');
  });
});
