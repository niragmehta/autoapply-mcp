import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchText } from "./http.js";
import {
  boardToken, boardVerification, locationLabel, nonEmptyText, normalizePublicJob,
  optionalText, parseSourcePayload, postingIdentifier, publishedDate, publishedSalary,
} from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

const xmlBoolean = z.enum(["true", "false", ""]).optional().transform((value) =>
  value === "true" ? true : value === "false" ? false : undefined);
const locationSchema = z.object({
  city: optionalText, state: optionalText, state_code: optionalText,
  country: optionalText, country_code: optionalText,
});
const offerSchema = z.object({
  id: postingIdentifier, slug: postingIdentifier, title: nonEmptyText,
  description: z.string(), requirements: optionalText, benefits: optionalText,
  location: optionalText, city: optionalText, state_code: optionalText,
  country: optionalText, country_code: optionalText,
  locations: z.union([z.literal(""), z.object({ location: z.array(locationSchema) })]).optional(),
  salary: z.unknown().optional(),
  published_at: optionalText, close_at: optionalText,
  published: xmlBoolean, active: xmlBoolean, remote: xmlBoolean, hybrid: xmlBoolean, on_site: xmlBoolean,
  status: optionalText, employment_type_code: optionalText,
});
const feedSchema = z.object({
  offers: z.union([z.literal(""), z.object({ offer: z.array(offerSchema) }).strict()]),
}).strict();
type Offer = z.infer<typeof offerSchema>;

function host(company: Company): string {
  return `${boardToken(company.board, true)}.recruitee.com`;
}

function listUrl(company: Company): string {
  return `https://${host(company)}/api/feeds/offers.xml`;
}

function parseFeed(xml: string): Offer[] {
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(markup)) {
    throw new AppError("unsafe_xml", "Recruitee XML must not contain DOCTYPE or entity declarations");
  }
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(markup)) {
    throw new AppError("unsafe_xml", "Recruitee XML contains an undeclared entity");
  }
  if (XMLValidator.validate(xml) !== true) {
    throw new AppError("invalid_source_payload", "Recruitee returned malformed XML");
  }
  const parser = new XMLParser({
    ignoreAttributes: true, ignoreDeclaration: true, parseTagValue: false,
    processEntities: true, trimValues: true,
    isArray: (_name, path) => path === "offers.offer" || path === "offers.offer.locations.location",
  });
  const feed = parseSourcePayload(feedSchema, parser.parse(xml) as unknown, "Recruitee XML");
  const offers = feed.offers === "" ? [] : feed.offers.offer;
  if (new Set(offers.map((offer) => offer.id)).size !== offers.length) {
    throw new AppError("invalid_source_payload", "Recruitee XML contains repeated offer identifiers");
  }
  return offers;
}

function isPublished(offer: Offer, capturedAt: string): boolean {
  if (offer.published === false || offer.active === false
    || /^(?:closed|archived|draft|unpublished)$/i.test(offer.status ?? "")) return false;
  const closes = publishedDate(offer.close_at);
  return closes === null || Date.parse(closes) > Date.parse(capturedAt);
}

async function readOffers(company: Company): Promise<Offer[]> {
  const xml = await fetchText(listUrl(company), {
    allowedHosts: [host(company)], accept: "application/xml, text/xml",
  });
  return parseFeed(xml);
}

function jobLocations(offer: Offer): { labels: string[]; countries: string[] } {
  const locations = offer.locations && typeof offer.locations === "object" ? offer.locations.location : [];
  const values = locations.length ? locations : [offer];
  const labels = values.map((location) => locationLabel({
    city: location.city, region: "state" in location ? location.state || location.state_code : location.state_code,
    country: location.country, countryCode: location.country_code,
  })).filter(Boolean);
  return {
    labels: [...new Set(labels.length ? labels : offer.location ? [offer.location] : [])],
    countries: values.map((location) => location.country_code || location.country || ""),
  };
}

function workplaceType(offer: Offer): WorkplaceType {
  if (offer.hybrid) return "hybrid";
  if (offer.remote) return "remote";
  return offer.on_site ? "onsite" : "unknown";
}

function normalizeOffer(offer: Offer, company: Company, capturedAt: string): Job {
  const locations = jobLocations(offer);
  const type = workplaceType(offer);
  const url = `https://${host(company)}/o/${offer.slug}`;
  return normalizePublicJob({
    company, externalId: offer.id, title: offer.title, locations: locations.labels,
    url, applyUrl: `${url}/c/new`,
    descriptionHtml: [offer.description, offer.requirements, offer.benefits].filter(Boolean).join("\n"),
    postedAt: publishedDate(offer.published_at), workplaceType: type, isRemote: type === "remote",
    employmentType: offer.employment_type_code ?? undefined,
    structuredCompensation: publishedSalary(offer.salary),
  }, capturedAt, locations.countries);
}

/** Company offers XML remains public when the JSON offers API requires auth. */
export const recruiteeAdapter: SourceAdapter = {
  kind: "recruitee",
  listUrl,
  boardUrl: (company) => `https://${host(company)}`,
  async listJobs(company, capturedAt) {
    return (await readOffers(company)).filter((offer) => isPublished(offer, capturedAt))
      .map((offer) => normalizeOffer(offer, company, capturedAt));
  },
  async verifyBoard(company) {
    const now = new Date().toISOString();
    return boardVerification((await readOffers(company)).filter((offer) => isPublished(offer, now)).map((offer) => offer.title));
  },
  probeUrls: () => [],
};
