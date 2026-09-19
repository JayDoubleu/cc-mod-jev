/**
 * The shapes the library works over. `Message` is a structural subset of
 * Claude Code's `SessionMessage`, so a session transcript passes in as is.
 */

export type Role = 'user' | 'assistant';

export type ToolUse = {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** The result as the model read it, once the transcript holds it. */
  text?: string;
  isError?: boolean;
  result?: unknown;
};

export type ToolResult = {
  tool_use_id: string;
  text: string;
  isError: boolean;
  result?: unknown;
};

export type Message = {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
  /** The engine's opaque token on a message it handed `session.compact`. */
  handle?: string;
};

/** One tool_use paired with its tool_result, as the pruning sees it. */
export type ToolCall = {
  /** A short label (`t1`, `t2`, ...) used in the state and the questions. */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the assistant message holding the tool_use. */
  useIndex: number;
  /** Index of the user message holding the tool_result; null while in flight. */
  resultIndex: number | null;
  resultText: string;
  resultChars: number;
  isError: boolean;
  /** Never touched: first message, newest messages, or a result in flight. */
  pinned: boolean;
};

export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type JevQuestions = Record<string, NoulQuestion>;
export type JevState = Record<string, unknown>;

export type JevAnswer = { type: 'noul'; noul: number };

export type JevUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
};

export type JevResponse = {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: JevUsage;
};

/** One `ask` over any transport: the engine's `$.http.fetch`, or a fake. */
export type JevAsker = {
  ask(state: JevState, questions: JevQuestions): Promise<JevResponse>;
};

export type DecisionAction = 'keep' | 'truncate_result' | 'drop_call' | 'pinned' | 'small';

export type Decision = {
  id: string;
  tool: string;
  action: DecisionAction;
  keepCall: number;
  keepResult: number;
  /** Characters the pair carries (input plus result). */
  chars: number;
};

export type CompactOptions = {
  /** The ongoing task, in the state; the last user prompts when absent. */
  goal?: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  /** Pairs smaller than this many characters are kept without asking. */
  minPairChars: number;
  truncateHeadChars: number;
  maxStateTokens: number;
  maxRequestTokens: number;
};

export type CompactStats = {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  candidates: number;
  kept: number;
  truncated: number;
  dropped: number;
  pinned: number;
  small: number;
  stateTokens: number;
  stateStage: number;
  requests: number;
  jevInputTokens: number;
  jevCostUsd: number;
};

export type CompactResult = {
  messages: Message[];
  decisions: Decision[];
  stats: CompactStats;
};
