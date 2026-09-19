import type { Decision, JevAnswer, JevQuestions, ToolCall } from './types.ts';
import { pairChars } from './transcript.ts';

export function callQuestionName(call: ToolCall): string {
  return `call_${call.id}`;
}

export function resultQuestionName(call: ToolCall): string {
  return `result_${call.id}`;
}

/**
 * The two `noul` questions asked about one call, phrased as statements so a
 * high probability means "keep": should the call stay, should its full
 * output stay verbatim.
 */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [callQuestionName(call)]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the conversation history: knowing that this call was made, with its input, still matters for what the assistant does next on the goal.`,
      criteria: {
        true: 'The call is still relevant: later steps build on it, or the assistant needs to know it happened.',
        false: 'The call is stale: superseded by a later call, finished with, or unrelated to the goal.',
      },
    },
    [resultQuestionName(call)]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its exact contents, and re-running the tool would not do.`,
      criteria: {
        true: 'The exact output is still needed: it holds details the assistant will refer back to and cannot cheaply reproduce.',
        false: 'The output has served its purpose: it was acted on, superseded by a later result, or can be reproduced by re-running the tool.',
      },
    },
  };
}

/** The `noul` probability of one answer; throws when it is missing or malformed. */
export function noulOf(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name];
  if (!answer || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
    throw new Error(`Jev answer missing or malformed for ${name}`);
  }
  return answer.noul;
}

/** The decision for one call from its two probabilities and the threshold. */
export function decide(
  call: ToolCall,
  keepCall: number,
  keepResult: number,
  keepThreshold: number,
): Decision {
  const base = { id: call.id, tool: call.tool, keepCall, keepResult, chars: pairChars(call) };
  if (keepResult >= keepThreshold) return { ...base, action: 'keep' };
  if (keepCall >= keepThreshold) return { ...base, action: 'truncate_result' };
  return { ...base, action: 'drop_call' };
}
