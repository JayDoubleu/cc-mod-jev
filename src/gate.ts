import { abridge, goalOf } from './state.ts';
import type { JevQuestions, JevState, Message } from './types.ts';

export const GATE_NOTE_PREFIX = '[jev-context cut';

export type GateOptions = {
  gateTools: readonly string[];
  gateMinChars: number;
  gateThreshold: number;
  gateHeadChars: number;
  gateTailChars: number;
};

export const GATE_QUESTION = 'need_full_output';

/**
 * The part of a fresh tool result the gate can cut, per tool: Bash's stdout,
 * Read's file content. Undefined for any other tool or shape, so the gate
 * never judges an output it could not cut.
 */
export function outputOf(tool: string, result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (tool === 'Bash') return typeof record.stdout === 'string' ? record.stdout : undefined;
  if (tool === 'Read') {
    const file = record.file;
    if (file && typeof file === 'object') {
      const content = (file as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
    }
  }
  return undefined;
}

/** Head and tail of an output around a note saying what was cut. */
export function cutOutput(output: string, head: number, tail: number, hint: string): string {
  if (output.length <= head + tail) return output;
  const removed = output.length - head - tail;
  const note = `\n\n${GATE_NOTE_PREFIX} ${removed} chars from the middle of this output: judged not needed in full. ${hint}]\n\n`;
  return `${output.slice(0, head)}${note}${tail > 0 ? output.slice(-tail) : ''}`;
}

/** The state the gate sends: the goal (explicit, else the last prompts), the recent conversation, and the call. */
export function gateState(
  recent: readonly Message[],
  tool: string,
  input: Record<string, unknown>,
  output: string,
  options: Pick<GateOptions, 'gateHeadChars' | 'gateTailChars'>,
  goal?: string,
): JevState {
  const conversation = recent.slice(-12).map((message) => {
    const entry: Record<string, unknown> = { role: message.role };
    if (message.text.trim()) entry.text = abridge(message.text.trim(), 600);
    if (message.toolUses.length > 0) {
      entry.calls = message.toolUses.map(
        (use) => `${use.tool} ${abridge(JSON.stringify(use.input ?? {}), 200)}`,
      );
    }
    return entry;
  });
  const head = Math.min(1500, options.gateHeadChars);
  const tail = Math.min(800, options.gateTailChars);
  return {
    goal: goalOf(recent, goal),
    recent_conversation: conversation,
    new_tool_result: {
      tool,
      input: abridge(JSON.stringify(input), 600),
      output_chars: output.length,
      output_head: output.slice(0, head),
      output_tail: output.length > head ? output.slice(-tail) : '',
      what_the_model_would_get_instead: `the first ${options.gateHeadChars} and last ${options.gateTailChars} characters, with a note saying how much was cut`,
    },
  };
}

export function gateQuestions(): JevQuestions {
  return {
    [GATE_QUESTION]: {
      type: 'noul',
      instructions:
        'The assistant needs the complete output of this new tool result, verbatim, to continue the goal: its head and tail alone would lose information the assistant will use.',
      criteria: {
        true: 'The middle of the output holds specific content the assistant asked for or must inspect: file contents to edit, search hits, a stack trace, data to reason over.',
        false: 'The output is repetitive or bulk material (a long listing, install or build logs, generated sequences) whose head and tail carry what matters, or the assistant only needs to know whether the command succeeded.',
      },
    },
  };
}

/**
 * The result record with its bulk cut, per tool: Bash keeps stdout head and
 * tail, Read keeps the head of the file's content. Undefined when the tool is
 * not handled or the record has no text to cut.
 */
export function cutResult(tool: string, result: unknown, options: GateOptions): unknown {
  if (result === null || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (tool === 'Bash' && typeof record.stdout === 'string') {
    if (record.stdout.length <= options.gateHeadChars + options.gateTailChars) return undefined;
    return {
      ...record,
      stdout: cutOutput(
        record.stdout,
        options.gateHeadChars,
        options.gateTailChars,
        'Re-run the command, piped through head, tail or grep, to see a specific part.',
      ),
    };
  }
  if (tool === 'Read' && record.file && typeof record.file === 'object') {
    const file = record.file as Record<string, unknown>;
    if (typeof file.content !== 'string') return undefined;
    const keep = options.gateHeadChars + options.gateTailChars;
    if (file.content.length <= keep) return undefined;
    const head = file.content.slice(0, keep);
    const fullLines = head.split('\n').length - 1;
    const removed = file.content.length - keep;
    const startLine = typeof file.startLine === 'number' ? file.startLine : 1;
    const content = `${head}\n${GATE_NOTE_PREFIX} ${removed} chars after this point: judged not needed in full. Read again with offset=${startLine + fullLines} to see the rest.]`;
    return {
      ...record,
      file: { ...file, content, numLines: content.split('\n').length },
    };
  }
  return undefined;
}
