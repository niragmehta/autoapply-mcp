import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { AppError } from "./errors.js";

/**
 * Keeps outbound requests on the public internet.
 *
 * URLs reach this server from job descriptions, aggregator leads and email,
 * all untrusted. A public-looking hostname can still resolve to the
 * candidate's router, a local dev server or a cloud metadata address, so every
 * request and redirect hop is checked against what its name resolves to, not
 * just its spelling.
 */

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

const NAT64_PREFIX = "64:ff9b::";

/**
 * The IPv4 address inside a NAT64 address (64:ff9b::/96). On an IPv6-only
 * network every IPv4 site appears under this prefix, so it is judged by the
 * address it carries rather than blocked outright.
 */
function nat64Ipv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith(NAT64_PREFIX)) return null;
  const tail = lower.slice(NAT64_PREFIX.length);
  if (isIP(tail) === 4) return tail;
  const groups = tail.split(":").map((group) => Number.parseInt(group, 16));
  if (groups.length > 2 || groups.some((group) => Number.isNaN(group) || group > 0xffff)) return null;
  const [high = 0, low = 0] = groups.length === 2 ? groups : [0, groups[0]];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** True for loopback, private, link-local, carrier-grade NAT, documentation, multicast and reserved addresses. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const embedded = family === 6 ? nat64Ipv4(address) : null;
  if (embedded !== null) return NON_PUBLIC.check(embedded, "ipv4");
  // IPv4-mapped IPv6 addresses are checked against the IPv4 ranges.
  return NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

export type HostResolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

let resolver: HostResolver = systemResolver;

/** Replaces name resolution, so tests never touch DNS. Pass null to restore the system resolver. */
export function setHostResolver(next: HostResolver | null): void {
  resolver = next ?? systemResolver;
}

/**
 * Refuses a host that is, or resolves to, a non-public address. A name that
 * does not resolve is left for the request itself to fail on.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) {
    if (isNonPublicAddress(host)) throw new AppError("private_host", `refusing to fetch ${hostname}: not a public address`);
    return;
  }
  let addresses: readonly string[];
  try {
    addresses = await resolver(host);
  } catch {
    return;
  }
  if (addresses.some(isNonPublicAddress)) {
    throw new AppError("private_host", `refusing to fetch ${hostname}: it resolves to a non-public address`);
  }
}
