/**
 * @file Welcome.tsx
 * @description First-run screen of the project-only Monitor: nothing exists yet, so every page
 * shows this manga card with Claude and Codex and one big "New project" button that opens
 * Dirección's new-project form.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Mascot } from "./muro/Mascot";
import "@fontsource/bangers/400.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "./muro/mascot.css";
import "./projects.css";

export function Welcome() {
  const { t } = useTranslation("nav");
  const navigate = useNavigate();
  return (
    <section className="proj-welcome" aria-labelledby="proj-welcome-title">
      <div className="proj-welcome-card">
        <span className="proj-welcome-hello">{t("welcome.hello")}</span>
        <div className="proj-welcome-cast">
          <Mascot agent="claude" mode="wait" size={96} reducedMotion />
          <p className="proj-welcome-bubble">{t("welcome.bubble")}</p>
          <Mascot agent="codex" mode="wait" size={96} reducedMotion />
        </div>
        <h1 id="proj-welcome-title" className="proj-welcome-title">
          {t("welcome.title")}
        </h1>
        <p className="proj-welcome-body">{t("welcome.body")}</p>
        <button
          type="button"
          className="proj-welcome-cta"
          onClick={() => navigate("/direccion", { state: { newProject: true } })}
        >
          {t("project.new")}
        </button>
      </div>
    </section>
  );
}
