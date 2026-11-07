import { afterEach, describe, expect, it } from "vitest";
import { assertPublicHost, isNonPublicAddress, setHostResolver } from "../src/util/netGuard.js";
import { installTestResolver } from "./setup.js";

afterEach(() => {
  installTestResolver();
});

describe("telling public addresses from private ones", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::", "fe80::1", "fd00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:192.168.0.10", "64:ff9b::a00:1",
  ])("treats %s as non-public", (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "64:ff9b::8.8.8.8"])("treats %s as public", (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});

describe("checking a host before a request", () => {
  it("refuses a public-looking name that resolves inside the candidate's network", async () => {
    setHostResolver(async () => ["192.168.1.1"]);
    await expect(assertPublicHost("jobs.example-attacker.com")).rejects.toMatchObject({ code: "private_host" });
  });

  it("refuses a name when any one of its addresses is private", async () => {
    setHostResolver(async () => ["93.184.216.34", "127.0.0.1"]);
    await expect(assertPublicHost("rebind.example.com")).rejects.toMatchObject({ code: "private_host" });
  });

  it("allows a name that resolves only to public addresses", async () => {
    setHostResolver(async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
    await expect(assertPublicHost("boards.example.com")).resolves.toBeUndefined();
  });

  it("checks address literals without resolving them, including bracketed IPv6", async () => {
    setHostResolver(async () => {
      throw new Error("must not resolve a literal");
    });
    await expect(assertPublicHost("169.254.169.254")).rejects.toMatchObject({ code: "private_host" });
    await expect(assertPublicHost("[::1]")).rejects.toMatchObject({ code: "private_host" });
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
  });

  it("leaves a name that does not resolve for the request itself to fail on", async () => {
    setHostResolver(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    });
    await expect(assertPublicHost("no-such-host.example.com")).resolves.toBeUndefined();
  });
});
