/**
 * @file Conductor handoffs and human approvals with bounded HTTP long polling.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { z } from "zod";
import { registrarFor } from "../../core/tool-registry.js";
import { ToolText } from "../../core/tool-result.js";
import { assertMutationsEnabled } from "../../policy/tool-guards.js";
import type { ToolContext } from "../../types/tool-context.js";

type PollResult = { status: string; reply?: string; answer?: string; note?: string };
const timeoutMessage = "Se agotó el tiempo de espera de Dirección.";
const short = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 400);

/** Register mutation-gated tools; permission responses always fail closed. */
export function registerConductorTools(context: ToolContext): void {
  const { api, config } = context;
  const register = registrarFor(context);
  const orderSchema = z.string().trim().min(1).max(256).optional();
  const orderId = (args: Record<string, unknown>) => {
    const id = args.order_id || process.env.CONDUCTOR_ORDER_ID;
    if (!id) throw new Error("Falta order_id o CONDUCTOR_ORDER_ID.");
    return id;
  };
  const deadline = () => {
    const duration = Number(process.env.CONDUCTOR_HANDOFF_TIMEOUT_MS ?? 1_800_000);
    if (!Number.isSafeInteger(duration) || duration <= 0) {
      throw new Error("CONDUCTOR_HANDOFF_TIMEOUT_MS debe ser un entero positivo.");
    }
    return Date.now() + duration;
  };
  const requestOptions = (end: number) => {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error(timeoutMessage);
    return { timeoutMs: Math.min(120_000, config.requestTimeoutMs, remaining), idempotent: false };
  };
  async function poll(resource: string, id: string, end: number): Promise<PollResult> {
    if (!id) throw new Error("Dirección no devolvió un identificador.");
    while (true) {
      const options = requestOptions(end);
      const result = await api.get<PollResult>(
        `/api/conductor/${resource}/${encodeURIComponent(id)}`,
        {
          ...options,
          query: { waitMs: Math.max(0, Math.min(100_000, options.timeoutMs - 250)) },
        }
      );
      if (Date.now() >= end) throw new Error(timeoutMessage);
      if (result.status !== "pending") return result;
    }
  }
  async function approval(body: Record<string, unknown>): Promise<PollResult> {
    const end = deadline();
    const created = await api.post<{ approvalId: string }>("/api/conductor/approvals", {
      ...requestOptions(end),
      body,
    });
    return poll("approvals", created.approvalId, end);
  }
  register(
    "dashboard_handoff",
    "Delegate work and wait for the collaborator's reply.",
    {
      to: z.enum(["codex", "claude"]),
      ask: z.string().trim().min(1).max(50_000),
      order_id: orderSchema,
    },
    async (args) => {
      assertMutationsEnabled(config);
      const end = deadline();
      const created = await api.post<{ roundId: string }>("/api/conductor/handoffs", {
        ...requestOptions(end),
        body: { to: args.to, ask: args.ask, orderId: orderId(args) },
      });
      const result = await poll("handoffs", created.roundId, end);
      if (result.status !== "done") throw new Error(result.reply || "El encargo ha fallado.");
      return new ToolText(result.reply || "El colaborador terminó sin respuesta de texto.");
    }
  );
  register(
    "dashboard_ask_user",
    "Ask Martin a question and wait for his decision.",
    {
      question: z.string().trim().min(1).max(4000),
      options: z.array(z.string().max(2000)).max(20).optional(),
      order_id: orderSchema,
    },
    async (args) => {
      assertMutationsEnabled(config);
      const result = await approval({
        orderId: orderId(args),
        agent: "claude",
        kind: "question",
        summary: args.question,
        options: args.options,
      });
      if (result.status !== "answered") throw new Error("La pregunta terminó sin respuesta.");
      return new ToolText(`Martin: ${result.answer}${result.note ? ` — ${result.note}` : ""}`);
    }
  );
  register(
    "dashboard_permission",
    "Claude Code permission prompt: wait for Martin and return allow/deny JSON.",
    {
      tool_name: z.string().min(1).max(256),
      input: z.record(z.unknown()),
      tool_use_id: z.string().optional(),
    },
    async (args) => {
      try {
        assertMutationsEnabled(config);
        const input = args.input as Record<string, unknown>;
        const result = await approval({
          orderId: orderId({}),
          agent: "claude",
          kind: "permission",
          summary: `${args.tool_name}: ${short(input.command || input.file_path || input.path || "solicitud de permiso")}`,
          detail: JSON.stringify(input).slice(0, 50_000),
        });
        return new ToolText(
          JSON.stringify(
            result.status === "answered" && result.answer === "approve"
              ? { behavior: "allow", updatedInput: input }
              : {
                  behavior: "deny",
                  message:
                    result.note ||
                    `Martin no autorizó la operación (${result.answer || result.status}).`,
                }
          )
        );
      } catch (error) {
        return new ToolText(
          JSON.stringify({
            behavior: "deny",
            message: error instanceof Error ? error.message : timeoutMessage,
          })
        );
      }
    }
  );
}
