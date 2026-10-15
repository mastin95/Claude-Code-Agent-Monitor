/**
 * @file Conductor polling and exact MCP permission response contracts with simulated HTTP.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConductorTools } from "../src/tools/domains/conductor-tools.js";
import { registerAllTools } from "../src/tools/index.js";
import { Logger } from "../src/core/logger.js";
import type { ToolContext } from "../src/types/tool-context.js";

function setup(t: any, results: unknown[], allowMutations = true) {
  const previousOrder = process.env.CONDUCTOR_ORDER_ID;
  const previousTimeout = process.env.CONDUCTOR_HANDOFF_TIMEOUT_MS;
  process.env.CONDUCTOR_ORDER_ID = "order-env";
  delete process.env.CONDUCTOR_HANDOFF_TIMEOUT_MS;
  t.after(() => {
    if (previousOrder === undefined) delete process.env.CONDUCTOR_ORDER_ID;
    else process.env.CONDUCTOR_ORDER_ID = previousOrder;
    if (previousTimeout === undefined) delete process.env.CONDUCTOR_HANDOFF_TIMEOUT_MS;
    else process.env.CONDUCTOR_HANDOFF_TIMEOUT_MS = previousTimeout;
  });
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const calls: any[] = [];
  const context = {
    server: {
      registerTool(name: string, _schema: unknown, handler: any) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    logger: new Logger("error"),
    config: { allowMutations, requestTimeoutMs: 120_000 },
    api: {
      async post(path: string, options: any) {
        calls.push({ path, ...options });
        return { roundId: "round/1", approvalId: "approval/1" };
      },
      async get(path: string, options: any) {
        calls.push({ path, ...options });
        const next = results.shift();
        if (typeof next === "function") return next();
        if (!next) throw new Error("Unexpected poll");
        return next;
      },
    },
  } as unknown as ToolContext;
  registerConductorTools(context);
  return {
    calls,
    handlers,
    context,
    invoke: (name: string, args: any = {}) => handlers.get(name)!(args),
  };
}

test("handoff polls pending to done and returns plain text", async (t) => {
  const h = setup(t, [{ status: "pending" }, { status: "done", reply: "Cambio terminado" }]);
  registerAllTools(h.context);
  const result = await h.invoke("dashboard_handoff", { to: "codex", ask: "Edita" });
  assert.deepEqual(result, { content: [{ type: "text", text: "Cambio terminado" }] });
  assert.equal(h.calls[0].body.orderId, "order-env");
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1].path, "/api/conductor/handoffs/round%2F1");
  assert.equal(h.calls[1].query.waitMs, 100_000);
  assert.ok(h.calls.every((c) => c.timeoutMs <= 120_000 && c.idempotent === false));
});

test("handoff total deadline stops polling", async (t) => {
  const h = setup(t, [
    () => {
      t.mock.method(Date, "now", () => 200);
      return { status: "pending" };
    },
  ]);
  t.mock.method(Date, "now", () => 100);
  process.env.CONDUCTOR_HANDOFF_TIMEOUT_MS = "50";
  const result = await h.invoke("dashboard_handoff", {
    to: "codex",
    ask: "Espera",
    order_id: "explicit",
  });
  assert.equal(h.calls[0].body.orderId, "explicit");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /agotó/);
  assert.equal(h.calls.length, 2);
});

for (const answer of ["approve", "change", "stop"]) {
  test(`permission ${answer} returns exactly one JSON text block`, async (t) => {
    const h = setup(t, [
      { status: "pending" },
      { status: "answered", answer, note: "Solo lectura" },
    ]);
    const input = { command: "git status", nested: { keep: [1, true] } };
    const result = await h.invoke("dashboard_permission", { tool_name: "Bash", input });
    const expected =
      answer === "approve"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Solo lectura" };
    assert.deepEqual(result, { content: [{ type: "text", text: JSON.stringify(expected) }] });
    assert.equal(h.calls[0].body.summary, "Bash: git status");
    assert.equal(h.calls[0].body.detail, JSON.stringify(input));
  });
}

test("permission timeout denies, preserving exact protocol format", async (t) => {
  const h = setup(t, [
    () => {
      t.mock.method(Date, "now", () => 200);
      return { status: "pending" };
    },
  ]);
  t.mock.method(Date, "now", () => 100);
  process.env.CONDUCTOR_HANDOFF_TIMEOUT_MS = "50";
  const result = await h.invoke("dashboard_permission", {
    tool_name: "Edit",
    input: { file_path: "a.ts" },
  });
  assert.equal(result.content.length, 1);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.behavior, "deny");
  assert.match(value.message, /agotó/);
});

test("question carries options and returns Martin's decision and note", async (t) => {
  const h = setup(t, [{ status: "answered", answer: "change", note: "Opción B" }]);
  const result = await h.invoke("dashboard_ask_user", {
    question: "¿Continuar?",
    options: ["A", "B"],
  });
  assert.deepEqual(h.calls[0].body.options, ["A", "B"]);
  assert.equal(h.calls[0].body.kind, "question");
  assert.equal(result.content[0].text, "Martin: change — Opción B");
});

test("all three tools enforce mutation policy without HTTP calls", async (t) => {
  const h = setup(t, [], false);
  for (const name of ["dashboard_handoff", "dashboard_ask_user", "dashboard_permission"]) {
    const result = await h.invoke(name, {});
    if (name === "dashboard_permission")
      assert.equal(JSON.parse(result.content[0].text).behavior, "deny");
    else assert.equal(result.isError, true);
  }
  assert.equal(h.calls.length, 0);
});
