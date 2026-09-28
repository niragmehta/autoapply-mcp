import { htmlToText } from "../text/html.js";
import { AppError } from "../util/errors.js";
import { asString } from "./normalize.js";

export type LeverDescription = {
  opening?: unknown;
  openingPlain?: unknown;
  description?: unknown;
  descriptionPlain?: unknown;
  descriptionBody?: unknown;
  descriptionBodyPlain?: unknown;
  lists?: unknown;
  salaryDescription?: unknown;
  salaryDescriptionPlain?: unknown;
  additional?: unknown;
  additionalPlain?: unknown;
};

function section(plain: unknown, html: unknown): string {
  return asString(plain).trim() || htmlToText(asString(html));
}

function listSection(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("source_invalid_payload", "Lever posting contains an invalid list section");
  }
  const heading = "text" in value ? value.text : undefined;
  const content = "content" in value ? value.content : undefined;
  if ((heading != null && typeof heading !== "string") || (content != null && typeof content !== "string")) {
    throw new AppError("source_invalid_payload", "Lever list headings and content must be strings");
  }
  return [htmlToText(asString(heading)), htmlToText(asString(content))].filter(Boolean).join("\n");
}

export function leverDescription(posting: LeverDescription): string {
  if (posting.lists != null && !Array.isArray(posting.lists)) {
    throw new AppError("source_invalid_payload", "Lever posting lists must be an array");
  }
  const body = section(posting.descriptionBodyPlain, posting.descriptionBody)
    || section(posting.descriptionPlain, posting.description);
  const parts = [
    section(posting.openingPlain, posting.opening),
    body,
    ...(posting.lists ?? []).map(listSection),
    section(posting.salaryDescriptionPlain, posting.salaryDescription),
    section(posting.additionalPlain, posting.additional),
  ];
  return [...new Set(parts.filter(Boolean))].join("\n\n");
}
