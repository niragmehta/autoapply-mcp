import { decodeEntitiesOnce, htmlToText } from "../../text/html.js";

/** Collapses an HTML fragment to one line of plain text, for titles and locations. */
export function inlineText(html: string): string {
  return htmlToText(html).replace(/\s+/g, " ").trim();
}

/** Decodes the entities of an attribute value (`&amp;` in an href). */
export function attributeText(value: string): string {
  return decodeEntitiesOnce(value).trim();
}

/** Escapes plain text so it can sit inside an HTML description safely. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Joins description sections into one HTML document, skipping empty ones. */
export function joinSections(sections: readonly (string | null | undefined)[]): string {
  return sections.filter((section): section is string => typeof section === "string" && section.trim().length > 0)
    .join("\n<br/>\n");
}

/** Value of `name="…"` (or single-quoted) inside one tag's source, entity-decoded. */
export function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (!match) return null;
  return attributeText(match[1] ?? match[2] ?? "");
}

/**
 * Inner HTML of the element whose opening tag starts at `start`, balancing
 * nested elements of the same name. Descriptions routinely nest `<div>` and
 * `<span>` inside the container, which a lazy regex would cut short.
 */
export function elementInner(html: string, start: number): string | null {
  const open = /^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/.exec(html.slice(start));
  if (!open) return null;
  const name = open[1]!.toLowerCase();
  const bodyStart = start + open[0].length;
  const tags = new RegExp(`<(/?)${name}\\b[^>]*?(/?)>`, "gi");
  tags.lastIndex = bodyStart;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (match[2] === "/") continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(bodyStart, match.index);
  }
  return null;
}

/** Inner HTML of the first element whose opening tag matches `openTag`. */
export function innerHtmlOf(html: string, openTag: RegExp): string | null {
  const match = new RegExp(openTag.source, openTag.flags.replace("g", "")).exec(html);
  return match ? elementInner(html, match.index) : null;
}

/** Every JSON-LD node on a page, with arrays and `@graph` documents flattened. */
export function jsonLdNodes(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const scripts = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scripts)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    const queue: unknown[] = [data];
    while (queue.length > 0) {
      const node = queue.shift();
      if (Array.isArray(node)) queue.push(...node);
      else if (node && typeof node === "object") {
        const record = node as Record<string, unknown>;
        if (Array.isArray(record["@graph"])) queue.push(...record["@graph"]);
        else nodes.push(record);
      }
    }
  }
  return nodes;
}

/** The first schema.org `JobPosting` node on a page. */
export function findJobPosting(html: string): Record<string, unknown> | null {
  return jsonLdNodes(html).find((node) => {
    const type = node["@type"];
    return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
  }) ?? null;
}

/**
 * The JSON object literal that starts at or after `from` in a page script,
 * found with a string-aware brace walk so braces and quotes inside string
 * values do not end it early. Null when it never closes.
 */
export function balancedObject(text: string, from: number): string | null {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}
