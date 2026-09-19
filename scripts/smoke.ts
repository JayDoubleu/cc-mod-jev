/**
 * Live check against OpenRouter: prunes a synthetic transcript with the real
 * Jev and prints the decisions, the estimated versus reported state tokens
 * and the cost. Run: `bun run scripts/smoke.ts` with OPENROUTER_API_KEY set.
 */
import { compact, reductionRatio } from '../src/compact.ts';
import { askerOver } from '../src/openrouter.ts';
import { estimateTokens } from '../src/tokens.ts';
import type { Message } from '../src/types.ts';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input, text }] };
}
function result(id: string, text: string, isError = false): Message {
  return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError }] };
}

const readme = '# project\n\nThis project parses CSV files.\n'.repeat(120);
const parser = 'export function parse(s: string) {\n  for (let i = 0; i < n; i++) {}\n}\n'.repeat(40);
const fail = 'FAIL src/parser.test.ts\n  expected 3 got 2\n    at parse (src/parser.ts:42:7)\n'.repeat(15);
const install = 'npm WARN deprecated foo@1.0.0\nadded 412 packages in 9s\n'.repeat(60);
const pass = 'PASS src/parser.test.ts (12 tests)\n'.repeat(20);

const messages: Message[] = [
  { role: 'user', text: 'Fix the failing test in src/parser.test.ts. Never edit src/generated.ts.', toolUses: [] },
  call('t-readme', 'Read', { file_path: 'README.md' }, readme),
  result('t-readme', readme),
  call('t-install', 'Bash', { command: 'npm install' }, install),
  result('t-install', install),
  call('t-parser', 'Read', { file_path: 'src/parser.ts' }, parser),
  result('t-parser', parser),
  call('t-test1', 'Bash', { command: 'npm test' }, fail),
  result('t-test1', fail, true),
  { role: 'assistant', text: 'The loop bound at parser.ts:42 is off by one. I will change `i < n` to `i <= n`.', toolUses: [] },
  { role: 'user', text: 'ok do it', toolUses: [] },
  call('t-edit', 'Edit', { file_path: 'src/parser.ts', old_string: 'i < n', new_string: 'i <= n' }, 'ok'),
  result('t-edit', 'The file src/parser.ts has been updated.'),
  call('t-test2', 'Bash', { command: 'npm test' }, pass),
  result('t-test2', pass),
  { role: 'assistant', text: 'Done. All 12 tests pass.', toolUses: [] },
  { role: 'user', text: 'Now add a test for empty input.', toolUses: [] },
];

const transport = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
  const started = Date.now();
  const response = await fetch(url, init);
  const text = await response.text();
  console.log(`${init.method} ${url} -> ${response.status} in ${Date.now() - started} ms, body ${init.body.length} chars (~${estimateTokens(init.body)} tokens est)`);
  return { status: response.status, ok: response.ok, text };
};

const out = await compact(messages, askerOver(transport, { apiKey }), { preserveRecentMessages: 2, minPairChars: 100 });
for (const d of out.decisions) console.log(`${d.id.padEnd(4)} ${d.tool.padEnd(5)} ${d.action.padEnd(16)} call=${d.keepCall.toFixed(2)} result=${d.keepResult.toFixed(2)} chars=${d.chars}`);
console.log(`reduction ${Math.round(reductionRatio(out) * 100)}%: ${out.stats.charsBefore} -> ${out.stats.charsAfter} chars, ${out.stats.messagesBefore} -> ${out.stats.messagesAfter} messages`);
console.log(`state est ${out.stats.stateTokens} tokens (stage ${out.stats.stateStage}); Jev reported ${out.stats.jevInputTokens} input tokens over ${out.stats.requests} request(s); cost $${out.stats.jevCostUsd.toFixed(6)}`);
