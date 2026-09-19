import type { Decision, Message, ToolCall, ToolResult } from './types.ts';

export const NOTE_PREFIX = '[jev-context removed';

/** The note left where a result was cut. */
export function truncationNote(removedChars: number): string {
  return `\n\n${NOTE_PREFIX} ${removedChars} chars of this result: no longer needed. Re-run the tool if you need them.]`;
}

function stripHandle(message: Message): Message {
  const rebuilt: Message = { role: message.role, text: message.text, toolUses: message.toolUses };
  if (message.toolResults && message.toolResults.length > 0) rebuilt.toolResults = message.toolResults;
  return rebuilt;
}

/**
 * Applies the decisions to the transcript: a dropped call disappears with its
 * result, a truncated result keeps its head plus a note, everything else is
 * returned as the same object (handle included). A message left with neither
 * text nor tool blocks is removed. No result is ever left without its call.
 */
export function applyDecisions(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  decisions: readonly Decision[],
  truncateHeadChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call] as const));
  const drop = new Set<string>();
  const truncate = new Set<string>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (!call) continue;
    if (decision.action === 'drop_call') drop.add(call.tool_use_id);
    else if (decision.action === 'truncate_result') truncate.add(call.tool_use_id);
  }
  if (drop.size === 0 && truncate.size === 0) return [...messages];

  const output: Message[] = [];
  for (const message of messages) {
    let changed = false;
    const toolUses = message.toolUses.filter((use) => {
      if (drop.has(use.tool_use_id)) {
        changed = true;
        return false;
      }
      return true;
    });
    let toolResults: ToolResult[] | undefined;
    if (message.toolResults) {
      toolResults = [];
      for (const result of message.toolResults) {
        if (drop.has(result.tool_use_id)) {
          changed = true;
          continue;
        }
        if (truncate.has(result.tool_use_id) && result.text.length > truncateHeadChars) {
          changed = true;
          const head = result.text.slice(0, truncateHeadChars);
          toolResults.push({
            tool_use_id: result.tool_use_id,
            text: `${head}${truncationNote(result.text.length - truncateHeadChars)}`,
            isError: result.isError,
          });
          continue;
        }
        toolResults.push(result);
      }
    }
    if (!changed) {
      output.push(message);
      continue;
    }
    const empty =
      message.text.trim().length === 0 && toolUses.length === 0 && (toolResults?.length ?? 0) === 0;
    if (empty) continue;
    const rebuilt = stripHandle({ ...message, toolUses });
    if (toolResults && toolResults.length > 0) rebuilt.toolResults = toolResults;
    else delete rebuilt.toolResults;
    output.push(rebuilt);
  }
  return output;
}
