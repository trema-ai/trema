import { describe, expect, it } from "vitest";

import {
  listOperations,
  OpenApiConversionError,
  openApiSpecToToolManifest,
  parseOpenApiDocument,
} from "#/index.js";

const specJson = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Ticketing API", version: "1.0.0" },
  paths: {
    "/tickets": {
      get: {
        operationId: "listTickets",
        summary: "List tickets.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["open", "closed"] } },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createTicket",
        summary: "Create a ticket.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/TicketInput" } },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
    "/tickets/{ticketId}": {
      parameters: [{ $ref: "#/components/parameters/TicketId" }],
      get: {
        operationId: "getTicket",
        description: "Get one ticket.\nMore prose that should not survive.",
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: "deleteTicket",
        deprecated: true,
        summary: "Delete a ticket.",
        responses: { "204": { description: "gone" } },
      },
    },
    "/tickets/{ticketId}/attachments": {
      post: {
        operationId: "addAttachments",
        summary: "Attach files.",
        parameters: [{ $ref: "#/components/parameters/TicketId" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "array", items: { type: "string" } } } },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    parameters: {
      TicketId: {
        name: "ticketId",
        in: "path",
        required: true,
        description: "Ticket identifier.",
        schema: { type: "integer" },
      },
    },
    schemas: {
      TicketInput: {
        type: "object",
        required: ["subject"],
        properties: {
          subject: { type: "string", "x-internal": true },
          priority: { $ref: "#/components/schemas/Priority" },
        },
      },
      Priority: { type: "string", enum: ["low", "high"] },
    },
  },
});

function document() {
  return parseOpenApiDocument(specJson);
}

describe("parseOpenApiDocument", () => {
  it("parses JSON and YAML", () => {
    expect(document().version).toBe("3.0.3");
    const yaml = ["openapi: 3.1.0", "paths:", "  /a:", "    get:", "      summary: A"].join("\n");
    expect(parseOpenApiDocument(yaml).paths.get("/a")?.operations.has("GET")).toBe(true);
  });

  it("rejects Swagger 2.0 documents with a targeted message", () => {
    expect(() => parseOpenApiDocument(JSON.stringify({ swagger: "2.0", paths: {} }))).toThrow(
      /Swagger 2\.0/,
    );
  });

  it("rejects documents without paths", () => {
    expect(() => parseOpenApiDocument(JSON.stringify({ openapi: "3.0.0" }))).toThrow(/paths/);
  });
});

describe("listOperations", () => {
  it("lists every operation with method, path, and deprecation", () => {
    const operations = listOperations(document());
    expect(operations).toHaveLength(5);
    expect(operations.find((op) => op.operationId === "deleteTicket")?.deprecated).toBe(true);
  });
});

describe("openApiSpecToToolManifest", () => {
  it("converts a curated selection with defaults from the spec", () => {
    const { tools, warnings } = openApiSpecToToolManifest(document(), {
      tools: [{ operationId: "listTickets" }, { operationId: "getTicket" }],
    });

    expect(tools.map(({ name }) => name)).toEqual(["list_tickets", "get_ticket"]);
    const [list, get] = tools;
    expect(list?.method).toBe("GET");
    expect(list?.sensitivity).toBe("read");
    expect(list?.paramsSchema.properties).toHaveProperty("status");
    // Header params are transport concerns, skipped with a warning.
    expect(list?.paramsSchema.properties).not.toHaveProperty("X-Trace");
    expect(warnings.some((warning) => warning.includes("X-Trace"))).toBe(true);

    // Path-level $ref parameter resolved and required; first description line kept.
    expect(get?.path).toBe("/tickets/{ticketId}");
    expect(get?.paramsSchema.required).toEqual(["ticketId"]);
    expect(get?.description).toBe("Get one ticket.");
  });

  it("merges body properties flat, inlines $refs, and strips vendor extensions", () => {
    const { tools } = openApiSpecToToolManifest(document(), {
      tools: [{ operationId: "createTicket" }],
    });
    const properties = tools[0]?.paramsSchema.properties as Record<string, unknown>;

    expect(tools[0]?.sensitivity).toBe("write");
    expect(properties.priority).toEqual({ type: "string", enum: ["low", "high"] });
    expect(properties.subject).toEqual({ type: "string" });
    expect(tools[0]?.paramsSchema.required).toEqual(["subject"]);
  });

  it("selects by method + path and applies curation overrides", () => {
    const { tools } = openApiSpecToToolManifest(document(), {
      tools: [
        {
          method: "GET",
          path: "/tickets",
          name: "search_tickets",
          description: "Search open tickets.",
          sensitivity: "read",
        },
      ],
    });

    expect(tools[0]?.name).toBe("search_tickets");
    expect(tools[0]?.description).toBe("Search open tickets.");
  });

  it("classifies DELETE as destructive and warns on deprecated operations", () => {
    const { tools, warnings } = openApiSpecToToolManifest(document(), {
      tools: [{ operationId: "deleteTicket" }],
    });

    expect(tools[0]?.sensitivity).toBe("destructive");
    expect(warnings.some((warning) => warning.includes("deprecated"))).toBe(true);
  });

  it("wraps non-object request bodies in a single body parameter", () => {
    const { tools, warnings } = openApiSpecToToolManifest(document(), {
      tools: [{ operationId: "addAttachments" }],
    });

    expect(tools[0]?.paramsSchema.properties).toHaveProperty("body");
    expect(tools[0]?.paramsSchema.required).toEqual(expect.arrayContaining(["ticketId", "body"]));
    expect(warnings.some((warning) => warning.includes("non-object request body"))).toBe(true);
  });

  it("fails on unknown operations", () => {
    expect(() =>
      openApiSpecToToolManifest(document(), { tools: [{ operationId: "nope" }] }),
    ).toThrow(OpenApiConversionError);
  });

  it("fails on duplicate tool names", () => {
    expect(() =>
      openApiSpecToToolManifest(document(), {
        tools: [{ operationId: "listTickets" }, { method: "GET", path: "/tickets" }],
      }),
    ).toThrow(/Duplicate tool name/);
  });

  it("requires curation to select something", () => {
    expect(() => openApiSpecToToolManifest(document(), { tools: [] })).toThrow();
    expect(() => openApiSpecToToolManifest(document(), { tools: [{ name: "loose" }] })).toThrow();
  });
});
