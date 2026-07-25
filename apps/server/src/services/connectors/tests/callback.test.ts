import { describe, expect, it } from "vitest";

import { safeConnectorReturnUrl } from "#server/app.js";

describe("connector callback redirect guard", () => {
  const origins = ["https://app.trema.example", "https://admin.trema.example"];

  it("allows return URLs on configured web origins", () => {
    expect(
      safeConnectorReturnUrl("https://admin.trema.example/connectors?connected=true", origins),
    ).toBe("https://admin.trema.example/connectors?connected=true");
  });

  it("falls back to the first web origin for external or malformed return URLs", () => {
    expect(safeConnectorReturnUrl("https://attacker.example/steal", origins)).toBe(origins[0]);
    expect(safeConnectorReturnUrl("/relative", origins)).toBe(origins[0]);
  });
});
