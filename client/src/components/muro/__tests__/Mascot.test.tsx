/**
 * @file Mascot.test.tsx
 * @description Verifies the six agent/mode drawings, sizing and explicit motion opt-out.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Mascot, type MascotProps } from "../Mascot";

const cases: [MascotProps["agent"], MascotProps["mode"], string, string | null][] = [
  ["claude", "work", "sweep", "broom"],
  ["codex", "work", "build", "hammer"],
  ["claude", "wait", "wait", null],
  ["codex", "wait", "wait", null],
  ["claude", "done", "done", "brush"],
  ["codex", "done", "done", "wrench"],
];
describe("Mascot", () => {
  it.each(cases)("draws %s in %s mode", (agent, mode, animation, tool) => {
    const { container } = render(<Mascot agent={agent} mode={mode} size={104} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveClass("muro-mascot", animation);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "104");
    expect(svg).toHaveAttribute("viewBox", "0 0 100 100");
    expect(svg.querySelector(".eyes")).not.toBeNull();
    expect(svg.querySelector(".tool")?.getAttribute("data-tool") ?? null).toBe(tool);
    expect(svg.querySelectorAll(".zz")).toHaveLength(mode === "wait" ? 2 : 0);
    expect(svg.querySelectorAll(".dust circle")).toHaveLength(
      agent === "claude" && mode === "work" ? 3 : 0
    );
    expect(svg.querySelectorAll(".brick-new, .spark")).toHaveLength(
      agent === "codex" && mode === "work" ? 2 : 0
    );
    const mouth = agent === "claude" ? "M45 74 H55" : "M43 80 H57";
    expect(svg.querySelector(`path[d="${mouth}"]`) !== null).toBe(mode === "wait");
  });
  it("updates the CSS motion guard and size without changing the drawing", () => {
    const { container, rerender } = render(
      <Mascot agent="claude" mode="work" reducedMotion size={60} />
    );
    expect(container.querySelector("svg")).toHaveAttribute("data-reduced", "1");
    expect(container.querySelector("svg")).toHaveAttribute("height", "60");
    expect(container.querySelector('[data-tool="broom"]')).not.toBeNull();
    rerender(<Mascot agent="claude" mode="work" reducedMotion={false} />);
    expect(container.querySelector("svg")).toHaveAttribute("data-reduced", "0");
    expect(container.querySelector("svg")).toHaveAttribute("height", "104");
  });
});
