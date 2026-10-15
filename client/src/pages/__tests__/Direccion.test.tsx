/**
 * @file Direccion.test.tsx
 * @description Tests Dirección rendering with live data, OK answers, orders, indications, stopping, WS updates and the pitch duel.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Direccion } from "../Direccion";
import { api } from "../../lib/api";
import { eventBus } from "../../lib/eventBus";
import type { ConductorOrder, ConductorPitch, ConductorProject } from "../../lib/types";
import i18n from "../../i18n";

vi.mock("../../lib/api", () => ({
  api: {
    run: { models: vi.fn() },
    conductor: {
      projects: vi.fn(),
      createProject: vi.fn(),
      browse: vi.fn(),
      orders: vi.fn(),
      order: vi.fn(),
      getOrder: vi.fn(),
      indication: vi.fn(),
      approve: vi.fn(),
      stopOrder: vi.fn(),
      pitch: vi.fn(),
      pitches: vi.fn(),
      getPitch: vi.fn(),
      stopPitch: vi.fn(),
      orderPitch: vi.fn(),
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
  conductor.pitches.mockResolvedValue({ items: [] });
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

it("picks the project folder from the folder popup and can create a new one there", async () => {
  conductor.projects.mockResolvedValue({ items: [] });
  conductor.orders.mockResolvedValue({ items: [] });
  const listing = (path: string, dirs: string[]) => ({
    path,
    parent: path === "C:\\" ? null : "C:\\",
    sep: "\\",
    dirs: dirs.map((name) => ({ name, path: `${path}\\${name}`.replace("\\\\", "\\") })),
    truncated: false,
    roots: [{ name: "C:\\", path: "C:\\" }],
    places: [{ name: "Martin", path: "C:\\Users\\Martin" }],
  });
  conductor.browse.mockImplementation(async (path?: string) =>
    path === "C:\\Users\\Martin\\Documents"
      ? listing(path, ["Card_Game"])
      : listing("C:\\Users\\Martin", ["Documents"])
  );
  renderPage();
  fireEvent.click(await screen.findByText("Examinar"));
  fireEvent.click(await screen.findByText("Documents"));
  expect(await screen.findByText("Card_Game")).toBeTruthy();
  fireEvent.click(screen.getByText("¡USAR ESTA!"));
  const folder = screen.getByPlaceholderText(
    "C:\\ruta\\absoluta\\del\\proyecto"
  ) as HTMLInputElement;
  expect(folder.value).toBe("C:\\Users\\Martin\\Documents");
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByText("Examinar"));
  await screen.findByText("Card_Game");
  fireEvent.change(screen.getByPlaceholderText("mi-proyecto"), { target: { value: "Nuevo" } });
  fireEvent.click(screen.getByText("Crear aquí"));
  expect(folder.value).toBe("C:\\Users\\Martin\\Documents\\Nuevo");
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

const readyPitch: ConductorPitch = {
  id: "pt1",
  project_id: "p1",
  idea: "Un marcador de cartas",
  depth: "normal",
  status: "ready",
  order_id: null,
  created_at: "2026-10-15T10:00:00.000Z",
  ended_at: "2026-10-15T10:05:00.000Z",
  claude: {
    status: "ready",
    runId: "c1",
    error: null,
    pitch: {
      name: "La Taberna",
      tagline: "Con alma de juego de mesa",
      cards: [
        { kind: "estilo", title: "Pergamino", body: "Cálido", swatches: ["#F4E3C1"] },
        { kind: "toque", title: "Títulos", body: "Rey de la mesa" },
      ],
    },
  },
  codex: {
    status: "ready",
    runId: "x1",
    error: null,
    pitch: {
      name: "Arcade Score",
      tagline: null,
      cards: [
        {
          kind: "pantallas",
          title: "Recreativa",
          screens: [{ label: "Partida", html: "<b>07</b>" }],
        },
      ],
    },
  },
};

it("asks both agents to pitch the idea with the chosen depth", async () => {
  conductor.orders.mockResolvedValue({ items: [] });
  conductor.pitch.mockResolvedValue({
    ...readyPitch,
    status: "drafting",
    claude: { ...readyPitch.claude, status: "drafting", pitch: null },
    codex: { ...readyPitch.codex, status: "drafting", pitch: null },
  });
  renderPage();
  expect(await screen.findByText("Da tu primera orden.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Tu orden"), { target: { value: "Un marcador" } });
  fireEvent.click(screen.getByText("A tope"));
  fireEvent.click(screen.getByText("¡QUE PROPONGAN!"));
  await waitFor(() => expect(conductor.pitch).toHaveBeenCalledWith("p1", "Un marcador", "deep"));
  expect(await screen.findByText("Claude y Codex están preparando su propuesta…")).toBeTruthy();
});

it("shows both pitches, keeps cards from each and orders the mix", async () => {
  conductor.orders.mockResolvedValue({ items: [] });
  conductor.pitches.mockResolvedValue({ items: [readyPitch] });
  conductor.orderPitch.mockResolvedValue({ ...order, id: "o3", approvals: [], rounds: [] });
  const { container } = renderPage();
  expect(await screen.findByText("La Taberna")).toBeTruthy();
  expect(screen.getByText("Arcade Score")).toBeTruthy();
  const frame = container.querySelector(".duel-shot iframe") as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
  const tray = container.querySelector(".duel-tray") as HTMLFormElement;
  const orderButton = tray.querySelector("button.dir-cta") as HTMLButtonElement;
  expect(orderButton.disabled).toBe(true);
  const keeps = screen.getAllByText("＋ Me lo quedo");
  fireEvent.click(keeps[0]!);
  fireEvent.click(keeps[2]!);
  expect(screen.getAllByText("★ ¡Me lo quedo!")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("¿Algo más que quieras añadir?"), {
    target: { value: "En la tele" },
  });
  fireEvent.click(orderButton);
  await waitFor(() =>
    expect(conductor.orderPitch).toHaveBeenCalledWith(
      "pt1",
      [
        { agent: "claude", index: 0 },
        { agent: "codex", index: 0 },
      ],
      "En la tele"
    )
  );
  await waitFor(() => expect(container.querySelector(".duel")).toBeNull());
});
