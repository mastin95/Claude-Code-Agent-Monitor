/**
 * @file ProjectProvider.tsx
 * @description Loads the Dirección projects once for the whole app and keeps the active one
 * valid: the last project reopens, a removed one falls back to the newest. `ProjectGate` shows
 * the empty first-run welcome until a project exists and remounts every page when Martin
 * switches project, so each page reloads with the new `?project=` scope.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { api } from "../lib/api";
import type { ConductorProject } from "../lib/types";
import {
  getActiveProjectId,
  onProjectsChanged,
  setActiveProjectId,
  setProjectScoping,
  useActiveProjectId,
} from "../lib/activeProject";
import { Welcome } from "./Welcome";

export interface ProjectsState {
  /** Every project, newest first; null while loading or when the server is unreachable. */
  projects: ConductorProject[] | null;
  /** The server keeps only project work: start empty and scope pages. */
  projectOnly: boolean;
  /** True once the first load settled (successfully or not). */
  ready: boolean;
  activeId: string | null;
  active: ConductorProject | null;
  setActive: (id: string) => void;
  reload: () => void;
}

const FALLBACK: ProjectsState = {
  projects: null,
  projectOnly: false,
  ready: true,
  activeId: null,
  active: null,
  setActive: setActiveProjectId,
  reload: () => {},
};

const ProjectsContext = createContext<ProjectsState>(FALLBACK);

/** Projects and the active one. Outside a provider (isolated tests) scoping stays off. */
export function useProjects(): ProjectsState {
  return useContext(ProjectsContext);
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const activeId = useActiveProjectId();
  const [projects, setProjects] = useState<ConductorProject[] | null>(null);
  const [projectOnly, setProjectOnly] = useState(false);
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => onProjectsChanged(reload), [reload]);
  useEffect(() => {
    let disposed = false;
    api.conductor
      .projects()
      .then(({ items, project_only }) => {
        if (disposed) return;
        const only = project_only === true;
        setProjectScoping(only);
        setProjectOnly(only);
        setProjects(items);
        const stored = getActiveProjectId();
        if (!items.some((p) => p.id === stored)) setActiveProjectId(items[0]?.id ?? null);
      })
      .catch(() => {
        // Unreachable server: keep the upstream, unscoped behaviour rather than a blank app.
        if (!disposed) setProjects(null);
      })
      .finally(() => {
        if (!disposed) setReady(true);
      });
    return () => {
      disposed = true;
    };
  }, [tick]);

  const value = useMemo<ProjectsState>(
    () => ({
      projects,
      projectOnly,
      ready,
      activeId,
      active: projects?.find((p) => p.id === activeId) || null,
      setActive: setActiveProjectId,
      reload,
    }),
    [projects, projectOnly, ready, activeId, reload]
  );
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

/** Route wrapper for every page that shows session data. */
export function ProjectGate() {
  const { projects, projectOnly, ready, activeId } = useProjects();
  if (!ready) return null;
  if (projectOnly && projects && !projects.length) return <Welcome />;
  return <Outlet key={projectOnly ? activeId || "none" : "all"} />;
}
