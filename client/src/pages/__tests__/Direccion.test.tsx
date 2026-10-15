/**
 * @file Direccion.test.tsx
 * @description Tests Dirección rendering with live data, OK answers, orders, indications, stopping and WS updates.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Direccion } from "../Direccion";
import { api } from "../../lib/api";
import { eventBus } from "../../lib/eventBus";
import type { ConductorOrder, ConductorProject } from "../../lib/types";
import i18n from "../../i18n";

vi.mock("../../lib/api", () => ({
  api: {
    run: { models: vi.fn() },
    conductor: {
      projects: vi.fn(),
      createProject: vi.fn(),
      orders: vi.fn(),
      order: vi.fn(),
      getOrder: vi.fn(),
      indication: vi.fn(),
      approve: vi.fn(),
      stopOrder: vi.fn(),
    },
  },
}));

const project: ConductorProject = {
  id: "p1",
  cwd: "C:\\proyectos\\demo",
  name: "Demo",
  lead: "claude",
  claude_model: "opus",
  claude_effort: "high",
  codex_model: "gpt-6-astra",
  codex_effort: "medium",
  codex_sandbox: "workspace-write",
  created_at: "2026-10-15T09:00:00Z",
};

const order: ConductorOrder = {
  id: "o1",
  project_id: "p1",
  text: "Crea un README con el título",
  status: "waiting_ok",
  lead_run_id: "run-claude",
  created_at: "2026-10-15T10:00:00Z",
  ended_at: null,
  plan: "1 README · 2 revisión",
  result: null,
  rounds: [
    {
      id: "r1",
      order_id: "o1",
      n: 1,
      from: "claude",
      to: "codex",
      ask: "Escribe el README",
      ask_at: "2026-10-15T10:01:00Z",
      reply: null,
      reply_at: null,
      run_id: "run-codex",
      status: "pending",
    },
  ],
  approvals: [
    {
      id: "a1",
      order_id: "o1",
      agent: "codex",
      kind: "permission",
      summary: "Comando: npm install",
      detail: null,
      options: null,
      status: "pending",
      created_at: "2026-10-15T10:02:00Z",
      answered_at: null,
      answer: null,
      note: null,
    },
  ],
  runs: {},
  agents: {},
};

const conductor = vi.mocked(api.conductor);

function renderPage() {
  return render(
    <MemoryRouter>
      <Direccion />
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage is optional */
  }
  vi.mocked(api.run.models).mockResolvedValue({
    provider: "claude",
    dynamic: false,
    source: "test",
    items: [],
  });
  conductor.projects.mockResolvedValue({ items: [project] });
  conductor.orders.mockResolvedValue({ items: [order] });
  conductor.getOrder.mockResolvedValue(order);
  conductor.approve.mockResolvedValue({ ...order.approvals[0]!, status: "answered" });
  conductor.indication.mockResolvedValue({ queued: true });
  conductor.stopOrder.mockResolvedValue({ ...order, status: "stopped" });
  conductor.order.mockResolvedValue({ ...order, id: "o2", approvals: [], rounds: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the stage, the hand-off in flight, the OK card and the score", async () => {
  renderPage();
  expect(await screen.findByText("Escribe el README", { selector: ".dir-encargo p" })).toBeTruthy();
  expect(screen.getByText("Comando: npm install", { selector: ".dir-ok-summary" })).toBeTruthy();
  expect(screen.getByText("Crea un README con el título")).toBeTruthy();
  expect(screen.getByText("1 README · 2 revisión")).toBeTruthy();
  expect(screen.getByText("1 OK pendiente")).toBeTruthy();
  expect(screen.getByText("Esperando tu OK", { selector: ".dir-status" })).toBeTruthy();
  expect(screen.getByText("gpt-6-astra")).toBeTruthy();
  // A live order locks the order box and opens the indication bar.
  expect((screen.getByLabelText("Tu orden") as HTMLTextAreaElement).disabled).toBe(true);
  expect(screen.getByPlaceholderText("Nueva indicación para el jefe…")).toBeTruthy();
});

it("answers OK cards, including a change with a note", async () => {
  renderPage();
  fireEvent.click(await screen.findByText("✅ Aprobar"));
  await waitFor(() => expect(conductor.approve).toHaveBeenCalledWith("a1", "approve", undefined));
  fireEvent.click(screen.getByText("✏️ Cambiar"));
  fireEvent.change(screen.getByPlaceholderText("¿Qué cambio quieres?"), {
    target: { value: "Usa yarn" },
  });
  fireEvent.click(screen.getByText("Enviar", { selector: ".dir-ok-note button" }));
  await waitFor(() => expect(conductor.approve).toHaveBeenCalledWith("a1", "change", "Usa yarn"));
});

it("sends indications and stops the order after an in-page confirmation", async () => {
  renderPage();
  const input = await screen.findByPlaceholderText("Nueva indicación para el jefe…");
  fireEvent.change(input, { target: { value: "Hazlo corto" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(conductor.indication).toHaveBeenCalledWith("o1", "Hazlo corto"));
  expect(await screen.findByText("En cola: llegará al terminar el turno.")).toBeTruthy();
  fireEvent.click(screen.getByText("Parar orden"));
  expect(conductor.stopOrder).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Sí, parar"));
  await waitFor(() => expect(conductor.stopOrder).toHaveBeenCalledWith("o1"));
});

it("gives a new order when nothing is running", async () => {
  conductor.orders.mockResolvedValue({ items: [] });
  renderPage();
  expect(await screen.findByText("Da tu primera orden.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Tu orden"), { target: { value: "Haz un README" } });
  fireEvent.click(screen.getByText("¡A ESCENA!"));
  await waitFor(() => expect(conductor.order).toHaveBeenCalledWith("p1", "Haz un README"));
});

it("merges live agent state and refetches on conductor events", async () => {
  renderPage();
  await screen.findByText("Comando: npm install", { selector: ".dir-ok-summary" });
  act(() => {
    eventBus.publish({
      type: "conductor_agent",
      timestamp: "2026-10-15T10:03:00Z",
      data: {
        orderId: "o1",
        agent: "codex",
        runId: "run-codex",
        sessionId: "s-codex",
        doing: "commandExecution",
        model: "gpt-6-astra",
        effort: "medium",
        tokens: { total: { totalTokens: 38000 } },
      },
    });
  });
  expect(await screen.findByText("Ejecutando un comando")).toBeTruthy();
  expect(screen.getByText("38k tokens")).toBeTruthy();
  const calls = conductor.getOrder.mock.calls.length;
  act(() => {
    eventBus.publish({
      type: "conductor_round",
      timestamp: "2026-10-15T10:04:00Z",
      data: { ...order.rounds[0]!, status: "done", reply: "Hecho" },
    });
  });
  await waitFor(() => expect(conductor.getOrder.mock.calls.length).toBeGreaterThan(calls));
});

it("opens the new-project form when there are no projects", async () => {
  conductor.projects.mockResolvedValue({ items: [] });
  conductor.createProject.mockResolvedValue(project);
  conductor.orders.mockResolvedValue({ items: [] });
  renderPage();
  const folder = await screen.findByPlaceholderText("C:\\ruta\\absoluta\\del\\proyecto");
  fireEvent.change(folder, { target: { value: "C:\\proyectos\\demo" } });
  fireEvent.click(screen.getByText("¡CREAR!"));
  await waitFor(() =>
    expect(conductor.createProject).toHaveBeenCalledWith({
      cwd: "C:\\proyectos\\demo",
      create: true,
      lead: "claude",
      models: { claude: {}, codex: {} },
    })
  );
});

it("shows OK card details and keeps the indication bar while a finished lead still listens", async () => {
  conductor.getOrder.mockResolvedValue({
    ...order,
    status: "done",
    approvals: [{ ...order.approvals[0]!, detail: '{"command":"npm install"}' }],
    rounds: [],
    runs: { claude: { id: "run-claude", status: "running" } },
  });
  renderPage();
  expect(await screen.findByText("Ver detalle")).toBeTruthy();
  expect(screen.getByText(/"command": "npm install"/)).toBeTruthy();
  expect(screen.getByPlaceholderText("Nueva indicación para el jefe…")).toBeTruthy();
  // The finished order no longer locks the order box.
  expect((screen.getByLabelText("Tu orden") as HTMLTextAreaElement).disabled).toBe(false);
});
