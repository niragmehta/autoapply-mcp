import { decodeEntitiesOnce } from "../text/html.js";

/**
 * Funding announcements from news feeds: which company raised, how much, in
 * which round, and when.
 *
 * Headlines are written for people, not parsers, so extraction is a set of
 * conservative patterns ("Acme raises $40M Series B", "Investor leads $12M
 * round in Acme"). Anything that does not clearly name one company raising
 * money is dropped: a missed announcement costs nothing, while a wrong name
 * would send board resolution after a company that does not exist.
 */

export type FeedItem = {
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
};

function unwrap(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  const raw = cdata ? cdata[1]! : value;
  return decodeEntitiesOnce(decodeEntitiesOnce(raw))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: readonly string[]): string {
  for (const name of names) {
    const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
    if (match?.[1]) return unwrap(match[1]);
  }
  return "";
}

function isoDate(value: string): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** RSS 2.0 items and Atom entries. Regex-based so no XML entity is ever expanded; bounded so unclosed tags stay linear. */
export function parseFeedItems(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<item\b[^>]{0,2000}>([\s\S]{0,200000}?)<\/item>/gi), ...xml.matchAll(/<entry\b[^>]{0,2000}>([\s\S]{0,200000}?)<\/entry>/gi)];
  return blocks
    .map((match) => {
      const block = match[1] ?? "";
      const href = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block)?.[1] ?? "";
      return {
        title: tag(block, ["title"]),
        link: tag(block, ["link"]) || decodeEntitiesOnce(href),
        publishedAt: isoDate(tag(block, ["pubDate", "published", "updated", "dc:date"])),
        summary: tag(block, ["description", "summary"]).slice(0, 600),
      };
    })
    .filter((item) => item.title.length > 0);
}

const VERB = "(?:raises?|raised|lands|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged|gets|got|receives?|received|snags?|scores?|pulls in|picks up|attracts)";
const MONEY = "(?:US\\$|CA\\$|C\\$|A\\$|[$\\u20ac\\u00a3])\\s?\\d[\\d.,]*(?:\\s*-?\\s*(?:billion|million|bn|mn|[bmk])\\b)?";
const QUALIFIER = "(?:an?\\s+|over\\s+|more than\\s+|nearly\\s+|about\\s+|almost\\s+|up to\\s+|another\\s+|fresh\\s+|new\\s+)*";
const ROUND_WORD = "(?:funding|round|series[\\s-]+[a-h]\\b|seed|pre-seed|investment|financing|capital|backing)";

/** "Founders raise $6M for mental health startup Siggy": the company follows the descriptor noun. */
const FOR_STARTUP = new RegExp(`\\b${VERB}\\s+${QUALIFIER}${MONEY}.*?\\bfor\\s+(?:[\\w-]+\\s+){0,4}?(?:startup|start-up|company|venture)\\s+(.+)$`, "i");

const PATTERNS: readonly RegExp[] = [
  new RegExp(`^(.+?)\\s+(?:reportedly\\s+|quietly\\s+|has\\s+|have\\s+|just\\s+)?${VERB}\\s+${QUALIFIER}${MONEY}`, "i"),
  new RegExp(`^(.+?)\\s+(?:reportedly\\s+|has\\s+|have\\s+)?${VERB}\\s+${QUALIFIER}(?:[\\w-]+\\s+){0,3}${ROUND_WORD}`, "i"),
  new RegExp(`^(.+?)\\s+(?:announces?|announced|completes?|completed)\\s+(?:${MONEY}\\s+)?(?:[\\w-]+\\s+){0,3}${ROUND_WORD}`, "i"),
  new RegExp(`\\bleads?\\s+${QUALIFIER}(?:${MONEY}\\s+)?(?:[\\w-]+\\s+){0,3}(?:round|investment|financing)\\s+(?:in|for|into)\\s+(.+?)(?:\\s*[,.:;(]|\\s+-\\s|$)`, "i"),
  /^(.+?)\s+emerges? from stealth\b/i,
  new RegExp(`^(.+?)\\s+(?:hits?|reaches?|nears?)\\s+(?:a\\s+)?${MONEY}\\s+valuation`, "i"),
  new RegExp(`^(.+?)\\s+(?:is\\s+)?valued at\\s+${MONEY}`, "i"),
];

const EXCLUDED = [
  /(?<!\w)(?:acquires?|acquired|acquisition|merger|merges|spac|ipo|files? (?:for|to go) public|goes public|public offering|private placement|bankruptcy|earnings|quarterly results|lawsuit|sues)(?!\w)/i,
  /\b(?:lays? off|laid off|layoffs?|job cuts|cuts? \d[\d,]*\s*%?\s*(?:of\s+)?(?:its\s+|the\s+)?(?:jobs|staff|employees|workforce))\b/i,
  new RegExp(`\\b${VERB}\\s+${QUALIFIER}${MONEY}\\s+(?:venture\\s+|vc\\s+|growth\\s+|debut\\s+|first\\s+|new\\s+|second\\s+|third\\s+)*fund\\b`, "i"),
  /\b(?:venture fund|vc fund|investment fund|private equity fund|fund (?:i|ii|iii|iv|v|vi)\b)/i,
  /\b(?:grants?|scholarships?|donates?|donation|prize)\b/i,
  /^(?:how|why|what|when|who|where|should|can|is|are|do|does|the week|this week|ask hn|show hn|tell hn)\b/i,
];

const FUNDING_LANGUAGE = /\b(?:raises?|raised|funding|funded|series\s+[a-h]\b|seed|pre-seed|financing|investment|valuation|valued at|emerges? from stealth|round)\b/i;

const GENERIC = new Set(["ai", "startup", "startups", "company", "companies", "it", "they", "this startup", "the startup", "founders", "investors", "funding", "round", "valuation"]);

/** People raise money for a company; a headline naming them has not named the company. */
const PEOPLE = /\b(?:co-?founders?|founders?|alumni|veterans|engineers|researchers|executives|investors|team|ex-[\w-]+)\b/i;

/** Text after a descriptor noun: "Paris-based AI startup Mistral" -> "Mistral". Case-sensitive on purpose. */
const AFTER_DESCRIPTOR = /^.*\b(?:[Ss]tartup|[Ss]tart-up|[Cc]ompany|[Ff]irm|[Mm]aker|[Uu]nicorn|[Ss]cale-?up)\s+(?=[A-Z0-9])/;
const PLACE_DESCRIPTOR = /^(?:[\w&.-]+-(?:based|backed|focused|native|powered)\s+)+/i;
const LOWERCASE_LEAD = /^(?:[Tt]he\s+)?(?:[a-z][\w-]*\s+)+(?=[A-Z0-9])/;

function cleanName(raw: string): string {
  const name = raw
    .replace(/^(?:exclusive|report|breaking|update|scoop)\s*[:|-]\s*/i, "")
    .replace(/\s*,.*$/, "")
    .replace(AFTER_DESCRIPTOR, "")
    .replace(PLACE_DESCRIPTOR, "")
    .replace(LOWERCASE_LEAD, "")
    .replace(/\s*\((?:yc|y combinator)[^)]*\)/gi, "")
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/['\u2019]s$/i, "")
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "")
    .trim();
  if (name.length < 2 || name.length > 60) return "";
  if (name.split(/\s+/).length > 5) return "";
  if (GENERIC.has(name.toLowerCase()) || PEOPLE.test(name)) return "";
  if (!/^[A-Z0-9]|^[a-z][A-Z]/.test(name)) return "";
  if (/\b(?:raises?|funding|round|valuation|billion|million|reportedly)\b/i.test(name)) return "";
  return name;
}

/** The capitalized words a "for ... startup X" headline ends with: "Siggy to expand" -> "Siggy". */
function leadingName(tail: string): string {
  const words: string[] = [];
  for (const word of tail.trim().split(/\s+/)) {
    if (!/^[A-Z0-9]|^[a-z][A-Z]/.test(word) || words.length === 4) break;
    words.push(word);
  }
  return words.join(" ").replace(/[,.:;!?]+$/, "");
}

/** The company a funding headline is about, or "" when the headline is not clearly one. */
export function companyFromHeadline(title: string): string {
  const headline = title
    .slice(0, 300)
    .replace(/\s+[|\u2013\u2014-]\s+(?:TechCrunch|Crunchbase News|SiliconANGLE|GeekWire|BetaKit|The Guardian|PR Newswire)\s*$/i, "")
    .trim();
  if (EXCLUDED.some((pattern) => pattern.test(headline)) || !FUNDING_LANGUAGE.test(headline)) return "";
  const forStartup = FOR_STARTUP.exec(headline);
  if (forStartup?.[1]) {
    const name = cleanName(leadingName(forStartup[1]));
    if (name) return name;
  }
  for (const pattern of PATTERNS) {
    const match = pattern.exec(headline);
    if (match?.[1]) {
      const name = cleanName(match[1]);
      if (name) return name;
    }
  }
  return "";
}

const UNIT: Record<string, string> = { billion: "B", bn: "B", b: "B", million: "M", mn: "M", m: "M", k: "K" };

/** "$100 million" -> "$100M", "$5.2-million USD" -> "$5.2M". */
export function normalizeAmount(raw: string): string {
  const match = /^(US\$|CA\$|C\$|A\$|[$\u20ac\u00a3])\s?(\d[\d.,]*)(?:\s*-?\s*(billion|million|bn|mn|[bmk]))?/i.exec(raw.trim());
  if (!match) return "";
  const unit = match[3] ? UNIT[match[3].toLowerCase()] ?? "" : "";
  return `${match[1]}${match[2]!.replace(/[.,]$/, "")}${unit}`;
}

export function fundingDetails(text: string): { amount: string; round: string } {
  const amount = normalizeAmount(new RegExp(MONEY, "i").exec(text)?.[0] ?? "");
  const round = /\b(pre-seed|seed(?= round| funding| financing|\b)|series[\s-]+[a-h]\b\+?|growth (?:round|equity|funding)|bridge round|strategic (?:round|investment)|venture debt)/i.exec(text)?.[1] ?? "";
  return {
    amount,
    round: round
      .replace(/\s+/g, " ")
      .replace(/^series[\s-]+([a-h])/i, (_whole, letter: string) => `Series ${letter.toUpperCase()}`)
      .replace(/^(pre-seed|seed|growth .+|bridge round|strategic .+|venture debt)$/i, (word: string) => word.toLowerCase()),
  };
}

export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:inc|llc|ltd|corp|corporation|co|technologies|technology|labs|hq)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}
