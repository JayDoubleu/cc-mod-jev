import { estimateTokens } from './tokens.ts';
import type { JevState, Message, ToolCall } from './types.ts';

export type StateStage = 0 | 1 | 2 | 3 | 4;

type StageLimits = {
  /** Characters of a tool input kept. */
  input: number;
  /** Characters of a text kept; 0 replaces every text by its length. */
  text: number;
  /** Characters of a result's head shown beside its note; 0 shows none. */
  head: number;
  /** Fraction of the oldest messages whose texts collapse to their length. */
  collapse: number;
  /** Calls become one line each instead of an object. */
  collapseCalls: boolean;
};

/**
 * The fitting stages, each applied only when the previous one was not
 * enough: inputs and texts shrink, result heads disappear, old texts collapse
 * to their length, and finally calls become one line each.
 */
const STAGES: readonly StageLimits[] = [
  { input: 1000, text: 2000, head: 120, collapse: 0, collapseCalls: false },
  { input: 300, text: 800, head: 80, collapse: 0, collapseCalls: false },
  { input: 100, text: 300, head: 0, collapse: 0, collapseCalls: false },
  { input: 60, text: 120, head: 0, collapse: 0.75, collapseCalls: false },
  { input: 40, text: 0, head: 0, collapse: 1, collapseCalls: true },
];

/** Head plus tail of a text within `max` characters, with an omission note. */
export function abridge(text: string, max: number): string {
  if (max <= 0) return text.length > 0 ? `[${text.length} chars]` : '';
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const omitted = text.length - max;
  const end = tail > 0 ? text.slice(-tail) : '';
  return `${text.slice(0, head)} [… ${omitted} chars omitted …] ${end}`;
}

/** The ongoing task: `explicit`, else the last `count` user prompts. */
export function goalOf(messages: readonly Message[], explicit?: string, count = 3): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const prompts = messages
    .filter((m) => m.role === 'user' && m.text.trim().length > 0 && !(m.toolResults?.length))
    .map((m) => abridge(m.text.trim(), 500));
  return prompts.slice(-count).join('\n---\n') || '(no user prompt yet)';
}

function resultNote(call: ToolCall): string {
  if (call.resultIndex === null) return 'pending';
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars`;
}

function callEntry(call: ToolCall, limits: StageLimits): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: call.id,
    tool: call.tool,
    input: abridge(JSON.stringify(call.input), limits.input),
    result: resultNote(call),
  };
  if (limits.head > 0 && call.resultChars > 0) {
    entry.head = call.resultText.replace(/\s+/g, ' ').trim().slice(0, limits.head);
  }
  return entry;
}

function callLine(call: ToolCall, limits: StageLimits): string {
  return `${call.id} ${call.tool} ${abridge(JSON.stringify(call.input), limits.input)} → ${resultNote(call)}`;
}

/**
 * The state Jev reads: the goal and the whole conversation oldest first, tool
 * results replaced by a note (and a short head at the early stages), texts
 * abridged to the stage's limits. Nothing is summarised.
 */
export function buildState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  stage: StateStage,
  goal: string,
): JevState {
  const limits = STAGES[stage] ?? STAGES[STAGES.length - 1]!;
  const byUse = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const own = byUse.get(call.useIndex);
    if (own) own.push(call);
    else byUse.set(call.useIndex, [call]);
  }
  const collapseBefore = Math.floor(messages.length * limits.collapse);
  const conversation: unknown[] = [];
  messages.forEach((message, index) => {
    const collapse = index < collapseBefore || limits.text === 0;
    const text = message.text.trim();
    const shown = text.length === 0 ? '' : collapse ? `[${text.length} chars]` : abridge(text, limits.text);
    if (message.role === 'user') {
      if (shown) conversation.push({ user: shown });
      return;
    }
    const entry: Record<string, unknown> = {};
    if (shown) entry.assistant = shown;
    const own = byUse.get(index);
    if (own && own.length > 0) {
      entry.calls = own.map((call) =>
        limits.collapseCalls ? callLine(call, limits) : callEntry(call, limits),
      );
    }
    if (Object.keys(entry).length > 0) conversation.push(entry);
  });
  return { goal, conversation };
}

export type FittedState = { state: JevState; tokens: number; stage: StateStage };

/** The first stage whose state fits `maxStateTokens`; throws when none does. */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  goal: string,
  maxStateTokens: number,
): FittedState {
  for (let stage = 0; stage < STAGES.length; stage++) {
    const state = buildState(messages, calls, stage as StateStage, goal);
    const tokens = estimateTokens(JSON.stringify(state));
    if (tokens <= maxStateTokens) return { state, tokens, stage: stage as StateStage };
  }
  throw new Error(`the conversation does not fit the Jev state budget of ${maxStateTokens} tokens`);
}
