/**
 * @file charla-model.ts
 * @description Maps persisted transcript blocks and handoff rounds into Charla entries without inventing timing data.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
import type { TranscriptMessage, TranscriptContent } from "../../lib/types";
import type { Handoff } from "./handoff-model";

export type CharlaBlock = {
  id: string;
  kind: "user" | "say" | "think" | "cmd" | "diff" | "read" | "handoff";
  at: string | null;
  text: string;
  output?: string;
  error?: boolean;
  direction?: "out" | "in";
};
const string = (value: unknown): string =>
  typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join(" ") : "";

export function transcriptBlocks(
  messages: TranscriptMessage[],
  handoff: Handoff | null = null
): CharlaBlock[] {
  const results = new Map<string, TranscriptContent>();
  for (const message of messages)
    for (const block of message.content) {
      if (block.type === "tool_result" && block.id) results.set(block.id, block);
    }
  const blocks: CharlaBlock[] = [];
  messages.forEach((message, mi) =>
    message.content.forEach((block, bi) => {
      const base = { id: `${message.id ?? mi}:${bi}`, at: message.timestamp };
      if (block.type === "thinking")
        blocks.push({ ...base, kind: "think", text: block.text || "" });
      if (
        block.type === "text" &&
        block.text &&
        !["tool", "system"].includes(message.sender || "") &&
        message.type !== "session_event"
      ) {
        blocks.push({
          ...base,
          kind: message.type === "assistant" ? "say" : "user",
          text: block.text,
        });
      }
      if (block.type !== "tool_use") return;
      const input: Record<string, unknown> = block.input || {};
      const name = (block.name || "").split(".").pop()!.toLowerCase();
      const result = block.id ? results.get(block.id) : undefined;
      const common = { ...base, output: result?.output, error: result?.is_error };
      if (["bash", "shell", "shell_command", "exec_command", "write_stdin"].includes(name)) {
        blocks.push({
          ...common,
          kind: "cmd",
          text: string(input.command || input.cmd || input.chars) || block.name || "",
        });
      } else if (["edit", "write", "apply_patch", "multiedit"].includes(name)) {
        const edits = Array.isArray(input.edits) ? input.edits : [input];
        const lines = edits.flatMap((edit) => {
          const item = edit as Record<string, unknown>;
          return [
            ...string(item.old_string)
              .split("\n")
              .filter(Boolean)
              .map((line) => `-${line}`),
            ...string(item.new_string ?? item.content)
              .split("\n")
              .filter(Boolean)
              .map((line) => `+${line}`),
          ];
        });
        blocks.push({
          ...common,
          kind: "diff",
          text: string(input.file_path || input.path) || block.name || "",
          output:
            string(input.patch || input.input || input.code || input._raw) ||
            lines.join("\n") ||
            result?.output ||
            "",
        });
      } else if (["read", "read_file", "glob", "grep", "list_dir"].includes(name)) {
        blocks.push({
          ...common,
          kind: "read",
          text: string(input.file_path || input.path || input.pattern) || block.name || "",
        });
      } else {
        blocks.push({
          ...common,
          kind: "cmd",
          text: `${block.name || ""}\n${JSON.stringify(input, null, 2)}`,
        });
      }
    })
  );
  handoff?.rounds.forEach((round, index) => {
    blocks.push({
      id: `handoff:${index}:out`,
      kind: "handoff",
      direction: "out",
      at: round.ask_at,
      text: round.ask,
    });
    if (round.reply != null)
      blocks.push({
        id: `handoff:${index}:in`,
        kind: "handoff",
        direction: "in",
        at: round.reply_at,
        text: round.reply,
      });
  });
  // Stable ordering preserves content order when timestamps are missing or equal.
  return blocks.sort((a, b) => (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : 0));
}
