import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AppError } from "../../util/errors.js";

/**
 * Parses a public XML/RSS/Atom feed without DTDs or custom entities.
 *
 * Feeds are untrusted. A DOCTYPE or ENTITY declaration could expand entities
 * or reference external resources, so any declaration fails the whole feed
 * instead of being "handled" by the parser.
 */
export function parseFeedXml(xml: string, source: string, isArray: (path: string) => boolean): unknown {
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, "");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(markup)) {
    throw new AppError("unsafe_xml", `${source} XML must not contain DOCTYPE or entity declarations`);
  }
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(markup)) {
    throw new AppError("unsafe_xml", `${source} XML contains an undeclared entity`);
  }
  if (XMLValidator.validate(xml) !== true) {
    throw new AppError("invalid_source_payload", `${source} returned malformed XML`);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    ignoreDeclaration: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
    trimValues: true,
    cdataPropName: false,
    isArray: (_name, jpath) => isArray(String(jpath)),
  });
  return parser.parse(xml) as unknown;
}

/** Text content of a parsed XML node, whether it carries attributes or not. */
export function xmlText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return xmlText((value as { "#text": unknown })["#text"]);
  return "";
}
