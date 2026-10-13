/**
 * @file Muro.test.tsx
 * @description Tests Muro period selection, live connection changes, localized
 * content states, and the browser tab title before data integration.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { Muro } from "../Muro";
import { DocumentTitle } from "../../components/DocumentTitle";
import { eventBus } from "../../lib/eventBus";
import i18n from "../../i18n";

describe("Muro", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("es");
    eventBus.setConnected(true);
  });

  it("opens empty with today's period and updates the tab title", () => {
    render(
      <MemoryRouter initialEntries={["/muro"]}>
        <DocumentTitle />
        <Muro />
      </MemoryRouter>
    );

    expect(document.title).toBe("Muro · Claude Code Agent Monitor");
    expect(screen.getByRole("heading", { name: "Muro", level: 1 })).toBeVisible();
    expect(screen.getByRole("button", { name: "Hoy" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Aún no hay nada en el Muro")).toBeVisible();
  });

  it("selects exactly one period locally and resets on a new visit", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Muro />);

    for (const period of ["7 días", "30 días", "Hoy"]) {
      await user.click(screen.getByRole("button", { name: period }));
      expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(1);
      expect(screen.getByRole("button", { name: period })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Aún no hay nada en el Muro")).toBeVisible();
    }

    await user.click(screen.getByRole("button", { name: "30 días" }));
    unmount();
    render(<Muro />);
    expect(screen.getByRole("button", { name: "Hoy" })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows WebSocket disconnect and reconnect without losing the period", async () => {
    const user = userEvent.setup();
    render(<Muro />);
    await user.click(screen.getByRole("button", { name: "7 días" }));
    expect(screen.getByRole("status")).toHaveTextContent("En vivo");

    act(() => eventBus.setConnected(false));
    expect(screen.getByRole("status")).toHaveTextContent("Sin conexión");
    act(() => eventBus.setConnected(true));
    expect(screen.getByRole("status")).toHaveTextContent("En vivo");
    expect(screen.getByRole("button", { name: "7 días" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the header visible through loading, error, and empty states", () => {
    const { rerender } = render(<Muro status="loading" />);
    expect(screen.getByRole("status", { name: "Cargando el Muro…" })).toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(screen.queryByText("Aún no hay nada en el Muro")).not.toBeInTheDocument();

    rerender(<Muro status="error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudo cargar el Muro.");
    expect(screen.queryByRole("status", { name: "Cargando el Muro…" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Muro", level: 1 })).toBeVisible();
    expect(screen.getByRole("group", { name: "Periodo" })).toBeVisible();

    rerender(<Muro status="empty" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Aún no hay nada en el Muro")).toBeVisible();
  });

  it.each(["en", "es", "zh", "vi", "ko"])("registers Muro translations in %s", async (language) => {
    await i18n.changeLanguage(language);
    render(<Muro />);
    expect(i18n.getResource(language, "nav", "muro")).toBe("Muro");
    expect(i18n.getResource(language, "muro", "title")).toBe("Muro");
    expect(
      screen.getByRole("button", { name: i18n.getResource(language, "muro", "period.today") })
    ).toHaveAttribute("aria-pressed", "true");
  });
});
