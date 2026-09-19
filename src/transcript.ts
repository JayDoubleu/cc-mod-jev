import type { Message, ToolCall, ToolResult } from './types.ts';

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`, oldest first,
 * labelled `t1`, `t2`, ... A call is pinned when it sits in the first message,
 * in the newest `preserveRecentMessages` messages, or has no result yet.
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const recentFrom = Math.max(1, messages.length - Math.max(0, preserveRecentMessages));
  const calls: ToolCall[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const use of message.toolUses) {
      const found = results.get(use.tool_use_id);
      const resultText = found?.result.text ?? use.text ?? '';
      const pinned =
        index === 0 || index >= recentFrom || found === undefined || found.index >= recentFrom;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: use.tool_use_id,
        tool: use.tool,
        input: use.input ?? {},
        useIndex: index,
        resultIndex: found?.index ?? null,
        resultText,
        resultChars: resultText.length,
        isError: found?.result.isError ?? use.isError ?? false,
        pinned,
      });
    }
  });
  return calls;
}

/** The characters a pair carries: its input as JSON plus its result text. */
export function pairChars(call: ToolCall): number {
  return JSON.stringify(call.input).length + call.resultChars;
}
