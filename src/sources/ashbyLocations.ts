import { z } from "zod";
import { logger } from "../util/logger.js";
import { asString } from "./normalize.js";

export type AshbyLocation = { location?: unknown; address?: unknown };

const CountryAddressSchema = z.object({
  postalAddress: z.object({ addressCountry: z.string() }),
});
const COUNTRY_NAMES: ReadonlyMap<string, string> = new Map([
  ["us", "United States"], ["usa", "United States"], ["united states", "United States"],
  ["united states of america", "United States"], ["ca", "Canada"], ["can", "Canada"], ["canada", "Canada"],
]);

function locationName(location: AshbyLocation, remote: boolean): string {
  const label = asString(location.location);
  if (!remote || !/^(?:remote)?$/i.test(label.trim()) || location.address == null) return label;
  const parsed = CountryAddressSchema.safeParse(location.address);
  if (!parsed.success) {
    logger.warn("Invalid Ashby postal-country metadata; retaining the display location");
    return label;
  }
  const key = parsed.data.postalAddress.addressCountry.trim().toLowerCase().replace(/\./g, "");
  const country = COUNTRY_NAMES.get(key);
  return country ? `Remote - ${country}` : label;
}

/** A job's own country disambiguates bare "Remote"; explicit place/global labels take precedence. */
export function ashbyLocations(
  primary: AshbyLocation,
  secondary: readonly AshbyLocation[] = [],
  remote = false,
): string[] {
  return [...new Set([primary, ...secondary].map((location) => locationName(location, remote))
    .filter((value) => value.length > 0))];
}
