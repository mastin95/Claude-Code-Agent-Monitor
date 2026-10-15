/**
 * @file Direccion.test.tsx
 * @description Tests the Dirección whiteboard: folder bar, Enter to start, live board updates,
 *   comments on a board being drawn, calls from a finished board, the timeline and the folder picker.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Direccion } from "../Direccion";
import { api } from "../../lib/api";
import { eventBus } from "../../lib/eventBus";
import type { ConductorProject, ConductorSheet } from "../../lib/types";
import i18n from "../../i18n";

vi.mock("../../lib/api", () => ({
  api: {
    conductor: {
      projects: vi.fn(),
      createProject: vi.fn(),
      browse: vi.fn(),
      sheet: vi.fn(),
      sheets: vi.fn(),
      stopSheet: vi.fn(),
      commentBoard: vi.fn(),
    },
  },
}));

const project: ConductorProject = {
  id: "p1",
  cwd: "C:\\proyectos\\demo",
  name: "Demo",
  lead: "claude",
  claude_model: null,
  claude_effort: null,
  codex_model: null,
  codex_effort: null,
  codex_sandbox: "workspace-write",
  created_at: "2026-10-15T09:00:00Z",
};

const done: ConductorSheet = {
  id: "s1",
  project_id: "p1",
  n: 1,
  prompt: "Un juego de cartas",
  agents: ["claude", "codex"],
  status: "done",
  source_board_id: null,
  source_element_id: null,
  created_at: "2026-10-15T10:00:00Z",
  ended_at: "2026-10-15T10:10:00Z",
  boards: [
    {
      id: "b1",
      agent: "claude",
      status: "ready",
      runId: "r1",
      error: null,
      comments: [],
      created_at: "2026-10-15T10:00:00Z",
      ended_at: "2026-10-15T10:05:00Z",
      elements: [
        { id: "t", kind: "title", title: "Card Clash", text: "Partidas de 3 minutos" },
        { id: "obj", kind: "text", title: "Objetivo", text: "Ganar 3 rondas" },
        {
          id: "h",
          kind: "chart",
          title: "Horas",
          chart: { type: "bar", labels: ["F1", "F2"], values: [3, 5] },
        },
        { id: "a", kind: "arrow", from: "obj", to: "h" },
      ],
    },
    {
      id: "b2",
      agent: "codex",
      status: "ready",
      runId: "r2",
      error: null,
      comments: [],
      created_at: "2026-10-15T10:05:00Z",
      ended_at: "2026-10-15T10:10:00Z",
      elements: [{ id: "base", kind: "list", title: "Base", items: ["React", "Vite"] }],
    },
  ],
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
  conductor.projects.mockResolvedValue({ items: [project] });
  conductor.sheets.mockResolvedValue({ items: [done] });
  conductor.sheet.mockResolvedValue({ ...done, id: "s2", n: 2, status: "drafting" });
  conductor.commentBoard.mockResolvedValue(done);
  conductor.stopSheet.mockResolvedValue(done);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the project folder, the latest board and the timeline", async () => {
  renderPage();
  expect(await screen.findByText("C:\\proyectos\\demo")).toBeTruthy();
  expect(await screen.findByText("Base")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Pizarra de Claude/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /Pizarra de Claude/ }));
  expect(screen.getByText("Card Clash")).toBeTruthy();
  expect(screen.getByText("Ganar 3 rondas")).toBeTruthy();
  expect(screen.getByText(/· Un juego de cartas/)).toBeTruthy();
});

it("starts Claude and Codex when Enter is pressed in the description", async () => {
  renderPage();
  const box = await screen.findByLabelText("Describe el proyecto");
  await screen.findByText("Base");
  fireEvent.change(box, { target: { value: "Una web de recetas" } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() =>
    expect(conductor.sheet).toHaveBeenCalledWith({ projectId: "p1", prompt: "Una web de recetas" })
  );
});

it("follows a board while it is drawn and sends live corrections", async () => {
  const drawing: ConductorSheet = {
    ...done,
    id: "s3",
    n: 2,
    status: "drafting",
    boards: [
      { ...done.boards[0]!, id: "b3", status: "drafting", elements: [] },
      { ...done.boards[1]!, id: "b4", status: "waiting", elements: [] },
    ],
  };
  renderPage();
  await screen.findByText("Base");
  act(() => {
    eventBus.publish({ type: "conductor_sheet", data: drawing, timestamp: "" });
  });
  expect(await screen.findByText("Leyendo tu descripción…")).toBeTruthy();
  expect((screen.getByLabelText("Describe el proyecto") as HTMLTextAreaElement).disabled).toBe(
    true
  );
  act(() => {
    eventBus.publish({
      type: "conductor_sheet",
      data: {
        ...drawing,
        boards: [
          {
            ...drawing.boards[0]!,
            elements: [{ id: "obj", kind: "text", title: "Objetivo", text: "Ganar" }],
          },
          drawing.boards[1]!,
        ],
      },
      timestamp: "",
    });
  });
  expect(await screen.findByText("Dibujando: Objetivo")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Objetivo" }));
  fireEvent.change(screen.getByPlaceholderText("Escribe una corrección…"), {
    target: { value: "Mejor 5 rondas" },
  });
  fireEvent.click(screen.getByText("Enviar a Claude"));
  await waitFor(() =>
    expect(conductor.commentBoard).toHaveBeenCalledWith("b3", "Mejor 5 rondas", "obj")
  );
  fireEvent.click(screen.getByText("Parar"));
  await waitFor(() => expect(conductor.stopSheet).toHaveBeenCalledWith("s3"));
});

it("calls Codex about an element of a finished board", async () => {
  renderPage();
  await screen.findByText("Base");
  fireEvent.click(screen.getByRole("tab", { name: /Pizarra de Claude/ }));
  fireEvent.click(screen.getByRole("button", { name: "Objetivo" }));
  fireEvent.change(screen.getByPlaceholderText("¿Qué quieres que hagan con esto?"), {
    target: { value: "Tres variantes" },
  });
  fireEvent.click(screen.getByText("Pedir a Codex"));
  await waitFor(() =>
    expect(conductor.sheet).toHaveBeenCalledWith({
      projectId: "p1",
      prompt: "Tres variantes",
      agent: "codex",
      sourceBoardId: "b1",
      sourceElementId: "obj",
    })
  );
});

it("picks a folder for the first project and starts there", async () => {
  conductor.projects.mockResolvedValue({ items: [] });
  conductor.browse.mockResolvedValue({
    path: "C:\\Users\\Martin",
    parent: "C:\\Users",
    sep: "\\",
    dirs: [{ name: "Documents", path: "C:\\Users\\Martin\\Documents" }],
    truncated: false,
    roots: [{ name: "C:\\", path: "C:\\" }],
    places: [{ name: "Martin", path: "C:\\Users\\Martin" }],
  });
  conductor.createProject.mockResolvedValue({
    ...project,
    id: "p2",
    cwd: "C:\\Users\\Martin\\Nuevo",
  });
  renderPage();
  expect(await screen.findByText("Elige dónde se guardará el proyecto")).toBeTruthy();
  fireEvent.click(screen.getByText("Elegir carpeta…"));
  fireEvent.change(await screen.findByPlaceholderText("mi-proyecto"), {
    target: { value: "Nuevo" },
  });
  fireEvent.click(screen.getByText("Crear aquí"));
  await waitFor(() =>
    expect(conductor.createProject).toHaveBeenCalledWith({
      cwd: "C:\\Users\\Martin\\Nuevo",
      create: true,
      lead: "claude",
    })
  );
  expect(await screen.findByText("C:\\Users\\Martin\\Nuevo")).toBeTruthy();
});
