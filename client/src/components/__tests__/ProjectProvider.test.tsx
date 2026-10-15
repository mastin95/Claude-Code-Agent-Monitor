/**
 * @file ProjectProvider.test.tsx
 * @description Tests the project-only Monitor: empty first-run welcome, reopening the last
 * project, switching projects from the sidebar badge, and the upstream fallback.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectGate, ProjectProvider } from "../ProjectProvider";
import { ProjectSwitcher } from "../ProjectSwitcher";
import { api } from "../../lib/api";
import {
  ACTIVE_PROJECT_KEY,
  activeProjectParam,
  getActiveProjectId,
  setActiveProjectId,
} from "../../lib/activeProject";
import type { ConductorProject } from "../../lib/types";
import i18n from "../../i18n";

vi.mock("../../lib/api", () => ({ api: { conductor: { projects: vi.fn() } } }));

const make = (id: string, name: string): ConductorProject => ({
  id,
  cwd: `C:\\proyectos\\${name}`,
  name,
  lead: "claude",
  claude_model: null,
  claude_effort: null,
  codex_model: null,
  codex_effort: null,
  codex_sandbox: "workspace-write",
  created_at: "2026-10-15T09:00:00Z",
});

/** Reads the scope at render time, so a remount after a switch shows the new project. */
function Page() {
  return <p>page of {String(activeProjectParam())}</p>;
}

function mount() {
  return render(
    <MemoryRouter>
      <ProjectProvider>
        <ProjectSwitcher collapsed={false} />
        <Routes>
          <Route element={<ProjectGate />}>
            <Route index element={<Page />} />
          </Route>
          <Route path="direccion" element={<p>direccion page</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  setActiveProjectId(null);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("starts empty: welcome screen, no project badge, and New project opens Dirección", async () => {
  vi.mocked(api.conductor.projects).mockResolvedValue({ items: [], project_only: true });
  mount();
  expect(await screen.findByText("START YOUR FIRST PROJECT")).toBeTruthy();
  expect(screen.getByText("No project open")).toBeTruthy();
  expect(screen.queryByText(/page of/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "＋ New project" }));
  expect(await screen.findByText("direccion page")).toBeTruthy();
});

it("reopens the stored project, scopes requests to it and switches from the badge", async () => {
  setActiveProjectId("p2");
  vi.mocked(api.conductor.projects).mockResolvedValue({
    items: [make("p1", "Card_Game"), make("p2", "Pokemon")],
    project_only: true,
  });
  mount();
  expect(await screen.findByText("page of p2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Pokemon/ }));
  const list = screen.getByRole("dialog", { name: "Your projects" });
  expect(list.textContent).toContain("★ Pokemon · open");
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /Card_Game/ }));
  });
  await waitFor(() => expect(screen.getByText("page of p1")).toBeTruthy());
  expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe("p1");
});

it("falls back to the newest project when the stored one is gone", async () => {
  setActiveProjectId("deleted");
  vi.mocked(api.conductor.projects).mockResolvedValue({
    items: [make("p1", "Card_Game")],
    project_only: true,
  });
  mount();
  expect(await screen.findByText("page of p1")).toBeTruthy();
  expect(getActiveProjectId()).toBe("p1");
});

it("keeps the upstream unscoped Monitor when the server is not project-only", async () => {
  vi.mocked(api.conductor.projects).mockResolvedValue({ items: [], project_only: false });
  mount();
  expect(await screen.findByText("page of null")).toBeTruthy();
  expect(screen.queryByText("No project open")).toBeNull();
});
