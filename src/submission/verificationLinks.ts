/**
 * Finds the account-verification link in an email Workday sent.
 *
 * Workday will not let a newly registered candidate sign in until a link it
 * emails has been opened. Following that link is the one step of a run steered
 * by an email rather than by the employer's own pages, so the link is held to a
 * narrow standard: https, on a host Workday owns, and not one of the footer
 * links every such email also carries. Nothing here touches the network: the
 * inbox reader supplies the messages and the browser opens what this picks.
 */
import { decodeEntitiesOnce } from "../text/html.js";

/**
 * Domains Workday serves candidate pages and mail from. A host must be one of
 * these or a subdomain of one, matched on a dot boundary, so look-alikes such
 * as `myworkdayjobs.com.evil.example` and `evilworkday.com` are refused.
 */
const WORKDAY_DOMAINS = ["myworkdayjobs.com", "myworkdaysite.com", "myworkday.com", "workday.com"] as const;

export function isWorkdayHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return WORKDAY_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Whether an address belongs to Workday, such as `acme@otp.workday.com`. */
export function isWorkdaySender(address: string): boolean {
  const trimmed = address.trim().replace(/>$/, "");
  return trimmed.includes("@") && isWorkdayHost(trimmed.split("@").pop() ?? "");
}

/** Workday sends each tenant's mail from an address named after it. */
function senderTenant(address: string): string {
  return address.trim().split("@")[0]?.toLowerCase() ?? "";
}

/** Undoes quoted-printable: soft line breaks first, then escaped bytes. */
export function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const MIME_HEADER = /^(?:mime-version|content-type|content-transfer-encoding):/im;
const BOUNDARY = /boundary\s*=\s*(?:"([^"]+)"|([^\s;"]+))/gi;
const HEADER_LINE = /^[A-Za-z][A-Za-z0-9-]*:/;

/**
 * Turns a raw message, or a bare body, into text a link can be read from.
 *
 * The code reader undoes quoted-printable across the whole message, which is
 * safe for a code but not for a link: in a part that was never encoded that
 * way, a token such as `?t=AB12` contains `=AB`, and decoding that as an
 * escaped byte corrupts the link. So each MIME part is decoded by its own
 * Content-Transfer-Encoding, base64 included. A bare body has no header to
 * say, and is decoded only when it is plainly quoted-printable: an encoded
 * HTML body escapes every attribute's `=` as `=3D`.
 */
export function decodeMessageBody(raw: string): string {
  if (!MIME_HEADER.test(raw)) {
    return decodeEntitiesOnce(/=\r?\n|=3D/.test(raw) ? decodeQuotedPrintable(raw) : raw);
  }
  const boundaries = [...raw.matchAll(BOUNDARY)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((boundary) => boundary.length > 0);
  const parts =
    boundaries.length === 0
      ? [raw]
      : raw.split(new RegExp(`^--(?:${boundaries.map(escapeRegExp).join("|")})(?:--)?[ \\t]*$`, "m"));
  return decodeEntitiesOnce(parts.map(decodePart).join("\n"));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodePart(part: string): string {
  const text = part.replace(/^\r?\n/, "");
  const end = /\r?\n\r?\n/.exec(text);
  if (!end || !HEADER_LINE.test(text)) return text;
  const headers = text.slice(0, end.index);
  const body = text.slice(end.index + end[0].length);
  const encoding = /^content-transfer-encoding:\s*"?([\w-]+)/im.exec(headers)?.[1]?.toLowerCase();
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  if (encoding !== "base64") return body;
  const type = /^content-type:\s*([\w.+-]+\/[\w.+-]+)/im.exec(headers)?.[1]?.toLowerCase() ?? "text/plain";
  // An image or attachment decodes to noise, which can only hide a stray link.
  if (!type.startsWith("text/")) return "";
  return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("utf8");
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const BARE_URL = /https:\/\/[^\s"'<>\\^`{|}]+/gi;
/** Punctuation a sentence leaves stuck to the end of a bare link. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

function linkCandidates(text: string): string[] {
  const hrefs = [...text.matchAll(HREF)].map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim());
  const bare = [...text.matchAll(BARE_URL)].map((match) => match[0].replace(TRAILING_PUNCTUATION, ""));
  return [...hrefs, ...bare];
}

type RankedLink = { url: string; verification: boolean; tenantMatch: boolean };

/** What an account-activation link carries in its path or query. */
const VERIFICATION_LINK = /activat|verif|confirm|token/i;

/**
 * Path segments of the links every Workday email carries besides the one that
 * matters: policy and help pages, unsubscribe and preference links, and the
 * images the template is built from. Whole segments, so a job slug such as
 * `Privacy-Engineer_R123` is not mistaken for the privacy policy.
 */
const FOOTER_SEGMENT =
  /^(?:unsubscribe|opt-?out|preferences|privacy(?:-?(?:policy|statement|notice))?|help|support|legal|terms(?:-of-(?:use|service))?|cookies?|static|assets?|images?|img|fonts?)$/i;
const ASSET_FILE = /\.(?:png|jpe?g|gif|svg|webp|bmp|ico|css|js|woff2?|ttf|eot)$/i;

function isFooterLink(url: URL): boolean {
  if (/unsubscribe/i.test(url.pathname + url.search)) return true;
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (ASSET_FILE.test(segments.at(-1) ?? "")) return true;
  return segments.some((segment) => FOOTER_SEGMENT.test(segment.replace(/\.[a-z0-9]+$/i, "")));
}

function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  return isWorkdayHost(url.hostname) ? url : null;
}

/**
 * The tenant a link names outright, if any: Workday puts it first in a
 * myworkdayjobs.com hostname and after `/recruiting/` on myworkdaysite.com.
 */
function namedTenant(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  if (/(?:^|\.)myworkdayjobs\.com\.?$/.test(host)) {
    const label = host.split(".")[0] ?? "";
    return /^(?:www|wd\d+|myworkdayjobs)$/.test(label) ? undefined : label;
  }
  if (/(?:^|\.)myworkdaysite\.com\.?$/.test(host)) {
    const segments = url.pathname.toLowerCase().split("/");
    const at = segments.indexOf("recruiting");
    return at >= 0 ? segments[at + 1] || undefined : undefined;
  }
  return undefined;
}

function mentionsTenant(url: URL, tenant: string): boolean {
  if (url.hostname.toLowerCase().split(".")[0] === tenant) return true;
  return url.pathname.toLowerCase().split("/").includes(tenant);
}

function rankLinks(candidates: readonly string[], tenant: string | undefined): RankedLink[] {
  const seen = new Map<string, RankedLink>();
  for (const raw of candidates) {
    const url = allowedUrl(raw);
    if (!url || isFooterLink(url) || seen.has(url.href)) continue;
    const named = namedTenant(url);
    // Another employer's link. Two runs can wait on one mailbox, and opening
    // the other run's link would verify an account this run cannot use.
    if (tenant && named && named !== tenant) continue;
    seen.set(url.href, {
      url: url.href,
      verification: VERIFICATION_LINK.test(url.pathname + url.search),
      tenantMatch: Boolean(tenant && mentionsTenant(url, tenant)),
    });
  }
  const links = [...seen.values()];
  // A mailer that wraps a long link in the plain-text part leaves a truncated
  // copy behind, which is a prefix of the real one.
  const whole = links.filter((link) => !links.some((other) => other.url !== link.url && other.url.startsWith(link.url)));
  // Stable, so equally ranked links keep document order: hrefs before bare text.
  return whole.sort((a, b) => rank(b) - rank(a));
}

function rank(link: RankedLink): number {
  return (link.verification ? 2 : 0) + (link.tenantMatch ? 1 : 0);
}

function normalizeTenant(tenant: string | undefined): string | undefined {
  return tenant?.trim().toLowerCase() || undefined;
}

/**
 * The Workday links in an email, best first.
 *
 * Takes the raw message or just its body: quoted-printable, base64 and HTML
 * entities are undone first, so an `&amp;` in an href and a link split by a
 * soft line break both come out whole. Only https links on Workday's own
 * domains survive, footer and asset links are dropped, and so is a link naming
 * a tenant other than `tenant`. Activation-shaped links rank first, then links
 * naming `tenant`, then document order.
 */
export function extractVerificationLinks(body: string, tenant?: string): string[] {
  return rankLinks(linkCandidates(decodeMessageBody(body)), normalizeTenant(tenant)).map((link) => link.url);
}

export type MailMessage = { receivedAt: Date; body: string; sender?: string };

/**
 * How far before the request an email may be dated and still be believed.
 *
 * Far wider than the code reader's few seconds, because the risk runs the
 * other way. A one-time code dies when the next is requested, so a stale one
 * burns the attempt; a verification link sent a minute earlier verifies the
 * same account just as well. The date compared is the sender's own Date
 * header, so the margin also absorbs Workday's clock disagreeing with ours.
 */
export const LINK_CLOCK_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * Wording that marks an email as the verification one, however its link is
 * shaped. Without it, a "thank you for applying" email landing mid-wait would
 * be followed in place of the email actually being waited for.
 */
const VERIFICATION_WORDING = /\bverif(?:y|ication)\b|\bactivat(?:e|ion)\b|\bconfirm (?:your )?(?:email|account)\b/i;

/**
 * Picks the verification link out of one mailbox read.
 *
 * Only Workday senders count, only from `since` less the clock tolerance, and
 * only messages that read as a verification email or carry an
 * activation-shaped link. The newest such message belonging to `tenant` - by
 * its sender, `acme@otp.workday.com`, or by a link naming it - wins, and
 * failing that the newest such message at all.
 */
export function chooseVerificationLink(
  messages: readonly MailMessage[],
  options: { since: Date; tenant?: string },
): string | null {
  const tenant = normalizeTenant(options.tenant);
  const floor = options.since.getTime() - LINK_CLOCK_TOLERANCE_MS;
  const candidates = messages
    .filter((message) => message.receivedAt.getTime() >= floor && isWorkdaySender(message.sender ?? ""))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .map((message) => {
      const text = decodeMessageBody(message.body);
      return { sender: message.sender ?? "", text, links: rankLinks(linkCandidates(text), tenant) };
    })
    .filter(({ text, links }) => links[0] !== undefined && (links[0].verification || VERIFICATION_WORDING.test(text)));
  const ours = tenant
    ? candidates.find(({ sender, links }) => senderTenant(sender) === tenant || links.some((link) => link.tenantMatch))
    : undefined;
  return (ours ?? candidates[0])?.links[0]?.url ?? null;
}
