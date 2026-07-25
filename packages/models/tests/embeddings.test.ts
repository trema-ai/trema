import { describe, expect, it, vi } from "vitest";

import { createSdkEmbeddingPort, EmbeddingCallError } from "#models/index.js";

const endpoint = {
  protocol: "openai-compatible" as const,
  baseUrl: "https://embeddings.example.test/v1",
  apiKey: "embedding-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function vectorResponse(vectors: number[][]): Response {
  return jsonResponse({
    object: "list",
    model: "text-embedding-3-small",
    data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
    usage: { prompt_tokens: 4, total_tokens: 4 },
  });
}

describe("openai-compatible embedding port", () => {
  it("posts the batch to the embeddings path and returns vectors in order", async () => {
    const fetch = vi.fn(async () =>
      vectorResponse([
        [0.1, 0.2],
        [0.3, 0.4],
      ]),
    );
    const port = createSdkEmbeddingPort({
      endpoint,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const result = await port.embed({
      model: "text-embedding-3-small",
      input: ["first", "second"],
    });

    expect(result.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://embeddings.example.test/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "text-embedding-3-small",
      input: ["first", "second"],
    });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer embedding-secret");
  });

  it("sends no authorization header when the endpoint needs no key", async () => {
    const fetch = vi.fn(async () => vectorResponse([[1, 0]]));
    const port = createSdkEmbeddingPort({
      endpoint: { protocol: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1" },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await port.embed({ model: "bge-small", input: ["local"] });

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("returns nothing without calling the endpoint for an empty batch", async () => {
    const fetch = vi.fn(async () => vectorResponse([]));
    const port = createSdkEmbeddingPort({
      endpoint,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(port.embed({ model: "text-embedding-3-small", input: [] })).resolves.toEqual({
      vectors: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("raises a typed error and marks a server failure retryable", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { message: "overloaded" } }, 503));
    const port = createSdkEmbeddingPort({
      endpoint,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const failure = await port
      .embed({ model: "text-embedding-3-small", input: ["first"] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingCallError);
    expect((failure as EmbeddingCallError).retryable).toBe(true);
  });

  it("raises a non-retryable error when the endpoint rejects the request", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { message: "unknown model" } }, 400));
    const port = createSdkEmbeddingPort({
      endpoint,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const failure = await port
      .embed({ model: "missing-model", input: ["first"] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmbeddingCallError);
    expect((failure as EmbeddingCallError).retryable).toBe(false);
  });

  it("rejects a response whose vector count does not match the batch", async () => {
    const fetch = vi.fn(async () => vectorResponse([[0.1, 0.2]]));
    const port = createSdkEmbeddingPort({
      endpoint,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(
      port.embed({ model: "text-embedding-3-small", input: ["first", "second"] }),
    ).rejects.toBeInstanceOf(EmbeddingCallError);
  });
});
