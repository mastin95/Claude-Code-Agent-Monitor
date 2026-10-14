/**
 * @file KeyIdeas.test.tsx
 * @description Tests idea bubbles, accessible history dots, timeline, setup copy and live open-sheet updates.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  IDEA_KINDS,
  IdeaBubble,
  IdeaDots,
  IdeaLegend,
  IdeaTimeline,
  sessionIdeas,
  type KeyIdea,
} from "../KeyIdeas";
import { PostIt } from "../PostIt";
import { Board } from "../Board";
import type { MuroSession } from "../model";
import i18n from "../../../i18n";
import { api } from "../../../lib/api";

vi.mock("../../../lib/api", () => ({ api: { sessions: { stats: vi.fn() } } }));
const ideas: KeyIdea[] = IDEA_KINDS.map((kind, index) => ({
  kind,
  text: `Decision ${index}`,
  at: `2026-10-14T10:0${index}:00Z`,
}));
const session: MuroSession = {
  id: "ideas",
  provider: "claude",
  name: "Design decisions",
  status: "active",
  started_at: "2026-10-14T09:00:00Z",
  ended_at: null,
  cwd: null,
  model: null,
  metadata: JSON.stringify({ key_ideas: ideas }),
};
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.mocked(api.sessions.stats)
    .mockReset()
    .mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reads only valid bounded ideas and safely handles malformed metadata", () => {
  expect(sessionIdeas({ metadata: "not JSON" })).toEqual([]);
  expect(sessionIdeas({ metadata: "null" })).toEqual([]);
  expect(
    sessionIdeas({
      metadata: JSON.stringify({ key_ideas: [{ kind: "other", text: "bad", at: ideas[0]!.at }] }),
    })
  ).toEqual([]);
  expect(
    sessionIdeas({
      metadata: JSON.stringify({ key_ideas: Array.from({ length: 15 }, () => ideas[0]) }),
    })
  ).toHaveLength(12);
});
it("shows the latest bubble and all colored dots with an accessible breakdown", () => {
  const { container, rerender } = render(<IdeaBubble ideas={ideas} />);
  expect(screen.getByText("Decision 3")).toBeVisible();
  expect(screen.queryByText("Decision 0")).not.toBeInTheDocument();
  expect(screen.getByText("4 ideas: 1 Approach, 1 Pivot, 1 Risk, 1 Improvement")).toHaveClass(
    "sr-only"
  );
  expect(container.querySelectorAll(".muro-idea-dots > span")).toHaveLength(4);
  expect(container.querySelector(".muro-idea-dots .latest")).toHaveStyle({
    "--idea-dot": "#2EA44F",
  });
  expect(container.querySelector(".muro-idea-bubble")).toHaveStyle({
    "--idea-bg": "#C9F2C3",
    "--idea-ink": "#1F7A35",
  });
  const original = container.querySelector(".muro-idea-bubble");
  rerender(<IdeaBubble ideas={ideas.slice(0, 3)} reducedMotion stage />);
  expect(container.querySelector(".muro-idea-bubble")).not.toBe(original);
  expect(container.querySelector(".muro-idea-bubble")).toHaveClass(
    "muro-idea-still",
    "muro-idea-stage"
  );
  rerender(<IdeaBubble ideas={[]} />);
  expect(container).toBeEmptyDOMElement();
});
it("labels all four legend types and leaves empty dot lists hidden", () => {
  const { container } = render(
    <>
      <IdeaLegend />
      <IdeaDots ideas={[]} count />
    </>
  );
  expect(screen.getByLabelText("Key idea types").children).toHaveLength(4);
  for (const name of ["Approach", "Pivot", "Risk", "Improvement"])
    expect(screen.getByText(name)).toBeVisible();
  expect(container.querySelector(".muro-idea-count")).toBeNull();
});
it.each([
  ["en", "1 idea", "2 ideas", ":"],
  ["es", "1 idea", "2 ideas", ":"],
  ["zh", "1 条想法", "2 条想法", "："],
  ["vi", "1 ý tưởng", "2 ý tưởng", ":"],
  ["ko", "아이디어 1개", "아이디어 2개", ":"],
])("uses localized singular and plural idea labels in %s", async (language, one, other, colon) => {
  await i18n.changeLanguage(language);
  const { container, rerender } = render(<IdeaDots ideas={ideas.slice(0, 1)} count />);
  expect(screen.getByText(one, { exact: true })).toBeVisible();
  expect(container.querySelector(".sr-only")?.textContent).toMatch(new RegExp(`^${one}${colon}`));
  rerender(<IdeaDots ideas={ideas.slice(0, 2)} count />);
  expect(screen.getByText(other, { exact: true })).toBeVisible();
  expect(container.querySelector(".sr-only")?.textContent).toMatch(new RegExp(`^${other}${colon}`));
});
it.each(["working", "waiting", "done"] as const)(
  "renders the correct %s note treatment and includes the last idea in its name",
  (lane) => {
    const { container } = render(
      <PostIt
        session={{ ...session, ended_at: ideas[3]!.at }}
        lane={lane}
        reducedMotion
        onOpen={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: /Latest idea: Improvement — Decision 3/ })
    ).toBeVisible();
    if (lane === "working") {
      expect(container.querySelector(".muro-scene")).toHaveClass("muro-scene-ideas");
      expect(screen.getByText("Decision 3")).toBeVisible();
    } else {
      expect(container.querySelector(".muro-idea-bubble")).toBeNull();
      expect(screen.getByText("4 ideas", { exact: true })).toBeVisible();
    }
  }
);
it("leaves notes without ideas unchanged", () => {
  const { container } = render(
    <PostIt
      session={{ ...session, metadata: null }}
      lane="working"
      reducedMotion
      onOpen={vi.fn()}
    />
  );
  expect(container.querySelector(".muro-idea-bubble")).toBeNull();
  expect(container.querySelector(".muro-scene")).not.toHaveClass("muro-scene-ideas");
  expect(screen.getByRole("button")).not.toHaveAccessibleName(/Latest idea/);
});
it("renders the timeline in order with local 24-hour times", () => {
  const { container } = render(<IdeaTimeline ideas={ideas} />);
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
  expect(
    screen.getAllByRole("listitem").map((item) => item.querySelector("p")?.textContent)
  ).toEqual(ideas.map((idea) => idea.text));
  const time = container.querySelector("time")!;
  expect(time).toHaveAttribute("datetime", ideas[0]!.at);
  expect(time).toHaveTextContent(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ideas[0]!.at))
  );
});
it("offers translated setup help and copies the exact snippet, with an accessible failure state", async () => {
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<IdeaTimeline ideas={[]} />);
  expect(screen.getByText("No key ideas yet")).toBeVisible();
  await user.click(screen.getByText("How to enable them"));
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(copy).toHaveBeenCalledWith(i18n.t("muro:ideas.setup"));
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
  copy.mockRejectedValueOnce(new Error("denied"));
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(screen.getByRole("status")).toHaveTextContent("Could not copy");
});
it("updates ideas in an already-open sheet without fetching stats again or moving focus", async () => {
  const user = userEvent.setup();
  const ui = (metadata: string | null) => (
    <MemoryRouter>
      <Board sessions={[{ ...session, metadata }]} period="today" filterKey="all" />
    </MemoryRouter>
  );
  const { rerender } = render(ui(null));
  await user.click(screen.getByRole("button", { name: /Design decisions/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("No key ideas yet")).toBeVisible();
  const close = within(dialog).getByRole("button", { name: "Close" });
  expect(close).toHaveFocus();
  rerender(ui(session.metadata));
  expect(within(dialog).getAllByRole("listitem")).toHaveLength(4);
  expect(within(dialog).getByText("Decision 3")).toBeVisible();
  expect(within(dialog).queryByText("No key ideas yet")).not.toBeInTheDocument();
  expect(close).toHaveFocus();
  expect(api.sessions.stats).toHaveBeenCalledTimes(1);
});
