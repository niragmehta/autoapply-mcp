import { htmlToText } from "../text/html.js";

/**
 * Turns a raw RFC 822 message into the text a person would read.
 *
 * Recruiting mail is almost always multipart, base64- or quoted-printable-
 * encoded HTML, often in a charset other than UTF-8. The text/plain
 * alternative is preferred when there is one; HTML is reduced to text
 * otherwise. Attachments are skipped, except a forwarded message attached
 * whole, which is the reply itself.
 */

type Entity = { headers: Map<string, string>; body: string };

const MAX_DEPTH = 6;

/** Splits a binary (latin1) string into unfolded headers and body. */
function parseEntity(raw: string): Entity {
  const separator = /\r?\n\r?\n/.exec(raw);
  const head = separator ? raw.slice(0, separator.index) : raw;
  const body = separator ? raw.slice(separator.index + separator[0].length) : "";
  const headers = new Map<string, string>();
  let current = "";
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function headerParam(value: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  return match ? (match[1] ?? match[2]) : undefined;
}

function decodeQuotedPrintableBytes(text: string): string {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Undoes the transfer encoding, leaving bytes as a latin1 string. */
function decodeTransfer(body: string, encoding: string): string {
  if (encoding === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("latin1");
  if (encoding === "quoted-printable") return decodeQuotedPrintableBytes(body);
  return body;
}

function decodeCharset(bytes: string, charset: string | undefined): string {
  const buffer = Buffer.from(bytes, "latin1");
  const label = (charset ?? "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label === "us-ascii" ? "utf-8" : label, { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** RFC 2047 encoded words, as found in the headers of a forwarded message. */
export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset: string, mode: string, data: string) => {
    const bytes =
      mode.toLowerCase() === "b"
        ? Buffer.from(data, "base64").toString("latin1")
        : decodeQuotedPrintableBytes(data.replace(/_/g, " "));
    return decodeCharset(bytes, charset);
  });
}

type Collected = { plain: string[]; html: string[] };

function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (trimmed === `${marker}--`) break;
    if (trimmed === marker) {
      if (current) parts.push(current.join("\n"));
      current = [];
      continue;
    }
    current?.push(line);
  }
  // A source cut short by a partial fetch never reaches the closing marker.
  if (current && current.length > 0) parts.push(current.join("\n"));
  return parts;
}

function collect(raw: string, depth: number): Collected {
  if (depth > MAX_DEPTH) return { plain: [], html: [] };
  const { headers, body } = parseEntity(raw);
  const contentType = headers.get("content-type") ?? "text/plain";
  const type = (contentType.split(";")[0] ?? "text/plain").trim().toLowerCase();
  const encoding = (headers.get("content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  const disposition = (headers.get("content-disposition") ?? "").toLowerCase();

  if (type.startsWith("multipart/")) {
    const boundary = headerParam(contentType, "boundary");
    if (!boundary) return { plain: [], html: [] };
    const children = splitMultipart(body, boundary).map((part) => collect(part, depth + 1));
    if (type === "multipart/alternative") {
      const plain = children.flatMap((child) => child.plain).filter((text) => text.trim().length > 0);
      return plain.length > 0 ? { plain, html: [] } : { plain: [], html: children.flatMap((child) => child.html) };
    }
    return { plain: children.flatMap((child) => child.plain), html: children.flatMap((child) => child.html) };
  }
  if (type === "message/rfc822") {
    const inner = decodeTransfer(body, encoding);
    const innerHeaders = parseEntity(inner).headers;
    const preface = ["from", "subject", "date"]
      .map((name) => (innerHeaders.has(name) ? `${name[0]!.toUpperCase()}${name.slice(1)}: ${decodeEncodedWords(innerHeaders.get(name)!)}` : ""))
      .filter((line) => line.length > 0)
      .join("\n");
    const nested = collect(inner, depth + 1);
    return { plain: [preface, ...nested.plain], html: nested.html };
  }
  if (disposition.startsWith("attachment")) return { plain: [], html: [] };
  if (type !== "text/plain" && type !== "text/html") return { plain: [], html: [] };
  const text = decodeCharset(decodeTransfer(body, encoding), headerParam(contentType, "charset"));
  return type === "text/html" ? { plain: [], html: [text] } : { plain: [text], html: [] };
}

/** Readable text of a raw message: text/plain when present, otherwise HTML reduced to text. */
export function extractMessageText(source: Buffer | string): string {
  const raw = typeof source === "string" ? Buffer.from(source, "utf8").toString("latin1") : source.toString("latin1");
  const collected = collect(raw, 0);
  const plain = collected.plain.filter((text) => text.trim().length > 0);
  const text = plain.length > 0 ? plain.join("\n\n") : collected.html.map(htmlToText).join("\n\n");
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Drops the earlier conversation under a reply: quoted lines and everything
 * after an "On ... wrote:" or "Original Message" marker. A forwarded message
 * is kept, because there the forwarded part is the employer's reply.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) break;
    if (/^on .{1,200}wrote:$/i.test(trimmed)) break;
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * The few hundred characters kept for review. Links are replaced: they carry
 * tracking tokens and sometimes single-use sign-in credentials.
 */
export function makeSnippet(text: string, maxLength = 500): string {
  const collapsed = text.replace(LINK, "[link]").replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}
