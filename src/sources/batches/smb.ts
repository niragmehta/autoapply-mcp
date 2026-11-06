import type { AtsKind } from "../../domain/campaign.js";
import type { SourceCatalogEntry } from "../catalog.js";
import type { SourceAdapter } from "../types.js";

/**
 * Startup and SMB ATS adapters: BambooHR, JazzHR, Breezy, Rippling, Gem,
 * Pinpoint, Dover, Teamtailor, Personio, HiBob, Zoho Recruit and ClearCompany.
 * Discovery only; applications to these boards are prepared as manual packets.
 */
export const SMB_ADAPTERS: Partial<Record<AtsKind, SourceAdapter>> = {};

/** Catalog entries describing each adapter above, shown by list_sources. */
export const SMB_CATALOG: readonly SourceCatalogEntry[] = [];
