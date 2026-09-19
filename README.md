# jev-context

A Claude Code mod that prunes the context window with TypeSafe's Jev decision
model, called through OpenRouter. At compaction, every tool call and result in
the transcript is scored in one fast Jev request. Stale results are truncated,
stale calls are dropped, and everything kept stays verbatim. No summary is
written. An optional gate asks Jev about each oversized tool output as it
arrives and cuts the middle when the full output is not needed.

Jev is a "System One" model: it takes a state plus typed questions and returns
probabilities, in about 300 ms, at $0.042 per million input tokens. One
compaction of a long session costs well under a cent.

## Requirements

- Claude Code 2.1.278 or later with function hooks enabled:
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Function hooks (mods) are early
  access and the API may change between releases.
- An OpenRouter API key in `OPENROUTER_API_KEY`, or the `apiKey` plugin option.

## Install

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
export OPENROUTER_API_KEY="sk-or-..."

claude plugin marketplace add JayDoubleu/cc-mod-jev
claude plugin install jev-context@cc-mod-jev
```

To run from a checkout instead:

```sh
claude --plugin-dir /path/to/cc-mod-jev
```

Both variables can also live in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "OPENROUTER_API_KEY": "sk-or-..." } }
```

## What it does

`hooks/jev-context.ts` registers four hooks:

- `session.compact`: `/compact`, the engine's auto-compaction and the plugin's
  own trigger all pass through here. The transcript is scored by Jev and the
  pruned messages are returned in place of a summary. If the key is missing,
  Jev fails, or the pruning would remove less than `minReductionRatio` of the
  transcript's characters, `/compact` and auto-compaction fall back to the
  built-in summary. A plugin-triggered compaction is skipped instead.
- `turn.complete`: after each main-loop turn, if the context window is at
  least `compactAtPercent` full, the plugin requests a compaction. After a
  skip it waits until the window grew 10 more points before trying again.
- `tool.call` (the gate, off by default): after a gated tool returns an output
  of at least `gateMinChars`, Jev is asked whether the model needs the full
  output. Below `gateThreshold`, Bash keeps the head and tail of stdout, and
  Read keeps the head of the file, each with a note saying what was cut and
  how to get it back.
- `command.run`: `/jev` prints the configuration, the last compaction and its
  per-call decisions, and the gate decisions. `/compact` prunes now, since it
  goes through the `session.compact` hook.

### How a compaction is scored

1. Every `tool_use` is paired with its `tool_result`. Calls in the first
   message, in the newest `preserveRecentMessages` messages, or still in
   flight are pinned. Pairs smaller than 300 characters are kept without a
   question.
2. The state sent to Jev is the goal (the last three user prompts) and the
   whole conversation oldest first: texts abridged, tool inputs truncated,
   every tool result replaced by `ok, 4213 chars` plus a short head. The
   state is fitted into `maxStateTokens` (20k) in five stages, from full
   detail down to one line per call. If it still does not fit, the hook
   falls back.
3. For every candidate, two `noul` questions: should the call stay, and
   should its full output stay verbatim. Questions are batched so that state
   plus questions stays under `maxRequestTokens` (28k, under Jev's 32k
   window); batches run concurrently.
4. Against `keepThreshold`: result probability at or above it keeps the pair;
   else call probability at or above it keeps the call and truncates the
   result to `truncateHeadChars` plus a note; else the pair is removed.
5. Untouched messages go back as the engine's own objects. A message that
   loses all its content disappears. No result is left without its call.

## Configuration

Plugin options (set at install, or in `settings.json` under
`pluginConfigs["jev-context"].options`):

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | unset | OpenRouter key; else `OPENROUTER_API_KEY` |
| `model` | `typesafe/jev-1.13` | Model id on OpenRouter's decisions endpoint |
| `keepThreshold` | `0.5` | Minimum probability to keep a call or its result |
| `preserveRecentMessages` | `6` | Newest messages never pruned |
| `compactAtPercent` | `60` | Context percent at which the plugin requests a compaction; `0` disables |
| `minReductionRatio` | `0.2` | Pruning must remove this fraction of characters, else fall back or skip |
| `truncateHeadChars` | `300` | Head kept of a truncated result |
| `gate` | `false` | Gate oversized tool outputs |
| `gateTools` | `Bash` | Comma-separated tools the gate applies to (`Bash`, `Read`) |
| `gateMinChars` | `8000` | Outputs shorter than this are never gated |
| `gateThreshold` | `0.3` | Cut only when P(full output needed) is below this |
| `log` | `transcript` | `transcript` shows one dim line per decision in the session; `debug` keeps it to the debug log |

Every option except `apiKey` can be overridden by an environment variable
named `JEV_CONTEXT_<OPTION>` in upper snake case, and again by
`EVAL_JEV_CONTEXT_<OPTION>`, which plugin evals can pass to a run. Examples:
`JEV_CONTEXT_GATE=1`, `JEV_CONTEXT_GATE_TOOLS=Bash,Read`,
`JEV_CONTEXT_KEEP_THRESHOLD=0.4`. Under an eval the key is read from
`EVAL_OPENROUTER_API_KEY`.

## Development

```sh
npm install                 # TypeScript for the typecheck only; the mod has no runtime dependencies
npm run typecheck           # tsc over hooks, src and tests against .claude/types
npm run validate            # claude plugin validate .
npm test                    # claude plugin test . (28 tests, a fake OpenRouter beneath the plugin)
npm run types               # regenerate .claude/types/claude-code.d.ts after a Claude Code update
bun run scripts/smoke.ts    # one live compaction against OpenRouter; needs OPENROUTER_API_KEY
```

The library under `src/` is plain TypeScript with no imports outside the
plugin, because a hooks module runs in Claude Code's own runtime with no Node
and no `node_modules`. `hooks/jev-context.ts` is the thin adapter.

Constraints the hooks loader enforces, found the hard way:

- `$` may only be passed to functions declared at the top of the module, never
  to a closure inside `register`.
- `$.env.get` takes a literal variable name, so every variable the module
  reads is spelled out in `configOf`.

### Evals

```sh
export EVAL_OPENROUTER_API_KEY="sk-or-..."
npm run eval                # claude plugin eval . --trust-plugin
```

Two cases under `evals/`, both driven by `/jev`, so a run costs no model call
in the with-arm:

- `jev-status`: a regex grader checks the status line.
- `env-passthrough`: the case sets `EVAL_JEV_CONTEXT_*` variables; the grader
  checks that the key and the options reached the mod.

The without-arm runs the same prompts with no plugin, where `/jev` is an
unknown command, so `Δ` is positive when the mod loads.

What the evals cannot see: inside a `claude plugin eval` child session of
Claude Code 2.1.278, a `tool.call` hook's own `{ result }` is not what the
model reads. The gate ran and Jev answered, but the trace, the child's
transcript and the token counts all showed the full output. The same headless
run outside the harness (`--permission-mode dontAsk`, sandbox on) shows the
cut in both the stream and the transcript. A compaction cannot be driven from
an eval prompt either: `$.session.compact()` is refused from a `command.run`
hook, and a fresh session has nothing to prune. So the gate and the pruning
are verified by `claude plugin test` and by two live scripts:

```sh
scripts/gate-smoke.sh       # one headless session; checks the stream for the cut note
bun run scripts/smoke.ts    # one live compaction; prints decisions, tokens and cost
npm run smoke               # both
```

## Limitations

- Only tool calls and results are pruned. User and assistant text is never
  removed or shortened.
- The state Jev sees is abridged to fit 20k tokens, so decisions on a very
  long session are made from a coarse view. Token sizes are estimated from
  character counts.
- A probability is not a proof that a result is safe to delete. The model can
  re-run a tool, and the truncation notes say so.
- The gate predicts what the model will need before the model has read the
  output. Keep it off for tools where the middle of the output is the point.
- Subagent transcripts are pruned when the engine compacts them, but the
  plugin only triggers compactions for the main loop.

## Related work

- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction):
  the first Jev-guided compaction mod for Claude Code, against TypeSafe's own
  API. This plugin follows the same verbatim-pruning idea, adds the OpenRouter
  transport, the gate, the `/jev` command, and an eval suite.
- [jev-compactor](https://github.com/edwardyen724-g/jev-compactor): the same
  idea as a library and MCP server for other agent frameworks.
- [TypeSafe docs](https://docs.typesafe.ai/) and the
  [OpenRouter decisions endpoint](https://openrouter.ai/typesafe).
