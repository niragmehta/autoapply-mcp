/**
 * Minimal MIME reader for alert emails.
 *
 * Only what reading a job-alert email needs: split multipart bodies, undo
 * base64 and quoted-printable per part, and decode the declared charset. The
 * raw message is read as latin1 so every byte survives until its part's own
 * charset is known.
 */

export type MimePart = { contentType: string; charset: string; body: string };

type Headers = Map<string, string>;

function splitHeaders(raw: string): { headers: Headers; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const head = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : "";
  const headers: Headers = new Map();
  let current = "";
  const commit = () => {
    const colon = current.indexOf(":");
    if (colon > 0) headers.set(current.slice(0, colon).trim().toLowerCase(), current.slice(colon + 1).trim());
  };
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      current += ` ${line.trim()}`;
      continue;
    }
    commit();
    current = line;
  }
  commit();
  return { headers, body };
}

function param(header: string, name: string): string {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(header);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function quotedPrintableBytes(text: string): Buffer {
  const unfolded = text.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < unfolded.length; index += 1) {
    const char = unfolded[index]!;
    const hex = unfolded.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(unfolded.charCodeAt(index) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string, charset: string): string {
  const kind = encoding.toLowerCase();
  if (kind === "base64") return decodeBytes(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"), charset);
  if (kind === "quoted-printable") return decodeBytes(quotedPrintableBytes(body), charset);
  return decodeBytes(Buffer.from(body, "latin1"), charset);
}

const MAX_DEPTH = 6;

function parse(raw: string, depth: number, out: MimePart[]): void {
  const { headers, body } = splitHeaders(raw);
  const contentType = headers.get("content-type") ?? "text/plain";
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("multipart/") && depth < MAX_DEPTH) {
    const boundary = param(contentType, "boundary");
    if (!boundary) return;
    const delimiter = `--${boundary}`;
    const sections = body.split(delimiter).slice(1);
    for (const section of sections) {
      if (section.startsWith("--")) break;
      // The line break before a delimiter belongs to the delimiter, not the part.
      parse(section.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), depth + 1, out);
    }
    return;
  }
  const charset = param(contentType, "charset");
  out.push({ contentType: type, charset: charset || "utf-8", body: decodeBody(body, headers.get("content-transfer-encoding") ?? "7bit", charset) });
}

/** Leaf parts of a raw RFC 822 message, each decoded to text. A string is taken as UTF-8. */
export function parseMime(source: Buffer | string): MimePart[] {
  const raw = (typeof source === "string" ? Buffer.from(source, "utf8") : source).toString("latin1");
  const parts: MimePart[] = [];
  parse(raw, 0, parts);
  return parts;
}

/** The HTML and plain-text bodies of a message, concatenated per kind. */
export function messageBodies(source: Buffer | string): { html: string; text: string } {
  const parts = parseMime(source);
  return {
    html: parts.filter((part) => part.contentType === "text/html").map((part) => part.body).join("\n"),
    text: parts.filter((part) => part.contentType === "text/plain").map((part) => part.body).join("\n"),
  };
}
