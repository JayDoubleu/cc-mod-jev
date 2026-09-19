import { applyDecisions } from './apply.ts';
import { fitState, goalOf } from './state.ts';
import { estimateTokens, transcriptChars } from './tokens.ts';
import { collectToolCalls, pairChars } from './transcript.ts';
import { callQuestionName, decide, noulOf, questionsFor, resultQuestionName } from './questions.ts';
import type {
  CompactOptions,
  CompactResult,
  CompactStats,
  Decision,
  JevAnswer,
  JevAsker,
  JevQuestions,
  Message,
  ToolCall,
} from './types.ts';

export const DEFAULT_OPTIONS: CompactOptions = {
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  minPairChars: 300,
  truncateHeadChars: 300,
  maxStateTokens: 20000,
  maxRequestTokens: 28000,
};

const REQUEST_OVERHEAD_TOKENS = 200;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: Partial<CompactOptions> = {}): CompactOptions {
  const resolved: CompactOptions = {
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    minPairChars: Math.max(0, finite(options.minPairChars, DEFAULT_OPTIONS.minPairChars)),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(1, finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens)),
  };
  if (options.goal) resolved.goal = options.goal;
  return resolved;
}

/**
 * Splits the candidates into batches whose questions, with the (always
 * complete) state, fit one request; throws when one call alone does not fit.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  maxRequestTokens: number,
): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `the questions for ${call.id} do not fit beside the state within ${maxRequestTokens} tokens`,
      );
    }
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function emptyStats(messages: readonly Message[], calls: readonly ToolCall[]): CompactStats {
  const chars = transcriptChars(messages);
  return {
    messagesBefore: messages.length,
    messagesAfter: messages.length,
    charsBefore: chars,
    charsAfter: chars,
    calls: calls.length,
    candidates: 0,
    kept: 0,
    truncated: 0,
    dropped: 0,
    pinned: calls.filter((call) => call.pinned).length,
    small: 0,
    stateTokens: 0,
    stateStage: 0,
    requests: 0,
    jevInputTokens: 0,
    jevCostUsd: 0,
  };
}

/**
 * Scores every non-pinned tool call with Jev and returns the transcript with
 * stale calls dropped and stale results truncated, everything else verbatim.
 * Throws on a Jev failure, a malformed answer, or a state that cannot fit.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  partial: Partial<CompactOptions> = {},
): Promise<CompactResult> {
  const options = resolveOptions(partial);
  const calls = collectToolCalls(messages, options.preserveRecentMessages);
  const stats = emptyStats(messages, calls);
  const decisions: Decision[] = [];
  const candidates: ToolCall[] = [];
  for (const call of calls) {
    const chars = pairChars(call);
    if (call.pinned) {
      decisions.push({ id: call.id, tool: call.tool, action: 'pinned', keepCall: 1, keepResult: 1, chars });
    } else if (chars < options.minPairChars) {
      stats.small += 1;
      decisions.push({ id: call.id, tool: call.tool, action: 'small', keepCall: 1, keepResult: 1, chars });
    } else {
      candidates.push(call);
    }
  }
  stats.candidates = candidates.length;
  if (candidates.length === 0) {
    return { messages: [...messages], decisions, stats };
  }

  const goal = goalOf(messages, options.goal);
  const fitted = fitState(messages, calls, goal, options.maxStateTokens);
  stats.stateTokens = fitted.tokens;
  stats.stateStage = fitted.stage;

  const batches = batchCalls(candidates, fitted.tokens, options.maxRequestTokens);
  const answers: Record<string, JevAnswer> = {};
  const responses = await Promise.all(
    batches.map((batch) => {
      const questions: JevQuestions = {};
      for (const call of batch) Object.assign(questions, questionsFor(call));
      return asker.ask(fitted.state, questions);
    }),
  );
  for (const response of responses) {
    Object.assign(answers, response.answers);
    stats.jevInputTokens += response.usage?.input_tokens ?? 0;
    stats.jevCostUsd += response.usage?.cost ?? 0;
  }
  stats.requests = batches.length;

  for (const call of candidates) {
    const decision = decide(
      call,
      noulOf(answers, callQuestionName(call)),
      noulOf(answers, resultQuestionName(call)),
      options.keepThreshold,
      options.truncateHeadChars,
    );
    decisions.push(decision);
    if (decision.action === 'keep') stats.kept += 1;
    else if (decision.action === 'truncate_result') stats.truncated += 1;
    else stats.dropped += 1;
  }
  decisions.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

  const output = applyDecisions(messages, calls, decisions, options.truncateHeadChars);
  stats.messagesAfter = output.length;
  stats.charsAfter = transcriptChars(output);
  return { messages: output, decisions, stats };
}

/** The fraction of characters the pruning removed, 0 to 1. */
export function reductionRatio(result: CompactResult): number {
  const { charsBefore, charsAfter } = result.stats;
  if (charsBefore === 0) return 0;
  return (charsBefore - charsAfter) / charsBefore;
}
