import { describe, expect, it } from "vitest";

import { parseEnv } from "./schema.js";

describe("parseEnv", () => {
  it("parses values and applies defaults", () => {
    const result = parseEnv({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/trema",
    });

    expect(result).toEqual({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/trema",
      HOST: "127.0.0.1",
      PORT: 3000,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("coerces a valid port", () => {
    const result = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/trema",
      HOST: "0.0.0.0",
      PORT: "8080",
    });

    expect(result).toEqual({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://localhost/trema",
      HOST: "0.0.0.0",
      PORT: 8080,
    });
  });

  it.each([
    [{}, "DATABASE_URL"],
    [{ DATABASE_URL: "https://example.com/trema" }, "PostgreSQL URL"],
    [
      { DATABASE_URL: "postgresql://localhost/trema", PORT: "70000" },
      "PORT",
    ],
  ])("rejects invalid input", (input, message) => {
    expect(() => parseEnv(input)).toThrow(message);
  });
});
