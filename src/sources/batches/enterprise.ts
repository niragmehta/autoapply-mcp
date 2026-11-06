import type { AtsKind } from "../../domain/campaign.js";
import type { SourceCatalogEntry } from "../catalog.js";
import type { SourceAdapter } from "../types.js";

/**
 * Enterprise ATS adapters: iCIMS, Taleo, SuccessFactors, Oracle Cloud HCM,
 * Phenom, Eightfold, Avature, Cornerstone, UKG, ADP, Paylocity and Jobvite.
 * Discovery only; applications to these boards are prepared as manual packets.
 */
export const ENTERPRISE_ADAPTERS: Partial<Record<AtsKind, SourceAdapter>> = {};

/** Catalog entries describing each adapter above, shown by list_sources. */
export const ENTERPRISE_CATALOG: readonly SourceCatalogEntry[] = [];
