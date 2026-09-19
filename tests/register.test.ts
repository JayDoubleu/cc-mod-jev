import { describe, expect, mock, test } from 'claude-code/testing';
import type { On, SessionMessage } from 'claude-code';

import { GATE_NOTE_PREFIX } from '../src/gate.ts';

function user(text: string, handle: string): SessionMessage {
  return { role: 'user', text, toolUses: [], handle };
}

function assistant(text: string, handle: string): SessionMessage {
  return { role: 'assistant', text, toolUses: [], handle };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text }], handle: `use-${id}` };
}

function result(id: string, text: string, isError = false): SessionMessage {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }], handle: `res-${id}` };
}

const FILE_A = 'export const a = 1;\n'.repeat(60);
const FAIL = 'FAIL src/a.test.ts: expected 3 got 2\n'.repeat(12);
const PASS = 'PASS 12 tests\n'.repeat(30);

function transcript(): SessionMessage[] {
  return [
    user('Fix the failing test.', 'h0'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, FILE_A),
    result('tool-1', FILE_A),
    call('tool-2', 'Bash', { command: 'npm test' }, FAIL),
    result('tool-2', FAIL, true),
    assistant('Fixing now.', 'h5'),
    user('go ahead', 'h6'),
    call('tool-3', 'Edit', { file_path: 'src/a.ts', old_string: 'i < n', new_string: 'i <= n' }, 'ok'),
    result('tool-3', 'ok'),
    call('tool-4', 'Bash', { command: 'npm test' }, PASS),
    result('tool-4', PASS),
    assistant('Done.', 'h11'),
  ];
}

const SUMMARY: SessionMessage = { role: 'user', text: 'built-in summary', toolUses: [] };

type World = {
  logs: string[];
  toasts: string[];
  requests: { url: string; body: Record<string, unknown> }[];
  coreCompactions: string[];
};

type WorldOptions = {
  key?: boolean;
  env?: Record<string, string>;
  answer?: (name: string) => number;
  status?: number;
  percent?: number;
  messages?: SessionMessage[];
};

/** The world beneath the plugin: env, store, clock, a fake OpenRouter, a core compaction. */
function world(on: On, options: WorldOptions = {}): World {
  const w: World = { logs: [], toasts: [], requests: [], coreCompactions: [] };
  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (options.key !== false) env.OPENROUTER_API_KEY = 'sk-or-test';
  mock.env(on, env);
  mock.store(on);
  mock.clock(on);
  on('settings.read', () => ({ value: {} }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('ui.log', ($, e) => {
    w.logs.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text);
    return { value: undefined };
  });
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>;
    w.requests.push({ url: e.url, body });
    const status = options.status ?? 200;
    if (status !== 200) return { value: { status, ok: false, headers: {}, text: 'boom' } };
    const questions = (body.questions ?? {}) as Record<string, unknown>;
    const answers = Object.fromEntries(
      Object.keys(questions).map((name) => [name, { type: 'noul', noul: (options.answer ?? (() => 0.9))(name) }]),
    );
    const text = JSON.stringify({ model: 'typesafe/jev-1.13', answers, usage: { input_tokens: 700, output_tokens: 20, cost: 0.00003 } });
    return { value: { status: 200, ok: true, headers: {}, text } };
  });
  on('session.compact', ($, e) => {
    w.coreCompactions.push(e.trigger);
    return { messages: [SUMMARY, ...e.messages.slice(-2)] };
  });
  on('session.usage', () => ({
    value: { context: { window: 200000, tokens: 1000, percent: options.percent ?? 10 }, rateLimits: [] },
  }));
  on('session.messages', () => ({ value: options.messages ?? [] }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('turn.complete', ($, e) => ({ text: e.answer }));
  return w;
}

describe('register', () => {
  test('/compact prunes verbatim and returns the engine messages it kept', async ($, on) => {
    const w = world(on, { answer: (name) => (name.endsWith('_t1') ? 0.1 : name === 'result_t2' ? 0.2 : 0.9) });
    const messages = transcript();

    const out = await $.session.compact({ trigger: 'manual', messages });

    expect(w.coreCompactions).toEqual([]);
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(w.requests[0]?.body.model).toBe('typesafe/jev-1.13');
    expect(out.skip).toBeUndefined();
    const kept = out.messages!;
    expect(kept).toHaveLength(messages.length - 2);
    expect(kept[0]).toEqual(messages[0]);
    expect(kept[1]).toEqual(messages[3]);
    expect(kept[1]?.handle).toBe('use-tool-2');
    expect(kept[2]?.handle).toBeUndefined();
    expect(kept[2]?.toolResults?.[0]?.text).toContain('[jev-context removed');
    expect(kept[kept.length - 1]).toEqual(messages[11]);
    expect(kept.map((m) => m.handle)).toEqual([
      'h0', 'use-tool-2', undefined, 'h5', 'h6', 'use-tool-3', 'res-tool-3', 'use-tool-4', 'res-tool-4', 'h11',
    ]);
    expect(w.toasts[0]).toContain('kept 10/12 messages verbatim');
    expect(w.logs.some((line) => line.includes('pruned verbatim, no summary'))).toBe(true);
  });

  test('without a key the built-in summary runs', async ($, on) => {
    const w = world(on, { key: false });

    const out = await $.session.compact({ trigger: 'auto', messages: transcript() });

    expect(w.requests).toEqual([]);
    expect(w.coreCompactions).toEqual(['auto']);
    expect(out.messages?.[0]).toEqual(SUMMARY);
    expect(w.logs[0]).toContain('no OpenRouter key');
  });

  test('a reduction below the minimum falls back to the built-in summary', async ($, on) => {
    const w = world(on, { answer: () => 0.9 });

    const out = await $.session.compact({ trigger: 'manual', messages: transcript() });

    expect(w.coreCompactions).toEqual(['manual']);
    expect(out.messages?.[0]).toEqual(SUMMARY);
    expect(w.logs.some((line) => line.includes('below the 20% minimum'))).toBe(true);
  });

  test('a plugin-triggered compaction that would not reduce enough is skipped, not summarised', async ($, on) => {
    const w = world(on, { answer: () => 0.9 });

    const out = await $.session.compact({ trigger: 'plugin', messages: transcript() });

    expect(w.coreCompactions).toEqual([]);
    expect(out.skip).toContain('jev-context');
  });

  test('a Jev failure falls back to the built-in summary', async ($, on) => {
    const w = world(on, { status: 500 });

    const out = await $.session.compact({ trigger: 'manual', messages: transcript() });

    expect(w.coreCompactions).toEqual(['manual']);
    expect(out.messages?.[0]).toEqual(SUMMARY);
    expect(w.logs.some((line) => line.includes('500'))).toBe(true);
  });

  test('turn.complete requests a compaction once the context is full enough', async ($, on) => {
    const w = world(on, { percent: 70 });

    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' });

    expect(w.logs.some((line) => /compaction skipped|built-in summary used/.test(line))).toBe(true);
  });

  test('turn.complete leaves a half-empty context alone', async ($, on) => {
    const w = world(on, { percent: 30 });

    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' });

    expect(w.logs).toEqual([]);
    expect(w.requests).toEqual([]);
  });

  test('the gate cuts a bulk Bash output when Jev says the full output is not needed', async ($, on) => {
    const w = world(on, {
      env: { JEV_CONTEXT_GATE: '1', JEV_CONTEXT_GATE_MIN_CHARS: '1000' },
      answer: () => 0.05,
      messages: [user('list everything', 'h0')],
    });
    const stdout = 'line\n'.repeat(4000);
    on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false } }));

    const out = await $.tool.call({ tool: 'Bash', command: 'seq 1 4000' });

    expect(w.requests).toHaveLength(1);
    expect(JSON.stringify(w.requests[0]?.body.state)).toContain('"tool":"Bash"');
    expect(JSON.stringify(w.requests[0]?.body.state)).toContain('list everything');
    const record = out.result as { stdout: string };
    expect(record.stdout.length).toBeLessThan(stdout.length);
    expect(record.stdout).toContain(GATE_NOTE_PREFIX);
    expect(w.logs[0]).toContain('P(need full)=0.05, cut');
  });

  test('the gate keeps an output Jev says is needed, and is off by default', async ($, on) => {
    const stdout = 'line\n'.repeat(4000);
    const w = world(on, { env: { JEV_CONTEXT_GATE: 'on', JEV_CONTEXT_GATE_MIN_CHARS: '1000' }, answer: () => 0.95 });
    on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false } }));

    const kept = await $.tool.call({ tool: 'Bash', command: 'cat big.txt' });

    expect((kept.result as { stdout: string }).stdout).toBe(stdout);
    expect(w.logs[0]).toContain('kept');
  });

  test('the gate is off by default', async ($, on) => {
    const w = world(on);
    const stdout = 'line\n'.repeat(4000);
    on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false } }));

    const out = await $.tool.call({ tool: 'Bash', command: 'seq 1 4000' });

    expect((out.result as { stdout: string }).stdout).toBe(stdout);
    expect(w.requests).toEqual([]);
  });

  test('/jev prints the configuration and the last decisions', async ($, on) => {
    world(on, { answer: (name) => (name.endsWith('_t1') ? 0.1 : 0.9) });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });

    const before = await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
    expect(before.text).toContain('jev-context model=typesafe/jev-1.13 key=set');
    expect(before.text).toContain('no compaction yet');

    await $.session.compact({ trigger: 'manual', messages: transcript() });
    const after = await $.command.run({ command: 'jev', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } });
    expect(after.text).toContain('last compaction (manual): pruned');
    expect(after.text).toContain('t1:Read:drop_call/call=0.10/result=0.10');
  });
});
