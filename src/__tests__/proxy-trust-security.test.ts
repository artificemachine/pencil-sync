import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type TrustProxy = (address: string, hop: number) => boolean;
type ProxyRequest = {
  socket: { remoteAddress: string };
  headers: Record<string, string>;
};

const loadModule = createRequire(import.meta.url);
const sdkRequire = createRequire(
  loadModule.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"),
);
const expressRequire = createRequire(sdkRequire.resolve("express"));
const proxyaddr = expressRequire("proxy-addr") as {
  (request: ProxyRequest, trust: TrustProxy): string;
  compile(subnet: string): TrustProxy;
};

function clientAddress(remoteAddress: string, subnet: string): string {
  return proxyaddr(
    {
      socket: { remoteAddress },
      headers: { "x-forwarded-for": "198.51.100.42" },
    },
    proxyaddr.compile(subnet),
  );
}

describe("MCP HTTP dependency proxy trust (GHSA-jqcg-44mw-7w3h)", () => {
  it.each(["::ffff:10.0.0.0/8", "::/1"])(
    "does not trust a forged forwarded address through subnet %s",
    (subnet) => {
      expect(clientAddress("203.0.113.7", subnet)).toBe("203.0.113.7");
    },
  );

  it.each(["10.0.0.0/8", "::ffff:10.0.0.0/104"])(
    "preserves legitimate proxy trust for subnet %s",
    (subnet) => {
      expect(clientAddress("10.1.2.3", subnet)).toBe("198.51.100.42");
    },
  );
});
