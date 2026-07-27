import { beforeAll, describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "#server/openapi.js";

type Document = Awaited<ReturnType<typeof generateOpenApiDocument>>;

function operationTags(document: Document): Set<string> {
  const tags = new Set<string>();
  for (const path of Object.values(document.paths ?? {})) {
    for (const operation of Object.values(path ?? {})) {
      if (typeof operation !== "object" || operation === null || !("tags" in operation)) continue;
      for (const tag of (operation.tags as string[] | undefined) ?? []) tags.add(tag);
    }
  }
  return tags;
}

describe("generateOpenApiDocument", () => {
  let document: Document;
  let registered: string[];
  let used: Set<string>;

  beforeAll(async () => {
    document = await generateOpenApiDocument();
    registered = (document.tags ?? []).map((tag) => tag.name);
    used = operationTags(document);
  });

  it("registers every tag a route names", () => {
    expect([...used].filter((tag) => !registered.includes(tag))).toEqual([]);
  });

  it("has no registered tag without routes", () => {
    expect(registered.filter((tag) => !used.has(tag))).toEqual([]);
  });

  it("gives every registered tag a description", () => {
    expect((document.tags ?? []).filter((tag) => !tag.description).map((tag) => tag.name)).toEqual(
      [],
    );
  });
});
