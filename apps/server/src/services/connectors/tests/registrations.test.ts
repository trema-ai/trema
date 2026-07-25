import { describe, expect, it } from "vitest";

import {
  ClientRegistrationValidationError,
  validateRegistrationFields,
} from "#server/services/connectors/registrations.js";

describe("client registration validation", () => {
  it("requires customer and dynamic client credentials", () => {
    for (const source of ["customer", "dynamic"] as const) {
      expect(() => validateRegistrationFields({ source })).toThrow(
        ClientRegistrationValidationError,
      );
      expect(() =>
        validateRegistrationFields({ source, clientId: "client", clientSecret: "secret" }),
      ).not.toThrow();
    }
  });

  it("requires a platform shared reference and forbids copied credentials", () => {
    expect(() => validateRegistrationFields({ source: "platform" })).toThrow(
      ClientRegistrationValidationError,
    );
    expect(() =>
      validateRegistrationFields({ source: "platform", sharedRef: "github" }),
    ).not.toThrow();
    expect(() =>
      validateRegistrationFields({
        source: "platform",
        sharedRef: "github",
        clientId: "copied-client",
      }),
    ).toThrow(ClientRegistrationValidationError);
  });
});
