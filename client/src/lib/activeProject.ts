/**
 * @file activeProject.ts
 * @description The Dirección project the whole Monitor is looking at. Stored in localStorage
 * (the same key Dirección always used) so reopening the Monitor lands on the project it was
 * closed with; `api.ts` adds it to every scoped request as `?project=<id>`.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useSyncExternalStore } from "react";

/** localStorage key; shared with Dirección's earlier per-page memory. */
export const ACTIVE_PROJECT_KEY = "direccion.project";

function read(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

let current: string | null = read();
/** Whether the server keeps only project work (`project_only`); scoping is off until it says so. */
let scoping = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** The active project id, or null before one exists. */
export function getActiveProjectId(): string | null {
  return current;
}

/** Switch the whole Monitor to another project (null clears it). */
export function setActiveProjectId(id: string | null): void {
  if (id === current) return;
  current = id;
  try {
    if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    else localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    /* Private windows may refuse storage; the in-memory choice still works. */
  }
  emit();
}

/** Turn request scoping on once the server reports project-only mode. */
export function setProjectScoping(on: boolean): void {
  scoping = on;
}

/** The `project` query value for scoped requests, or null when scoping is off. */
export function activeProjectParam(): string | null {
  return scoping ? current : null;
}

export function subscribeActiveProject(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding for the active project id. */
export function useActiveProjectId(): string | null {
  return useSyncExternalStore(subscribeActiveProject, getActiveProjectId, getActiveProjectId);
}

/** Ask every listener (the sidebar's project list) to reload, e.g. after creating one. */
const changeListeners = new Set<() => void>();
export function notifyProjectsChanged(): void {
  changeListeners.forEach((listener) => listener());
}
export function onProjectsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
