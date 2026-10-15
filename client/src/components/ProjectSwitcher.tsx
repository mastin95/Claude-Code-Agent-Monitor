/**
 * @file ProjectSwitcher.tsx
 * @description Sidebar badge naming the open project. Clicking it lists every project (the open
 * one starred) plus "New project"; picking one switches every page to it. Before any project
 * exists it reads "No project open". Hidden when the server is not in project-only mode.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useProjects } from "./ProjectProvider";
import "./projects.css";

export function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation("nav");
  const navigate = useNavigate();
  const { projects, projectOnly, active, setActive } = useProjects();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!projectOnly || !projects) return null;
  if (!projects.length) {
    return collapsed ? null : (
      <div className="proj-switch">
        <div className="proj-switch-none">{t("project.none")}</div>
      </div>
    );
  }

  const toggle = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.min(rect.right + 8, window.innerWidth - 392);
      setPos({ top: Math.max(12, rect.top), left: Math.max(12, left) });
    }
    setOpen((value) => !value);
  };
  const pick = (id: string) => {
    setActive(id);
    setOpen(false);
  };
  const name = active?.name || t("project.pick");

  return (
    <div className="proj-switch">
      <button
        ref={button}
        type="button"
        className={`proj-switch-btn${collapsed ? " is-rail" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={collapsed ? `${t("project.label")}: ${name}` : active?.cwd}
        onClick={toggle}
      >
        {collapsed ? (
          <span aria-hidden>📁</span>
        ) : (
          <>
            <small>{t("project.label")}</small>
            <strong>
              <span>{name}</span>
              <span aria-hidden>{open ? "▴" : "▾"}</span>
            </strong>
          </>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="proj-menu"
            role="dialog"
            aria-label={t("project.list")}
            style={{ top: pos.top, left: pos.left }}
          >
            <h2>{t("project.list")}</h2>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className="proj-menu-item"
                aria-current={project.id === active?.id}
                onClick={() => pick(project.id)}
              >
                <strong>
                  {project.id === active?.id
                    ? `★ ${project.name} · ${t("project.open")}`
                    : project.name}
                </strong>
                <small>{project.cwd}</small>
              </button>
            ))}
            <button
              type="button"
              className="proj-menu-new"
              onClick={() => {
                setOpen(false);
                navigate("/direccion", { state: { newProject: true } });
              }}
            >
              {t("project.new")}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
