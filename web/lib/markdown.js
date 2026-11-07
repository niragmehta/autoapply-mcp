import { html } from "./html.js";
import { safeHref } from "./urls.js";

/**
 * A small Markdown reader for stored reports and prep notes. It builds
 * elements from text and never inserts HTML, so a report that quotes a
 * posting cannot inject markup. Supported: headings, paragraphs, lists,
 * tables, fenced code, quotes, rules, bold, italic, code and http(s) links.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function inline(text) {
  return text.split(INLINE).map((part, index) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return html`<strong key=${index}>${part.slice(2, -2)}</strong>`;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return html`<code key=${index}>${part.slice(1, -1)}</code>`;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]);
      return href ? html`<a key=${index} href=${href} target="_blank" rel="noopener noreferrer">${link[1]}</a>` : link[1];
    }
    if (/^(\*[^*\s][^*]*\*|_[^_\s][^_]*_)$/.test(part)) return html`<em key=${index}>${part.slice(1, -1)}</em>`;
    return part;
  });
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

function table(lines, key) {
  const [head, , ...body] = lines;
  return html`<div class="table-wrap md__table" key=${key}>
    <table class="table">
      <thead><tr>${cells(head).map((cell) => html`<th scope="col">${inline(cell)}</th>`)}</tr></thead>
      <tbody>${body.map((row) => html`<tr>${cells(row).map((cell) => html`<td>${inline(cell)}</td>`)}</tr>`)}</tbody>
    </table>
  </div>`;
}

function list(lines, ordered, key) {
  const items = lines.map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""));
  return ordered
    ? html`<ol key=${key}>${items.map((item) => html`<li>${inline(item)}</li>`)}</ol>`
    : html`<ul key=${key}>${items.map((item) => html`<li>${inline(item)}</li>`)}</ul>`;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Markdown text as elements. Headings start at h3 so they nest under the page and panel titles. */
export function Markdown({ text }) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let index = 0;
  const take = (test) => {
    const taken = [];
    while (index < lines.length && test(lines[index])) taken.push(lines[index++]);
    return taken;
  };
  while (index < lines.length) {
    const line = lines[index];
    const key = blocks.length;
    if (line.trim() === "") {
      index += 1;
    } else if (line.trim().startsWith("```")) {
      index += 1;
      const code = take((next) => !next.trim().startsWith("```"));
      index += 1;
      blocks.push(html`<pre class="packet" key=${key}>${code.join("\n")}</pre>`);
    } else if (HEADING.test(line)) {
      const [, marks, content] = HEADING.exec(line);
      const level = Math.min(5, marks.length + 2);
      const Tag = `h${level}`;
      blocks.push(html`<${Tag} key=${key}>${inline(content)}</${Tag}>`);
      index += 1;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(html`<hr key=${key} />`);
      index += 1;
    } else if (line.trim().startsWith("|") && TABLE_RULE.test(lines[index + 1] ?? "")) {
      blocks.push(table(take((next) => next.trim().startsWith("|")), key));
    } else if (BULLET.test(line)) {
      blocks.push(list(take((next) => BULLET.test(next)), false, key));
    } else if (NUMBERED.test(line)) {
      blocks.push(list(take((next) => NUMBERED.test(next)), true, key));
    } else if (line.trim().startsWith(">")) {
      const quoted = take((next) => next.trim().startsWith(">")).map((next) => next.replace(/^\s*>\s?/, ""));
      blocks.push(html`<blockquote class="quote" key=${key}>${inline(quoted.join(" "))}</blockquote>`);
    } else {
      // The current line always belongs to the paragraph, so a stray "|" or ">" line cannot stall the loop.
      index += 1;
      const paragraph = [
        line,
        ...take(
          (next) => next.trim() !== "" && !HEADING.test(next) && !BULLET.test(next) && !NUMBERED.test(next) && !next.trim().startsWith("```") && !next.trim().startsWith("|") && !next.trim().startsWith(">"),
        ),
      ];
      blocks.push(html`<p key=${key}>${inline(paragraph.join(" "))}</p>`);
    }
  }
  return html`<div class="md">${blocks}</div>`;
}
