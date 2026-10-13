/**
 * @file Insights.test.tsx
 * @description Verifies real KPI totals, grouped rhythm buckets, accessible chart tooltips and motion preferences.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Charts, Kpis, rhythmBuckets } from "../Insights";
import type { MuroPeriod, MuroSummary } from "../../../lib/types";
import i18n from "../../../i18n";

function summary(period: MuroPeriod = "today"): MuroSummary {
  return {
    period,
    totals: {
      claude: { tasks_completed: 3, tokens: 150000, time_worked_ms: 3600000 },
      codex: { tasks_completed: 5, tokens: 250000, time_worked_ms: 5400000 },
    },
    streak_days: 40,
    series: {
      unit: period === "today" ? "hour" : "day",
      buckets: Array.from(
        { length: period === "today" ? 24 : period === "7d" ? 7 : 30 },
        (_, index) => ({
          bucket:
            period === "today"
              ? `2026-10-13T${String(index).padStart(2, "0")}`
              : new Date(Date.UTC(2026, 9, 13 - (period === "7d" ? 6 : 29) + index))
                  .toISOString()
                  .slice(0, 10),
          claude: index === 0 ? 3 : 0,
          codex: index === 2 ? 5 : 0,
        })
      ),
    },
    heatmap: Array.from({ length: 35 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 8, 9 + index)).toISOString().slice(0, 10),
      claude: index === 0 ? 3 : 0,
      codex: index === 34 ? 5 : 0,
    })),
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Muro insights", () => {
  it("shows all real totals and the uncapped server streak without animations under reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { container, rerender } = render(<Kpis summary={summary()} />);
    expect(screen.getByLabelText("8")).toBeVisible();
    expect(screen.getByLabelText("400K")).toBeVisible();
    expect(screen.getByLabelText("2h 30m")).toBeVisible();
    expect(screen.getByLabelText("40")).toBeVisible();
    expect(container.querySelectorAll(".muro-split")).toHaveLength(4);
    expect(container.querySelector(".muro-split i")).toHaveStyle({
      width: "37.5%",
      background: "#D46F3A",
    });
    const empty = summary();
    empty.totals = {
      claude: { tasks_completed: 0, tokens: 0, time_worked_ms: 0 },
      codex: { tasks_completed: 0, tokens: 0, time_worked_ms: 0 },
    };
    empty.streak_days = 0;
    rerender(<Kpis summary={empty} />);
    expect(container.querySelectorAll('.muro-split i[style*="width: 0%"]')).toHaveLength(8);
    expect(raf).not.toHaveBeenCalled();
  });
  it("animates counters to the new values and cancels frames on unmount", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const { container, rerender, unmount } = render(<Kpis summary={summary()} />);
    const count = () =>
      container.querySelector('.muro-kpi-value [aria-hidden="true"]')?.textContent;
    expect(count()).toBe("0");
    act(() => vi.advanceTimersByTime(450));
    expect(Number(count())).toBeGreaterThan(0);
    expect(Number(count())).toBeLessThanOrEqual(8);
    act(() => vi.advanceTimersByTime(500));
    expect(count()).toBe("8");
    const next = summary();
    next.totals.claude.tasks_completed = 15;
    rerender(<Kpis summary={next} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(count()).toBe("20");
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
  it("clamps a first animation timestamp older than the effect start to zero", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.spyOn(performance, "now").mockReturnValue(100);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const { container } = render(<Kpis summary={summary()} />);
    act(() => frames.splice(0).forEach((callback) => callback(90)));
    expect(container.querySelector('.muro-kpi-value [aria-hidden="true"]')).toHaveTextContent(
      /^0$/
    );
    expect(container.textContent).not.toContain("-0");
  });
  it.each([
    ["today", 17],
    ["7d", 7],
    ["30d", 10],
  ] as const)("renders %s buckets including zero gaps and totals", (period, length) => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 9, 13, 16) });
    const data = summary(period),
      buckets = rhythmBuckets(data);
    expect(buckets).toHaveLength(length);
    expect(buckets.reduce((sum, b) => sum + b.claude + b.codex, 0)).toBe(8);
    expect(buckets[buckets.length - 1]).toMatchObject({ claude: 0, codex: 0 });
    if (period === "30d")
      expect(buckets[0]).toEqual({ start: "2026-09-14", end: "2026-09-16", claude: 3, codex: 5 });
    render(
      <Charts
        summary={data}
        agentFilter={null}
        product="both"
        onFilter={vi.fn()}
        onHighlight={vi.fn()}
      />
    );
    const chart = screen.getByRole("region", { name: "Rhythm" });
    expect(within(chart).getAllByRole("img")).toHaveLength(length);
    fireEvent.focus(within(chart).getAllByRole("img")[0]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Claude 3");
    fireEvent.keyDown(within(chart).getAllByRole("img")[0]!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it.each([
    [18, 10, 8, 18], // Starts at 08:00 when activity begins later.
    [18, 5, 5, 18], // Preserves early activity.
    [12, 10, 5, 12], // Extends backwards to keep eight bars.
    [18, null, 8, 18], // An empty day uses the same morning baseline.
    [9, null, 2, 9],
    [0, null, 0, 7], // Midnight stays inside today with eight zero-filled hours.
    [3, 1, 0, 7],
    [23, 8, 8, 23],
  ])("crops today at hour %s with first activity %s to %s–%s", (hour, first, start, end) => {
    const data = summary();
    data.series.buckets = data.series.buckets.map((bucket, index) => ({
      ...bucket,
      claude: index === first ? 2 : 0,
      codex: index === first ? 3 : 0,
    }));
    const buckets = rhythmBuckets(data, new Date(2026, 9, 13, hour!));
    expect(buckets.map((bucket) => Number(bucket.start.slice(11, 13)))).toEqual(
      Array.from({ length: end! - start! + 1 }, (_, index) => start! + index)
    );
    expect(buckets.length).toBeGreaterThanOrEqual(8);
    expect(buckets.reduce((sum, bucket) => sum + bucket.claude + bucket.codex, 0)).toBe(
      first === null ? 0 : 5
    );
  });
  it("shows 35 actual heatmap dates, highlights today, and describes zero days", () => {
    const data = summary();
    render(
      <Charts
        summary={data}
        agentFilter={null}
        product="both"
        onFilter={vi.fn()}
        onHighlight={vi.fn()}
      />
    );
    const heat = screen.getByRole("region", { name: "Last 5 weeks" });
    const cells = within(heat).getAllByRole("img");
    expect(cells).toHaveLength(35);
    expect(cells[34]).toHaveAttribute("aria-current", "date");
    expect(cells[34]).toHaveAttribute("stroke", "#f3f4f6");
    fireEvent.mouseEnter(cells[1]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("0 tasks completed");
    fireEvent.mouseLeave(cells[1]!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
