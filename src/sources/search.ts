import { AppError } from "../util/errors.js";
import { searchFoorilla } from "./foorilla.js";
import { searchHimalayas } from "./himalayas.js";
import type { SearchSourceId, SourceSearchInput, SourceSearchResult } from "./leadTypes.js";

export type { JobLead, SearchSourceId, SourceSearchInput, SourceSearchResult } from "./leadTypes.js";

export async function searchJobSources(source: SearchSourceId, input: SourceSearchInput): Promise<SourceSearchResult> {
  switch (source) {
    case "himalayas": return searchHimalayas(input);
    case "foorilla": return searchFoorilla(input);
    default: throw new AppError("unsupported_source", "Lead search supports only himalayas and foorilla.");
  }
}
