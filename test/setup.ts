import { setHostResolver } from "../src/util/netGuard.js";

/**
 * Global test setup. Every hostname resolves to one public address, so the
 * network guard never queries real DNS from a test; the fetches themselves
 * are stubbed per test.
 */
export function installTestResolver(): void {
  setHostResolver(async () => ["93.184.216.34"]);
}

installTestResolver();
