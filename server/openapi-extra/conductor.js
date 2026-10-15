/**
 * @file OpenAPI contract for phase-one conductor projects, orders, pitch duels and long polls.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
const string = { type: "string" };
const nullableString = { type: "string", nullable: true };
const object = { type: "object", additionalProperties: true };
const answer = { type: "string", enum: ["approve", "change", "stop"] };
const identity = { orderId: string, leadSessionId: string, cwd: string };
const json = (schema) => ({ "application/json": { schema } });
const body = (properties, required) => ({
  required: true,
  content: json({ type: "object", properties, required }),
});
const id = { name: "id", in: "path", required: true, schema: string };
const wait = {
  name: "waitMs",
  in: "query",
  schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
};
function operation(operationId, summary, status = 200, schema = object, extra = {}) {
  return {
    tags: ["Conductor"],
    operationId,
    summary,
    ...extra,
    responses: {
      [status]: { description: "Success", content: json(schema) },
      400: { description: "Invalid input or unsupported phase-one lead" },
      403: { description: "Non-loopback Origin/Referer rejected" },
      404: { description: "Resource not found" },
      409: {
        description:
          "Order inactive, overlapping handoff, ambiguous identity or conflicting answer",
      },
    },
  };
}
const paths = {
  "/api/conductor/projects": {
    get: operation("listConductorProjects", "List conductor projects", 200, {
      type: "object",
      properties: {
        items: { type: "array", items: object },
        project_only: {
          type: "boolean",
          description:
            "True when the Monitor keeps only work born in its projects and scopes pages to one",
        },
      },
    }),
    post: operation(
      "createConductorProject",
      "Create a project; optionally mkdir and git init without a shell",
      201,
      object,
      {
        requestBody: body(
          {
            cwd: string,
            name: string,
            lead: { enum: ["claude"] },
            create: { type: "boolean" },
            models: object,
            claude_model: string,
            claude_effort: string,
            codex_model: string,
            codex_effort: string,
            codex_sandbox: { enum: ["read-only", "workspace-write", "danger-full-access"] },
          },
          ["cwd"]
        ),
      }
    ),
  },
  "/api/conductor/orders": {
    get: operation(
      "listConductorOrders",
      "List a project's latest orders, newest first",
      200,
      object,
      {
        parameters: [
          { name: "projectId", in: "query", required: true, schema: string },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
        ],
      }
    ),
    post: operation(
      "createConductorOrder",
      "Create an order and launch its Claude lead",
      201,
      object,
      { requestBody: body({ projectId: string, text: string }, ["projectId", "text"]) }
    ),
  },
  "/api/conductor/orders/{id}": {
    get: operation(
      "getConductorOrder",
      "Get order, rounds, approvals and both run states",
      200,
      object,
      { parameters: [id] }
    ),
    delete: operation(
      "stopConductorOrder",
      "Stop both runs and settle outstanding work",
      200,
      object,
      { parameters: [id] }
    ),
  },
  "/api/conductor/orders/{id}/indication": {
    post: operation(
      "indicateConductorOrder",
      "Queue an indication until the lead result envelope",
      200,
      { type: "object", properties: { queued: { type: "boolean" } } },
      { parameters: [id], requestBody: body({ text: string }, ["text"]) }
    ),
  },
  "/api/conductor/pitches": {
    get: operation("listConductorPitches", "List a project's latest pitch duels", 200, object, {
      parameters: [
        { name: "projectId", in: "query", required: true, schema: string },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 1 },
        },
      ],
    }),
    post: operation(
      "createConductorPitch",
      "Ask Claude and Codex to propose the project in parallel (read-only runs)",
      201,
      object,
      {
        requestBody: body(
          { projectId: string, idea: string, depth: { enum: ["quick", "normal", "deep"] } },
          ["projectId", "idea"]
        ),
      }
    ),
  },
  "/api/conductor/pitches/{id}": {
    get: operation("getConductorPitch", "Get both pitches and their status", 200, object, {
      parameters: [id],
    }),
    delete: operation("stopConductorPitch", "Stop a pitch duel still drafting", 200, object, {
      parameters: [id],
    }),
  },
  "/api/conductor/pitches/{id}/order": {
    post: operation(
      "orderConductorPitch",
      "Turn Martin's mix of cards into the lead's order",
      201,
      object,
      {
        parameters: [id],
        requestBody: body(
          {
            picks: {
              type: "array",
              items: {
                type: "object",
                properties: { agent: { enum: ["claude", "codex"] }, index: { type: "integer" } },
                required: ["agent", "index"],
              },
            },
            note: string,
            lead: { enum: ["claude"] },
          },
          ["picks"]
        ),
      }
    ),
  },
  "/api/conductor/handoffs": {
    post: operation(
      "createConductorHandoff",
      "Start or reuse Codex for one handoff",
      202,
      { type: "object", properties: { roundId: string } },
      { requestBody: body({ ...identity, to: { enum: ["codex"] }, ask: string }, ["to", "ask"]) }
    ),
  },
  "/api/conductor/handoffs/{id}": {
    get: operation(
      "pollConductorHandoff",
      "Wait up to 100 seconds; repeat while pending",
      200,
      {
        type: "object",
        properties: { status: { enum: ["pending", "done", "error"] }, reply: nullableString },
      },
      { parameters: [id, wait] }
    ),
  },
  "/api/conductor/approvals": {
    post: operation(
      "createConductorApproval",
      "Request a permission decision or question",
      202,
      { type: "object", properties: { approvalId: string } },
      {
        requestBody: body(
          {
            ...identity,
            agent: { enum: ["claude", "codex"] },
            kind: { enum: ["permission", "question"] },
            summary: string,
            detail: string,
            options: { type: "array", items: string },
          },
          ["agent", "kind", "summary"]
        ),
      }
    ),
  },
  "/api/conductor/approvals/{id}": {
    get: operation(
      "pollConductorApproval",
      "Wait up to 100 seconds for Martin's answer",
      200,
      {
        type: "object",
        properties: {
          status: { enum: ["pending", "answered"] },
          answer: { ...answer, nullable: true },
          note: nullableString,
        },
      },
      { parameters: [id, wait] }
    ),
    post: operation(
      "answerConductorApproval",
      "Answer an approval; stop also stops the order",
      200,
      object,
      { parameters: [id], requestBody: body({ answer, note: string }, ["answer"]) }
    ),
  },
};
module.exports = {
  tags: [
    {
      name: "Conductor",
      description: "Claude lead and Codex collaborator; loopback guard on every route",
    },
  ],
  schemas: {},
  paths,
};
