import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { type RunControlIntent, submitIntent } from "#web/lib/intents.ts";

describe("web product boundary", () => {
  it("routes the product to run control with no chat route", () => {
    const app = readFileSync(resolve(process.cwd(), "src/app.tsx"), "utf8");

    expect(app).toMatch(/path="\/" element=\{<Navigate to="\/runs" replace \/>\}/);
    expect(app).not.toContain("ChatPage");
    expect(app).not.toContain('path="/chat');
  });

  it("ships no dormant composer package or component", () => {
    const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
    const components = resolve(process.cwd(), "src/components");

    expect(packageJson).not.toContain("@assistant-ui/");
    expect(existsSync(resolve(components, "assistant-ui"))).toBe(false);
    expect(existsSync(resolve(components, "trema/chat-composer.tsx"))).toBe(false);
  });

  it("narrows browser intent submission to explicit run controls", () => {
    expectTypeOf(submitIntent).parameter(0).toEqualTypeOf<RunControlIntent>();
    expectTypeOf<{ type: "message"; text: string }>().not.toExtend<RunControlIntent>();
    expectTypeOf<{ type: "stop"; runId: string }>().toExtend<RunControlIntent>();
  });
});
