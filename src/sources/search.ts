import { AppError } from "../util/errors.js";
import { searchFoorilla } from "./foorilla.js";
import { searchHimalayas } from "./himalayas.js";
import { searchBuiltIn } from "./leads/builtin.js";
import { searchConsider } from "./leads/consider.js";
import { searchGetro } from "./leads/getro.js";
import { searchJobBankCa } from "./leads/jobbankca.js";
import { searchJobicy } from "./leads/jobicy.js";
import { searchRemoteOk } from "./leads/remoteok.js";
import { searchRemotive } from "./leads/remotive.js";
import { searchTheMuse } from "./leads/themuse.js";
import { searchWeWorkRemotely } from "./leads/weworkremotely.js";
import { searchWorkingNomads } from "./leads/workingnomads.js";
import { RESTRICTED_SOURCES_ENV, isSourceEnabled } from "./leads/restricted.js";
import { SEARCH_SOURCE_IDS, parseSourceSearchInput } from "./leadTypes.js";
import type { SearchSourceId, SourceSearchInput, SourceSearchResult } from "./leadTypes.js";

type OptionalFilter = "country" | "location" | "company" | "category" | "site";

/**
 * Optional filters each source can honour. A filter a source cannot apply is
 * rejected before any request, never silently dropped: an ignored filter
 * would return results that look filtered but are not. Himalayas and Foorilla
 * reject their own unsupported location/country filters with source-specific
 * guidance, so those stay listed here.
 */
const FILTERS: Readonly<Record<SearchSourceId, readonly OptionalFilter[]>> = {
  himalayas: ["country", "location", "company"],
  foorilla: ["country", "location", "company"],
  builtin: ["location", "company", "category", "site"],
  remoteok: ["country", "location", "company"],
  remotive: ["country", "location", "company", "category"],
  weworkremotely: ["country", "location", "company", "category"],
  jobicy: ["country", "company", "category"],
  themuse: ["location", "company"],
  jobbankca: ["country", "location"],
  getro: ["country", "location", "site"],
  consider: ["country", "location", "site"],
  workingnomads: ["country", "location", "company", "category"],
};

const SEARCHERS: Readonly<Record<SearchSourceId, (input: SourceSearchInput) => Promise<SourceSearchResult>>> = {
  himalayas: searchHimalayas,
  foorilla: searchFoorilla,
  builtin: searchBuiltIn,
  remoteok: searchRemoteOk,
  remotive: searchRemotive,
  weworkremotely: searchWeWorkRemotely,
  jobicy: searchJobicy,
  themuse: searchTheMuse,
  jobbankca: searchJobBankCa,
  getro: searchGetro,
  consider: searchConsider,
  workingnomads: searchWorkingNomads,
};

/** The optional filters a lead source accepts. */
export function supportedFilters(source: SearchSourceId): readonly OptionalFilter[] {
  return FILTERS[source];
}

export async function searchJobSources(source: SearchSourceId, input: SourceSearchInput): Promise<SourceSearchResult> {
  if (!(SEARCH_SOURCE_IDS as readonly string[]).includes(source)) {
    throw new AppError("unsupported_source", `Lead search supports only: ${SEARCH_SOURCE_IDS.join(", ")}.`);
  }
  const search = parseSourceSearchInput(input);
  const unsupported = (["country", "location", "company", "category", "site"] as const)
    .filter((filter) => search[filter] !== undefined && !FILTERS[source].includes(filter));
  if (unsupported.length > 0) {
    throw new AppError("source_filter_unsupported",
      `${source} does not support the ${unsupported.join(", ")} filter(s); it accepts: ${FILTERS[source].join(", ")}.`,
      { source, unsupported });
  }
  if (!isSourceEnabled(source)) {
    throw new AppError("source_restricted",
      `${source}'s terms of use prohibit automated access, so it is off by default. To use it anyway for explicit, person-reviewed searches, add it to ${RESTRICTED_SOURCES_ENV} (for example "${source}") and restart the server.`,
      { source });
  }
  return SEARCHERS[source](search);
}
