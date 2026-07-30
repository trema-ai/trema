import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  parseWebSearchInput,
  parseWebSearchResults,
  parseWebSearchSummary,
  WebSearchActivity,
  WebSearchResults,
} from "#web/components/trema/web-search-activity.tsx";

describe("web search activity", () => {
  it("parses recorded inputs and both historical and provider-aware summaries", () => {
    expect(
      parseWebSearchInput('{"query":"who won the last FIFA World Cup","limit":8,"recency":"year"}'),
    ).toEqual({
      query: "who won the last FIFA World Cup",
      limit: 8,
      recency: "year",
    });
    expect(parseWebSearchSummary("Found 8 web results")).toEqual({ count: 8 });
    expect(parseWebSearchSummary("Found 8 web results · DDGS")).toEqual({
      count: 8,
      provider: "DDGS",
    });
  });

  it("renders a compact human-readable summary with provider and filters", () => {
    render(
      <WebSearchActivity
        input='{"query":"who won the last FIFA World Cup","recency":"year"}'
        resultSummary="Found 8 web results · DDGS"
        state="ok"
      />,
    );

    expect(screen.getByText("Searched the web")).toBeTruthy();
    expect(screen.getByText("for “who won the last FIFA World Cup”")).toBeTruthy();
    expect(screen.getByText("DDGS")).toBeTruthy();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Past year")).toBeTruthy();
    expect(screen.queryByText("Technical details")).toBeNull();
  });

  it("previews three results and can reveal the remainder", () => {
    const raw = JSON.stringify({
      results: Array.from({ length: 4 }, (_, index) => ({
        title: `Result ${index + 1}`,
        url: `https://example${index + 1}.com/article`,
        snippet: `Snippet ${index + 1}`,
      })),
    });
    const results = parseWebSearchResults(raw);
    if (results === undefined) throw new Error("search result fixture did not parse");

    render(<WebSearchResults results={results} />);
    expect(screen.getByText("Result 1")).toBeTruthy();
    expect(screen.queryByText("Snippet 1")).toBeNull();
    expect(screen.queryByText("Result 4")).toBeNull();

    fireEvent.click(screen.getByText("Show all 4 results"));
    expect(screen.getByText("Result 4")).toBeTruthy();
    expect(screen.getByText("Show fewer results")).toBeTruthy();
  });
});
