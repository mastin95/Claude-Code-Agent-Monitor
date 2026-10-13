/**
 * @file Muro.test.tsx
 * @description Tests live sessions, today's counters, filters, request races,
 * loading/error recovery, scope changes, and localized page navigation.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Muro } from "../Muro";
import { DocumentTitle } from "../../components/DocumentTitle";
import { eventBus } from "../../lib/eventBus";
import { setScope } from "../../lib/dataScope";
import { api } from "../../lib/api";
import type { MuroSummary, Session, WSMessage } from "../../lib/types";
import i18n from "../../i18n";

vi.mock("../../lib/api", () => ({
  api: { sessions: { list: vi.fn() }, muro: { summary: vi.fn() } },
}));

const emptySummary: MuroSummary = {
  period: "today",
  totals: {
    claude: { tasks_completed: 0, tokens: 0, time_worked_ms: 0 },
    codex: { tasks_completed: 0, tokens: 0, time_worked_ms: 0 },
  },
  series: { unit: "hour", buckets: [] },
  heatmap: [],
  streak_days: 0,
};
function session(provider: Session["provider"], overrides: Partial<Session> = {}): Session {
  return {
    id: `${provider}-1`,
    provider,
    name: `Task ${provider}`,
    status: "active",
    started_at: "2026-10-13T10:00:00Z",
    ended_at: null,
    metadata: null,
    cwd: null,
    model: null,
    ...overrides,
  };
}
function list(sessions: Session[]) {
  return { sessions, total: sessions.length, limit: 10000, offset: 0 };
}
function publish(type: WSMessage["type"]) {
  eventBus.publish({ type, data: {} } as WSMessage);
}

describe("Muro", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await i18n.changeLanguage("es");
    setScope({ mode: "all", selected: [], provider: "both" });
    eventBus.setConnected(true);
    vi.mocked(api.muro.summary).mockResolvedValue(emptySummary);
    vi.mocked(api.sessions.list).mockResolvedValue(list([]));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens with today's period, waiting mascots, zero counters, and the tab title", async () => {
    render(
      <MemoryRouter initialEntries={["/muro"]}>
        <DocumentTitle />
        <Muro />
      </MemoryRouter>
    );
    expect(document.title).toBe("Muro · Claude Code Agent Monitor");
    expect(screen.getByRole("status", { name: "Cargando el Muro…" })).toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(await screen.findByText("Aún no hay nada hecho")).toBeVisible();
    expect(screen.getByRole("button", { name: "Hoy" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Esperando trabajo…")).toHaveLength(2);
    expect(screen.getAllByText("0 hechas hoy")).toHaveLength(2);
    expect(api.muro.summary).toHaveBeenCalledWith("today");
    expect(api.sessions.list).toHaveBeenCalledWith({
      status: "active",
      limit: 10000,
      include_transient: true,
      include_task_progress: true,
    });
  });

  it("uses the freshest working session for each provider and today's independent totals", async () => {
    vi.mocked(api.sessions.list).mockResolvedValue(
      list([
        session("claude", { id: "old", name: "Old task" }),
        session("claude", { name: "Revisar diseño", last_activity: "2026-10-13T12:00:00Z" }),
        session("codex", { name: "Crear endpoint" }),
        session("cursor", {
          name: "Cursor must never appear",
          last_activity: "2026-10-13T13:00:00Z",
        }),
      ])
    );
    vi.mocked(api.muro.summary).mockResolvedValue({
      ...emptySummary,
      totals: {
        claude: { tasks_completed: 3, tokens: 150000, time_worked_ms: 1000 },
        codex: { tasks_completed: 5, tokens: 299000, time_worked_ms: 1000 },
      },
    });
    const user = userEvent.setup();
    render(<Muro />);
    expect(await screen.findByText("Limpiando: Revisar diseño")).toBeVisible();
    expect(screen.getByText("Construyendo: Crear endpoint")).toBeVisible();
    expect(screen.queryByText(/Cursor must never appear/)).not.toBeInTheDocument();
    const claude = within(screen.getByRole("button", { name: "Filtrar por Claude" }));
    expect(claude.getByText("3 hechas hoy")).toBeVisible();
    expect(claude.getByTitle("150.000 tokens")).toBeVisible();
    for (const period of ["7 días", "30 días", "Hoy"]) {
      await user.click(screen.getByRole("button", { name: period }));
      expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
      expect(claude.getByText("3 hechas hoy")).toBeVisible();
    }
    expect(api.muro.summary).toHaveBeenCalledTimes(3);
  });

  it("shows waiting context and falls back to a shortened prompt", async () => {
    vi.mocked(api.sessions.list).mockResolvedValue(
      list([
        session("claude", {
          awaiting_input_since: "2026-10-13T11:00:00Z",
          awaiting_reason: "stop",
        }),
        session("claude", { id: "done", status: "completed", name: "Completed" }),
        session("codex", { name: " ", prompt_preview: "a".repeat(60) }),
      ])
    );
    const { container } = render(<Muro />);
    expect(await screen.findByText("Esperando tu OK: Task claude")).toBeVisible();
    expect(screen.getByText(`Construyendo: ${"a".repeat(40)}`)).toBeVisible();
    expect(container.querySelector('[data-agent="claude"]')).toHaveAttribute("data-mode", "wait");
    expect(container.querySelector('[data-agent="codex"]')).toHaveAttribute("data-mode", "work");
  });

  it("toggles the page-owned agent filter with mouse and keyboard", async () => {
    vi.mocked(api.sessions.list).mockResolvedValue(list([session("claude"), session("codex")]));
    const user = userEvent.setup();
    const { container } = render(<Muro />);
    const claude = await screen.findByRole("button", { name: "Filtrar por Claude" });
    const codex = screen.getByRole("button", { name: "Filtrar por Codex" });
    await user.click(claude);
    expect(
      within(screen.getByRole("region", { name: "Trabajando" })).getAllByRole("button")
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Trabajando" })).getByRole("button")
    ).toHaveTextContent("Task claude");
    expect(claude).toHaveAttribute("aria-pressed", "true");
    expect(container.firstChild).toHaveAttribute("data-agent-filter", "claude");
    await user.click(codex);
    expect(
      within(screen.getByRole("region", { name: "Trabajando" })).getByRole("button")
    ).toHaveTextContent("Task codex");
    expect(claude).toHaveAttribute("aria-pressed", "false");
    expect(container.firstChild).toHaveAttribute("data-agent-filter", "codex");
    await user.keyboard("{Enter}");
    expect(codex).toHaveAttribute("aria-pressed", "false");
    expect(
      within(screen.getByRole("region", { name: "Trabajando" })).getAllByRole("button")
    ).toHaveLength(2);
    expect(container.firstChild).toHaveAttribute("data-agent-filter", "all");
    expect(api.muro.summary).toHaveBeenCalledTimes(3);
  });

  it("recovers from an API error while retaining header and period", async () => {
    vi.mocked(api.muro.summary).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<Muro />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar el Muro.");
    await user.click(screen.getByRole("button", { name: "7 días" }));
    await user.click(screen.getByRole("button", { name: i18n.t("common:retry") }));
    expect(await screen.findByText("Aún no hay nada hecho")).toBeVisible();
    expect(screen.getByRole("button", { name: "7 días" })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the most recent waiting session when no session is working", async () => {
    vi.mocked(api.sessions.list).mockResolvedValue(
      list([
        session("claude", {
          id: "old",
          name: "Old request",
          awaiting_input_since: "2026-10-13T11:00:00Z",
        }),
        session("claude", {
          name: "New request",
          awaiting_input_since: "2026-10-13T12:00:00Z",
          last_activity: "2026-10-13T12:00:00Z",
        }),
      ])
    );
    render(<Muro />);
    expect(await screen.findByText("Esperando tu OK: New request")).toBeVisible();
    expect(
      within(screen.getByRole("button", { name: "Filtrar por Codex" })).getByText(
        "Esperando trabajo…"
      )
    ).toBeVisible();
  });

  it.each(["claude", "codex"] as const)(
    "disables the other stage card for the %s product scope, without numbers",
    async (provider) => {
      // Return both providers to also verify the UI cannot expose stale excluded data.
      vi.mocked(api.sessions.list).mockResolvedValue(list([session("claude"), session("codex")]));
      const user = userEvent.setup();
      const { container } = render(<Muro />);
      await user.click(
        await screen.findByRole("button", {
          name: `Filtrar por ${provider === "claude" ? "Codex" : "Claude"}`,
        })
      );
      act(() => setScope({ mode: "all", selected: [], provider }));
      const excluded = await screen.findByRole("button", {
        name: `Filtrar por ${provider === "claude" ? "Codex" : "Claude"}`,
      });
      expect(excluded).toBeDisabled();
      expect(excluded).toHaveClass("opacity-[0.45]");
      expect(excluded).toHaveTextContent("Fuera del filtro de producto");
      expect(within(excluded).queryByText(/hechas hoy|tokens/)).not.toBeInTheDocument();
      expect(container.firstChild).toHaveAttribute("data-agent-filter", "all");
      expect(
        within(screen.getByRole("region", { name: "Trabajando" })).getAllByRole("button")
      ).toHaveLength(1);
    }
  );

  it("debounces live events, refreshes on reconnect, and cleans up on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<Muro />);
    await act(async () => {});
    vi.mocked(api.sessions.list).mockResolvedValue(list([session("codex")]));
    act(() => {
      publish("session_created");
      publish("session_updated");
      publish("agent_updated");
      publish("remote_data.updated");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(api.muro.summary).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.muro.summary).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Construyendo: Task codex")).toBeVisible();
    act(() => eventBus.setConnected(false));
    expect(screen.getByRole("status")).toHaveTextContent("Sin conexión");
    act(() => eventBus.setConnected(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api.muro.summary).toHaveBeenCalledTimes(3);
    act(() => publish("session_updated"));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.muro.summary).toHaveBeenCalledTimes(3);
  });

  it("does not let a stale request overwrite a new source/provider scope", async () => {
    let resolve!: (value: ReturnType<typeof list>) => void;
    vi.mocked(api.sessions.list).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    render(<Muro />);
    act(() => setScope({ mode: "local", selected: [], provider: "codex" }));
    await screen.findByText("Aún no hay nada hecho");
    await act(async () => resolve(list([session("claude", { name: "Stale scope" })])));
    expect(screen.queryByText(/Stale scope/)).not.toBeInTheDocument();
    expect(api.muro.summary).toHaveBeenCalledTimes(2);
  });

  it("keeps a completion caught between active/completed requests in Done", async () => {
    vi.mocked(api.sessions.list).mockImplementation(async (params) =>
      list([
        session(
          "codex",
          params?.status === "completed"
            ? { status: "completed", ended_at: new Date().toISOString() }
            : {}
        ),
      ])
    );
    render(<Muro />);
    await screen.findByRole("region", { name: "Hecho" });
    expect(
      within(screen.getByRole("region", { name: "Hecho" })).getAllByRole("button")
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Trabajando" })).queryByRole("button")
    ).not.toBeInTheDocument();
  });

  it("shares the donut filter with the stage, board, totals and exact agent streak", async () => {
    vi.mocked(api.sessions.list).mockResolvedValue(list([session("claude"), session("codex")]));
    vi.mocked(api.muro.summary).mockImplementation(async (period = "today", agent) => ({
      ...emptySummary,
      period,
      streak_days: agent === "claude" ? 42 : 50,
      totals: {
        claude: {
          tasks_completed: agent === "codex" ? 0 : 3,
          tokens: 150000,
          time_worked_ms: 1000,
        },
        codex: {
          tasks_completed: agent === "claude" ? 0 : 5,
          tokens: 250000,
          time_worked_ms: 2000,
        },
      },
    }));
    const user = userEvent.setup();
    const { container } = render(<Muro />);
    const legend = await screen.findByRole("button", {
      name: "Filtrar gráficas y muro por Claude",
    });
    await user.hover(legend);
    expect(container.querySelector('[data-session-id="codex-1"]')).toHaveClass("muro-dimmed");
    expect(container.querySelector('[data-session-id="claude-1"]')).not.toHaveClass("muro-dimmed");
    await user.unhover(legend);
    expect(container.querySelector(".muro-dimmed")).toBeNull();
    await user.click(legend);
    await waitFor(() => expect(api.muro.summary).toHaveBeenCalledWith("today", "claude"));
    expect(await screen.findByLabelText("42")).toBeVisible();
    expect(screen.getByRole("button", { name: "Filtrar por Claude" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      within(screen.getByRole("region", { name: "Trabajando" })).getAllByRole("button")
    ).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "Cifras del periodo" })).getByLabelText("3")
    ).toBeVisible();
    const selected = screen.getByRole("button", { name: "Filtrar gráficas y muro por Claude" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    await user.click(selected);
    expect(
      within(screen.getByRole("region", { name: "Trabajando" })).getAllByRole("button")
    ).toHaveLength(2);
    expect(screen.getByLabelText("50")).toBeVisible();
  });

  it("loads the selected period, ignores a late response, and refreshes that period live", async () => {
    let resolveWeek!: (value: MuroSummary) => void;
    vi.mocked(api.muro.summary).mockImplementation((period = "today") =>
      period === "7d"
        ? new Promise((resolve) => {
            resolveWeek = resolve;
          })
        : Promise.resolve({ ...emptySummary, period, streak_days: period === "30d" ? 30 : 1 })
    );
    const user = userEvent.setup();
    render(<Muro />);
    await screen.findByRole("region", { name: "Cifras del periodo" });
    await user.click(screen.getByRole("button", { name: "7 días" }));
    expect(
      await screen.findByRole("status", { name: "Cargando el resumen de trabajo…" })
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "30 días" }));
    expect(await screen.findByLabelText("30")).toBeVisible();
    await act(async () => resolveWeek({ ...emptySummary, period: "7d", streak_days: 7 }));
    expect(screen.queryByLabelText("7")).not.toBeInTheDocument();
    expect(screen.getByText("Tareas completadas cada 3 días")).toBeVisible();
    vi.mocked(api.muro.summary).mockResolvedValue({
      ...emptySummary,
      period: "30d",
      streak_days: 31,
    });
    act(() => publish("session_updated"));
    expect(await screen.findByLabelText("31")).toBeVisible();
    expect(api.muro.summary).toHaveBeenLastCalledWith("30d", undefined);
    expect(api.sessions.list).toHaveBeenCalledTimes(4);
  });

  it("keeps the board usable when period insights fail and retries the current period", async () => {
    const user = userEvent.setup();
    render(<Muro />);
    await screen.findByRole("region", { name: "Cifras del periodo" });
    vi.mocked(api.muro.summary).mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "7 días" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo cargar el resumen de trabajo."
    );
    expect(screen.getByRole("region", { name: "Tablero de sesiones" })).toBeVisible();
    vi.mocked(api.muro.summary).mockResolvedValue({ ...emptySummary, period: "7d" });
    await user.click(screen.getByRole("button", { name: i18n.t("common:retry") }));
    expect(await screen.findByText("Tareas completadas por día")).toBeVisible();
    expect(api.muro.summary).toHaveBeenLastCalledWith("7d", undefined);
  });

  it.each(["en", "es", "zh", "vi", "ko"])("renders stage translations in %s", async (language) => {
    await i18n.changeLanguage(language);
    render(<Muro />);
    await waitFor(() => expect(screen.getAllByText(i18n.t("muro:stage.waiting"))).toHaveLength(2));
    expect(i18n.getResource(language, "nav", "muro")).toBe("Muro");
    expect(screen.getByRole("button", { name: i18n.t("muro:period.today") })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
