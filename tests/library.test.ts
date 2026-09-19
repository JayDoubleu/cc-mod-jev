import { describe, expect, test } from 'claude-code/testing';

import { applyDecisions, NOTE_PREFIX } from '../src/apply.ts';
import { batchCalls, compact, reductionRatio } from '../src/compact.ts';
import { DEFAULT_CONFIG, envName, resolveConfig } from '../src/config.ts';
import { cutOutput, cutResult, GATE_NOTE_PREFIX, outputOf } from '../src/gate.ts';
import { buildRequest, DEFAULT_MODEL, OPENROUTER_DECISIONS_URL, parseResponse } from '../src/openrouter.ts';
import { decide, questionsFor } from '../src/questions.ts';
import { abridge, fitState, goalOf } from '../src/state.ts';
import { estimateTokens } from '../src/tokens.ts';
import { collectToolCalls } from '../src/transcript.ts';
import type { JevAsker, JevQuestions, JevState, Message } from '../src/types.ts';

function user(text: string, handle?: string): Message {
  const message: Message = { role: 'user', text, toolUses: [] };
  if (handle) message.handle = handle;
  return message;
}

function assistant(text: string, handle?: string): Message {
  const message: Message = { role: 'assistant', text, toolUses: [] };
  if (handle) message.handle = handle;
  return message;
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text }], handle: `use-${id}` };
}

function result(id: string, text: string, isError = false): Message {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }], handle: `res-${id}` };
}

const FILE_A = 'export const a = 1;\n'.repeat(60);
const FAIL = 'FAIL src/a.test.ts\n  expected 3 got 2 at a.ts:42\n'.repeat(12);
const PASS = 'PASS 12 tests\n'.repeat(30);

/** A short session: a prompt, a Read, a failing test, an Edit, a passing test. */
function transcript(): Message[] {
  return [
    user('Fix the failing test in src/a.test.ts. Never edit src/generated.ts.', 'h0'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, FILE_A),
    result('tool-1', FILE_A),
    call('tool-2', 'Bash', { command: 'npm test' }, FAIL),
    result('tool-2', FAIL, true),
    assistant('The loop bound is off by one. Fixing it now.', 'h5'),
    user('go ahead', 'h6'),
    call('tool-3', 'Edit', { file_path: 'src/a.ts', old_string: 'i < n', new_string: 'i <= n' }, 'ok'),
    result('tool-3', 'ok'),
    call('tool-4', 'Bash', { command: 'npm test' }, PASS),
    result('tool-4', PASS),
    assistant('Done: the tests pass.', 'h11'),
  ];
}

type Asked = { state: JevState; questions: JevQuestions };

function fakeAsker(answer: (name: string) => number, asked: Asked[] = []): JevAsker {
  return {
    async ask(state, questions) {
      asked.push({ state, questions });
      const answers = Object.fromEntries(
        Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: answer(name) }]),
      );
      return { answers, usage: { input_tokens: 500, output_tokens: 10, cost: 0.00002 } };
    },
  };
}

describe('transcript', () => {
  test('pairs tool uses with their results and pins the first and newest messages', async () => {
    const calls = collectToolCalls(transcript(), 2);
    expect(calls.map((c) => c.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(calls[0]).toMatchObject({ tool: 'Read', useIndex: 1, resultIndex: 2, resultChars: FILE_A.length, pinned: false });
    expect(calls[1]).toMatchObject({ tool: 'Bash', isError: true, pinned: false });
    expect(calls[3]).toMatchObject({ tool: 'Bash', useIndex: 9, resultIndex: 10, pinned: true });
  });

  test('a call without a result yet is pinned', async () => {
    const messages = [user('x'), call('tool-9', 'Bash', { command: 'sleep 1' }, '')];
    const calls = collectToolCalls(messages, 0);
    expect(calls[0]).toMatchObject({ resultIndex: null, pinned: true });
  });
});

describe('state', () => {
  test('the goal is the last user prompts, tool-result messages excluded', async () => {
    expect(goalOf(transcript())).toBe(
      'Fix the failing test in src/a.test.ts. Never edit src/generated.ts.\n---\ngo ahead',
    );
    expect(goalOf(transcript(), 'explicit goal')).toBe('explicit goal');
    expect(goalOf([])).toBe('(no user prompt yet)');
  });

  test('abridge keeps head and tail and notes the omission', async () => {
    expect(abridge('short', 10)).toBe('short');
    const text = 'a'.repeat(50) + 'b'.repeat(50);
    const out = abridge(text, 20);
    expect(out).toStartWith('a'.repeat(12));
    expect(out).toEndWith('b'.repeat(8));
    expect(out).toContain('[… 80 chars omitted …]');
    expect(abridge(text, 0)).toBe('[100 chars]');
  });

  test('the state carries the goal and every call with a result note, and fits by stages', async () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 2);
    const full = fitState(messages, calls, goalOf(messages), 20000);
    expect(full.stage).toBe(0);
    const json = JSON.stringify(full.state);
    expect(json).toContain('"goal"');
    expect(json).toContain(`"result":"error, ${FAIL.length} chars"`);
    expect(json).toContain('"id":"t4"');
    expect(json).not.toContain(FILE_A);
    const tight = fitState(messages, calls, goalOf(messages), full.tokens - 20);
    expect(tight.stage).toBeGreaterThan(0);
    expect(tight.tokens).toBeLessThan(full.tokens);
    expect(() => fitState(messages, calls, goalOf(messages), 10)).toThrow(/does not fit/);
  });
});

describe('questions and decisions', () => {
  test('two noul questions per call, phrased so that a high probability means keep', async () => {
    const [callOne] = collectToolCalls(transcript(), 2);
    const questions = questionsFor(callOne!);
    expect(Object.keys(questions)).toEqual(['call_t1', 'result_t1']);
    expect(questions.call_t1?.type).toBe('noul');
    expect(questions.call_t1?.instructions).toContain('t1 (Read)');
    expect(questions.result_t1?.instructions).toContain(`${FILE_A.length} chars`);
  });

  test('decide keeps, truncates or drops against the threshold', async () => {
    const [callOne] = collectToolCalls(transcript(), 2);
    expect(decide(callOne!, 0.9, 0.9, 0.5).action).toBe('keep');
    expect(decide(callOne!, 0.9, 0.1, 0.5).action).toBe('truncate_result');
    expect(decide(callOne!, 0.1, 0.1, 0.5).action).toBe('drop_call');
    expect(decide(callOne!, 0.4, 0.4, 0.3).action).toBe('keep');
  });

  test('batchCalls splits the questions by the request budget and rejects an impossible one', async () => {
    const calls = collectToolCalls(transcript(), 0);
    const per = estimateTokens(JSON.stringify(questionsFor(calls[0]!)));
    expect(batchCalls(calls, 100, 10000)).toHaveLength(1);
    expect(batchCalls(calls, 100, 100 + 200 + per * 2 + 1)).toHaveLength(2);
    expect(() => batchCalls(calls, 100, 100 + 200 + per - 1)).toThrow(/do not fit/);
  });
});

describe('apply', () => {
  test('drops a pair whole, truncates a result with a note, leaves the rest as the same objects', async () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 2);
    const decisions = [
      decide(calls[0]!, 0.1, 0.1, 0.5),
      decide(calls[1]!, 0.9, 0.1, 0.5),
      decide(calls[2]!, 0.9, 0.9, 0.5),
    ];
    const out = applyDecisions(messages, calls, decisions, 40);
    expect(out).toHaveLength(messages.length - 2);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[3]);
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toStartWith(FAIL.slice(0, 40));
    expect(out[2]?.toolResults?.[0]?.text).toContain(`${NOTE_PREFIX} ${FAIL.length - 40} chars`);
    expect(out[2]?.toolResults?.[0]?.isError).toBe(true);
    expect(out[3]).toBe(messages[5]);
  });

  test('an assistant message that keeps text but loses its call is rebuilt without a handle', async () => {
    const messages = [
      user('start', 'h0'),
      { ...call('tool-1', 'Bash', { command: 'ls' }, 'a\nb'), text: 'Listing first.' },
      result('tool-1', 'a\nb'),
      user('next', 'h3'),
    ];
    const calls = collectToolCalls(messages, 1);
    const out = applyDecisions(messages, calls, [decide(calls[0]!, 0.1, 0.1, 0.5)], 40);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(out[1]).toMatchObject({ text: 'Listing first.', toolUses: [] });
    expect(out[1]?.handle).toBeUndefined();
  });
});

describe('compact', () => {
  test('scores the candidates in one request and rebuilds the transcript', async () => {
    const asked: Asked[] = [];
    const messages = transcript();
    const out = await compact(
      messages,
      fakeAsker((name) => (name.endsWith('_t1') ? 0.1 : name === 'result_t2' ? 0.2 : 0.9), asked),
      { preserveRecentMessages: 2, minPairChars: 0 },
    );
    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0]!.questions).sort()).toEqual(
      ['call_t1', 'call_t2', 'call_t3', 'result_t1', 'result_t2', 'result_t3'],
    );
    expect(out.decisions.map((d) => `${d.id}:${d.action}`)).toEqual([
      't1:drop_call',
      't2:truncate_result',
      't3:keep',
      't4:pinned',
    ]);
    expect(out.stats).toMatchObject({ candidates: 3, kept: 1, truncated: 1, dropped: 1, pinned: 1, requests: 1, jevInputTokens: 500 });
    expect(out.messages).toHaveLength(messages.length - 2);
    expect(reductionRatio(out)).toBeGreaterThan(0.5);
  });

  test('small pairs and pinned calls are kept without a request', async () => {
    const asked: Asked[] = [];
    const out = await compact(transcript(), fakeAsker(() => 0, asked), { preserveRecentMessages: 20 });
    expect(asked).toHaveLength(0);
    expect(out.stats.requests).toBe(0);
    expect(out.messages).toHaveLength(12);
    const small = await compact(transcript(), fakeAsker(() => 0, asked), { preserveRecentMessages: 0, minPairChars: 100000 });
    expect(asked).toHaveLength(0);
    expect(small.stats.small).toBe(4);
  });

  test('a missing answer is an error the caller falls back on', async () => {
    const broken: JevAsker = { async ask() { return { answers: {} }; } };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 2 })).rejects.toThrow(/missing or malformed/);
  });
});

describe('openrouter', () => {
  test('builds a decisions request with the bearer key and parses the answers', async () => {
    const request = buildRequest({ apiKey: 'sk-or-x' }, { goal: 'g' }, { q: { type: 'noul', instructions: 'i' } });
    expect(request.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(request.headers.authorization).toBe('Bearer sk-or-x');
    expect(JSON.parse(request.body)).toEqual({
      model: DEFAULT_MODEL,
      state: { goal: 'g' },
      questions: { q: { type: 'noul', instructions: 'i' } },
    });
    expect(parseResponse(200, true, '{"answers":{"q":{"type":"noul","noul":0.4}}}').answers.q?.noul).toBe(0.4);
    expect(() => parseResponse(401, false, 'nope')).toThrow(/401/);
    expect(() => parseResponse(200, true, '{')).toThrow(/malformed/);
    expect(() => parseResponse(200, true, '{"x":1}')).toThrow(/missing answers/);
  });
});

describe('config', () => {
  test('defaults, options, then JEV_CONTEXT_* and EVAL_JEV_CONTEXT_* variables, in that order', async () => {
    expect(resolveConfig({}, {})).toEqual({ ...DEFAULT_CONFIG, gateTools: ['Bash'] });
    expect(envName('gateMinChars')).toBe('JEV_CONTEXT_GATE_MIN_CHARS');
    const config = resolveConfig(
      { apiKey: 'opt', keepThreshold: 0.4, gate: true, gateTools: 'Bash, Read', log: 'debug' },
      { JEV_CONTEXT_KEEP_THRESHOLD: '0.6', EVAL_JEV_CONTEXT_KEEP_THRESHOLD: '0.7', JEV_CONTEXT_GATE: 'off', OPENROUTER_API_KEY: 'env' },
    );
    expect(config).toMatchObject({ apiKey: 'opt', keepThreshold: 0.7, gate: false, gateTools: ['Bash', 'Read'], log: 'debug' });
    expect(resolveConfig({}, { EVAL_OPENROUTER_API_KEY: 'eval' }).apiKey).toBe('eval');
    expect(resolveConfig({}, { OPENROUTER_API_KEY: 'env', EVAL_OPENROUTER_API_KEY: 'eval' }).apiKey).toBe('env');
    expect(resolveConfig({ keepThreshold: 'nope' }, { JEV_CONTEXT_GATE_TOOLS: 'Read' })).toMatchObject({ keepThreshold: 0.5, gateTools: ['Read'] });
  });
});

describe('gate', () => {
  const options = { gateTools: ['Bash'], gateMinChars: 100, gateThreshold: 0.3, gateHeadChars: 20, gateTailChars: 10 };

  test('reads the output of a Bash or Read record', async () => {
    expect(outputOf('Bash', { stdout: 'out', stderr: 'err' })).toBe('out\nerr');
    expect(outputOf('Read', { type: 'text', file: { content: 'body' } })).toBe('body');
    expect(outputOf('Grep', { content: 'x' })).toBeUndefined();
    expect(outputOf('Grep', {}, 'text wins')).toBe('text wins');
  });

  test('cuts the middle of a Bash stdout and the tail of a Read', async () => {
    const stdout = 'a'.repeat(100) + 'b'.repeat(100);
    expect(cutOutput('short', 20, 10, 'hint')).toBe('short');
    const cut = cutResult('Bash', { stdout, stderr: '', interrupted: false }, options) as { stdout: string; stderr: string };
    expect(cut.stdout).toStartWith('a'.repeat(20));
    expect(cut.stdout).toEndWith('b'.repeat(10));
    expect(cut.stdout).toContain(`${GATE_NOTE_PREFIX} 170 chars`);
    expect(cut.stderr).toBe('');
    expect(cutResult('Bash', { stdout: 'tiny', stderr: '' }, options)).toBeUndefined();
    const read = cutResult(
      'Read',
      { type: 'text', file: { filePath: 'f', content: 'line\n'.repeat(40), numLines: 40, startLine: 1, totalLines: 40 } },
      options,
    ) as { file: { content: string; numLines: number } };
    expect(read.file.content).toStartWith('line\nline\n');
    expect(read.file.content).toContain('offset=7');
    expect(read.file.numLines).toBe(read.file.content.split('\n').length);
    expect(cutResult('Edit', { ok: true }, options)).toBeUndefined();
  });
});
