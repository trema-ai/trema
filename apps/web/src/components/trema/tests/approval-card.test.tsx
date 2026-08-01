import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "#web/components/trema/approval-card.tsx";

describe("approval card", () => {
  it("identifies the connector account when a live approval resolves its label", () => {
    render(
      <ApprovalCard
        headline="Allow sending this message?"
        kind="approval"
        connector={{
          name: "Google Workspace",
          account: { label: "owner@example.com", source: "personal" },
        }}
        options={[]}
      />,
    );

    expect(screen.getByText("Using owner@example.com")).toBeTruthy();
  });

  it("keeps the provenance fallback while account identity is loading", () => {
    render(
      <ApprovalCard
        headline="Allow sending this message?"
        kind="approval"
        connector={{ name: "Google Workspace", account: { source: "organization" } }}
        options={[]}
      />,
    );

    expect(screen.getByText("Using an organization-provided account")).toBeTruthy();
  });
});
