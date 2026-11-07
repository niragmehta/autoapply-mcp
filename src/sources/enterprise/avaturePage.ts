import { attribute, attributeText, elementInner, inlineText } from "./markup.js";
import { namedMonthDate } from "./dates.js";

/**
 * Parsers for Avature career portals, which render search results and job
 * pages server-side. Result cards vary by tenant theme (`article--result`,
 * `article--jobs`, with or without the leading `article` class), so cards are
 * found by class fragment and titles by their link to a JobDetail page.
 */

export type AvatureCard = { id: string; url: string; title: string; location: string; postedAt: string | null };

const CARD = /<article\b[^>]*\bclass\s*=\s*["'][^"']*\barticle--(?:result|jobs)\b[^"']*["'][^>]*>/gi;
const DETAIL_LINK = /<a\b[^>]*\bhref\s*=\s*["']([^"']*\/JobDetail[/?][^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

/** The numeric job id in a JobDetail link: path style `/JobDetail/<slug>/<id>` or `?jobId=<id>`. */
export function avatureJobId(href: string): string | null {
  return /\/JobDetail\/(?:[^/?#]*\/)?(\d{1,12})\/?(?:[?#]|$)/.exec(href)?.[1]
    ?? /\/JobDetail\/?\?(?:[^#]*&)?jobId=(\d{1,12})/i.exec(href)?.[1]
    ?? null;
}

/** A JobDetail URL without tracking parameters; `jobId` stays when the id travels in the query. */
export function avatureDetailUrl(url: URL): string | null {
  const id = avatureJobId(url.pathname + url.search);
  if (!id) return null;
  const pathStyle = /\/JobDetail\/(?:[^/?#]*\/)?\d{1,12}\/?$/.test(url.pathname);
  return pathStyle ? `${url.origin}${url.pathname}` : `${url.origin}${url.pathname}?jobId=${id}`;
}

function cardTitle(block: string): { href: string; title: string } | null {
  const links = [...block.matchAll(DETAIL_LINK)]
    .map((match) => ({ href: attributeText(match[1] ?? ""), title: inlineText(match[2] ?? ""), tag: match[0] }))
    .filter((link) => link.title.length > 0 && !/^(?:apply|view more|more)$/i.test(link.title));
  const preferred = links.find((link) => /article__header__text__title/.test(block.slice(0, block.indexOf(link.tag))))
    ?? links.find((link) => /\bclass\s*=\s*["']link["']/.test(link.tag))
    ?? links[0];
  return preferred ? { href: preferred.href, title: preferred.title } : null;
}

/** Result cards on one SearchJobs page, resolved against `origin` and kept on its host. */
export function parseAvatureCards(html: string, origin: string): AvatureCard[] {
  const host = new URL(origin).hostname;
  return [...html.matchAll(CARD)].flatMap((match) => {
    const block = elementInner(html, match.index ?? 0) ?? "";
    const link = cardTitle(block);
    if (!link) return [];
    let url: URL;
    try {
      url = new URL(link.href, origin);
    } catch {
      return [];
    }
    const id = avatureJobId(url.pathname + url.search);
    const detailUrl = avatureDetailUrl(url);
    if (url.hostname !== host || !id || !detailUrl) return [];
    const location = /\blist-item-location\b[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? "";
    const posted = /Posted\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(block)?.[1] ?? "";
    return [{ id, url: detailUrl, title: link.title, location: inlineText(location), postedAt: namedMonthDate(posted) }];
  });
}

/** Number of result cards before any were dropped, for the short-page test. */
export function avatureCardCount(html: string): number {
  return [...html.matchAll(CARD)].length;
}

/** The total the results legend announces ("326 results"), or null. */
export function avatureTotal(html: string): number | null {
  const total = /aria-label\s*=\s*["'](\d{1,6}) results?["']/i.exec(html)?.[1] ?? /\bof\s+(\d{1,6})\s+results?\b/i.exec(html)?.[1];
  return total ? Number(total) : null;
}

export type AvatureDetail = { title: string; locations: string[]; descriptionHtml: string };

/** A JobDetail page's labelled fields and description, or null when it is not a job page. */
export function parseAvatureDetail(html: string): AvatureDetail | null {
  const page = /<meta\b[^>]*\bname\s*=\s*["']avature\.portal\.page["'][^>]*>/i.exec(html)?.[0];
  const articles = [...html.matchAll(/<article\b[^>]*\bclass\s*=\s*["'][^"']*\barticle--details\b[^"']*["'][^>]*>/gi)]
    .map((match) => elementInner(html, match.index ?? 0) ?? "");
  if ((page && attribute(page, "content") !== "JobDetail") || articles.length === 0) return null;
  const fields = articles.flatMap((article) => [...article.matchAll(/article__content__view__field__label[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*article__content__view__field__value[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((match) => ({ label: inlineText(match[1] ?? ""), value: inlineText(match[2] ?? "") })));
  const location = fields.find((field) => /^(?:job\s+)?locations?$/i.test(field.label))?.value ?? "";
  const title = inlineText(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(articles[0] ?? "")?.[1] ?? "")
    || inlineText(/article__content__view__field__value[^>]*>([\s\S]*?)<\/div>/i.exec(articles[0] ?? "")?.[1] ?? "");
  return {
    title,
    locations: location ? location.split(/\s*[|;]\s*/).filter(Boolean) : [],
    descriptionHtml: articles.join("\n"),
  };
}
