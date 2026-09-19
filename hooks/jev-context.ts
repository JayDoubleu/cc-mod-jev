import type {
  EngineInterface,
  PluginOptions,
  Register,
  SessionMessage,
  ToolCallResult,
} from 'claude-code';

import { compact, reductionRatio } from '../src/compact.ts';
import { describeConfig, resolveConfig, type Config } from '../src/config.ts';
import { cutResult, GATE_QUESTION, gateQuestions, gateState, outputOf } from '../src/gate.ts';
import { askerOver, type ClientConfig, type Transport } from '../src/openrouter.ts';
import { noulOf } from '../src/questions.ts';
import type { CompactResult } from '../src/types.ts';

const PLUGIN = 'jev-context';
const LOG_LINE_MAX_CHARS = 3800;

type LastCompaction = {
  trigger: string;
  outcome: 'pruned' | 'fallback' | 'skipped';
  reason?: string;
  summary?: string;
  decisions: string[];
};

type GateRecord = { tool: string; chars: number; need: number; cut: boolean };

/** What the hooks share across dispatches for one activation of the plugin. */
type Activation = {
  options: PluginOptions;
  config?: Config;
  last?: LastCompaction;
  gates: GateRecord[];
  compacting: boolean;
  skippedAtPercent: number;
};

/**
 * The engine prefixes every toast, log line and command answer with the
 * plugin's name, so the texts below carry none.
 */

/** One line per scored call: `t3:Bash:drop_call/call=0.12/result=0.08`. */
export function decisionLines(result: CompactResult): string[] {
  return result.decisions
    .filter((d) => d.action !== 'pinned' && d.action !== 'small')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    );
}

/** The decision lines joined into chunks a `$.ui.log` line can hold. */
export function chunkLines(lines: readonly string[], maxChars = LOG_LINE_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const joined = current ? `${current} ${line}` : line;
    if (current && joined.length > maxChars) {
      chunks.push(current);
      current = line;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function summarize(result: CompactResult): string {
  const s = result.stats;
  const percent = Math.round(reductionRatio(result) * 100);
  return (
    `${percent}% fewer chars (${s.charsBefore} to ${s.charsAfter}), ` +
    `${s.messagesAfter}/${s.messagesBefore} messages; ` +
    `${s.candidates} scored: ${s.kept} kept, ${s.truncated} truncated, ${s.dropped} dropped; ` +
    `${s.pinned} pinned, ${s.small} small; ` +
    `state ~${s.stateTokens} tokens (stage ${s.stateStage}); ` +
    `${s.requests} Jev request(s), ${s.jevInputTokens} input tokens, $${s.jevCostUsd.toFixed(5)}`
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The configuration, read once per activation: the plugin options, then the
 * environment (`$.env.get` takes literal names, so every variable the module
 * reads is listed here, one per `CONFIG_KEYS` entry and prefix), then the
 * `env` block of settings.json for the key.
 */
async function configOf($: EngineInterface, activation: Activation): Promise<Config> {
  if (activation.config) return activation.config;
  const values = await Promise.all([
    $.env.get('OPENROUTER_API_KEY'),
    $.env.get('EVAL_OPENROUTER_API_KEY'),
    $.env.get('JEV_CONTEXT_MODEL'),
    $.env.get('EVAL_JEV_CONTEXT_MODEL'),
    $.env.get('JEV_CONTEXT_BASE_URL'),
    $.env.get('EVAL_JEV_CONTEXT_BASE_URL'),
    $.env.get('JEV_CONTEXT_GOAL'),
    $.env.get('EVAL_JEV_CONTEXT_GOAL'),
    $.env.get('JEV_CONTEXT_KEEP_THRESHOLD'),
    $.env.get('EVAL_JEV_CONTEXT_KEEP_THRESHOLD'),
    $.env.get('JEV_CONTEXT_PRESERVE_RECENT_MESSAGES'),
    $.env.get('EVAL_JEV_CONTEXT_PRESERVE_RECENT_MESSAGES'),
    $.env.get('JEV_CONTEXT_MIN_PAIR_CHARS'),
    $.env.get('EVAL_JEV_CONTEXT_MIN_PAIR_CHARS'),
    $.env.get('JEV_CONTEXT_TRUNCATE_HEAD_CHARS'),
    $.env.get('EVAL_JEV_CONTEXT_TRUNCATE_HEAD_CHARS'),
    $.env.get('JEV_CONTEXT_MAX_STATE_TOKENS'),
    $.env.get('EVAL_JEV_CONTEXT_MAX_STATE_TOKENS'),
    $.env.get('JEV_CONTEXT_MAX_REQUEST_TOKENS'),
    $.env.get('EVAL_JEV_CONTEXT_MAX_REQUEST_TOKENS'),
    $.env.get('JEV_CONTEXT_COMPACT_AT_PERCENT'),
    $.env.get('EVAL_JEV_CONTEXT_COMPACT_AT_PERCENT'),
    $.env.get('JEV_CONTEXT_MIN_REDUCTION_RATIO'),
    $.env.get('EVAL_JEV_CONTEXT_MIN_REDUCTION_RATIO'),
    $.env.get('JEV_CONTEXT_GATE'),
    $.env.get('EVAL_JEV_CONTEXT_GATE'),
    $.env.get('JEV_CONTEXT_GATE_TOOLS'),
    $.env.get('EVAL_JEV_CONTEXT_GATE_TOOLS'),
    $.env.get('JEV_CONTEXT_GATE_MIN_CHARS'),
    $.env.get('EVAL_JEV_CONTEXT_GATE_MIN_CHARS'),
    $.env.get('JEV_CONTEXT_GATE_THRESHOLD'),
    $.env.get('EVAL_JEV_CONTEXT_GATE_THRESHOLD'),
    $.env.get('JEV_CONTEXT_GATE_HEAD_CHARS'),
    $.env.get('EVAL_JEV_CONTEXT_GATE_HEAD_CHARS'),
    $.env.get('JEV_CONTEXT_GATE_TAIL_CHARS'),
    $.env.get('EVAL_JEV_CONTEXT_GATE_TAIL_CHARS'),
    $.env.get('JEV_CONTEXT_LOG'),
    $.env.get('EVAL_JEV_CONTEXT_LOG'),
  ]);
  const env: Record<string, string | undefined> = {
    OPENROUTER_API_KEY: values[0],
    EVAL_OPENROUTER_API_KEY: values[1],
    JEV_CONTEXT_MODEL: values[2],
    EVAL_JEV_CONTEXT_MODEL: values[3],
    JEV_CONTEXT_BASE_URL: values[4],
    EVAL_JEV_CONTEXT_BASE_URL: values[5],
    JEV_CONTEXT_GOAL: values[6],
    EVAL_JEV_CONTEXT_GOAL: values[7],
    JEV_CONTEXT_KEEP_THRESHOLD: values[8],
    EVAL_JEV_CONTEXT_KEEP_THRESHOLD: values[9],
    JEV_CONTEXT_PRESERVE_RECENT_MESSAGES: values[10],
    EVAL_JEV_CONTEXT_PRESERVE_RECENT_MESSAGES: values[11],
    JEV_CONTEXT_MIN_PAIR_CHARS: values[12],
    EVAL_JEV_CONTEXT_MIN_PAIR_CHARS: values[13],
    JEV_CONTEXT_TRUNCATE_HEAD_CHARS: values[14],
    EVAL_JEV_CONTEXT_TRUNCATE_HEAD_CHARS: values[15],
    JEV_CONTEXT_MAX_STATE_TOKENS: values[16],
    EVAL_JEV_CONTEXT_MAX_STATE_TOKENS: values[17],
    JEV_CONTEXT_MAX_REQUEST_TOKENS: values[18],
    EVAL_JEV_CONTEXT_MAX_REQUEST_TOKENS: values[19],
    JEV_CONTEXT_COMPACT_AT_PERCENT: values[20],
    EVAL_JEV_CONTEXT_COMPACT_AT_PERCENT: values[21],
    JEV_CONTEXT_MIN_REDUCTION_RATIO: values[22],
    EVAL_JEV_CONTEXT_MIN_REDUCTION_RATIO: values[23],
    JEV_CONTEXT_GATE: values[24],
    EVAL_JEV_CONTEXT_GATE: values[25],
    JEV_CONTEXT_GATE_TOOLS: values[26],
    EVAL_JEV_CONTEXT_GATE_TOOLS: values[27],
    JEV_CONTEXT_GATE_MIN_CHARS: values[28],
    EVAL_JEV_CONTEXT_GATE_MIN_CHARS: values[29],
    JEV_CONTEXT_GATE_THRESHOLD: values[30],
    EVAL_JEV_CONTEXT_GATE_THRESHOLD: values[31],
    JEV_CONTEXT_GATE_HEAD_CHARS: values[32],
    EVAL_JEV_CONTEXT_GATE_HEAD_CHARS: values[33],
    JEV_CONTEXT_GATE_TAIL_CHARS: values[34],
    EVAL_JEV_CONTEXT_GATE_TAIL_CHARS: values[35],
    JEV_CONTEXT_LOG: values[36],
    EVAL_JEV_CONTEXT_LOG: values[37],
  };
  if (!env.OPENROUTER_API_KEY && !env.EVAL_OPENROUTER_API_KEY && !activation.options.apiKey) {
    const settings = await $.settings.read();
    const block = settings['env'];
    if (block && typeof block === 'object') {
      const value = (block as Record<string, unknown>)['OPENROUTER_API_KEY'];
      if (typeof value === 'string' && value) env.OPENROUTER_API_KEY = value;
    }
  }
  activation.config = resolveConfig(activation.options, env);
  return activation.config;
}

function clientOf(config: Config): ClientConfig {
  return { apiKey: config.apiKey ?? '', model: config.model, baseUrl: config.baseUrl };
}

/** A transport over the engine's `$.http.fetch`. */
function transportOf($: EngineInterface): Transport {
  return async (url, init) => {
    const response = await $.http.fetch(url, init);
    return { status: response.status, ok: response.ok, text: response.text };
  };
}

async function log($: EngineInterface, config: Config, text: string): Promise<void> {
  await $.ui.log(text, { to: config.log });
}

/** Records a compaction the plugin did not do and says why. */
async function noteFallback(
  $: EngineInterface,
  activation: Activation,
  config: Config,
  trigger: string,
  reason: string,
): Promise<void> {
  const pluginTriggered = trigger === 'plugin';
  activation.last = {
    trigger,
    outcome: pluginTriggered ? 'skipped' : 'fallback',
    reason,
    decisions: [],
  };
  await log(
    $,
    config,
    pluginTriggered ? `compaction skipped: ${reason}` : `built-in summary used: ${reason}`,
  );
}

/** The `/jev` status text. */
function statusText(activation: Activation, config: Config): string {
  const lines = [describeConfig(config)];
  const last = activation.last;
  if (last) {
    lines.push(`last compaction (${last.trigger}): ${last.outcome}${last.reason ? `, ${last.reason}` : ''}`);
    if (last.summary) lines.push(last.summary);
    for (const line of last.decisions) lines.push(`  ${line}`);
  } else {
    lines.push('no compaction yet this session; /compact runs a Jev-scored one');
  }
  if (activation.gates.length > 0) {
    lines.push('gate decisions:');
    for (const gate of activation.gates) {
      lines.push(
        `  ${gate.tool} ${gate.chars} chars: P(need full)=${gate.need.toFixed(2)}, ${gate.cut ? 'cut' : 'kept'}`,
      );
    }
  }
  return lines.join('\n');
}

export const register: Register = (on, options) => {
  const activation: Activation = {
    options,
    gates: [],
    compacting: false,
    skippedAtPercent: -1,
  };

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jev',
      description:
        'jev-context: configuration, last compaction and gate decisions; /compact prunes now',
    });
    return next(e);
  });

  on('session.compact', { trigger: 'precompute' }, () => ({
    skip: `${PLUGIN} prunes at compaction time`,
  }));

  on('session.compact', async ($, e, next) => {
    const config = await configOf($, activation);
    const pluginTriggered = e.trigger === 'plugin';
    let reason: string | undefined;
    if (!config.apiKey) {
      reason = 'no OpenRouter key: set OPENROUTER_API_KEY or the apiKey plugin option';
    } else {
      try {
        const result = await compact(e.messages, askerOver(transportOf($), clientOf(config)), config);
        const ratio = reductionRatio(result);
        const summary = summarize(result);
        const lines = decisionLines(result);
        for (const chunk of chunkLines(lines)) {
          await $.ui.log(`decisions: ${chunk}`, { to: 'debug' });
        }
        if (ratio >= config.minReductionRatio) {
          activation.last = { trigger: e.trigger, outcome: 'pruned', summary, decisions: lines };
          activation.skippedAtPercent = -1;
          await log($, config, `pruned verbatim, no summary: ${summary}`);
          await $.ui.toast(
            `kept ${result.messages.length}/${e.messages.length} messages verbatim, ${Math.round(ratio * 100)}% fewer chars`,
            { timeoutMs: 8000 },
          );
          return { messages: result.messages as SessionMessage[] };
        }
        reason = `reduction ${Math.round(ratio * 100)}% is below the ${Math.round(config.minReductionRatio * 100)}% minimum (${summary})`;
      } catch (error) {
        reason = errorText(error);
      }
    }
    await noteFallback($, activation, config, e.trigger, reason);
    if (pluginTriggered) return { skip: `${PLUGIN}: ${reason}` };
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId || activation.compacting) return next(e);
    const config = await configOf($, activation);
    if (config.compactAtPercent <= 0 || !config.apiKey) return next(e);
    try {
      const usage = await $.session.usage();
      const percent = usage.context.percent ?? 0;
      if (percent < config.compactAtPercent) return next(e);
      if (activation.skippedAtPercent >= 0 && percent < activation.skippedAtPercent + 10) {
        return next(e);
      }
      activation.compacting = true;
      try {
        const outcome = await $.session.compact();
        if (outcome.skip !== undefined) activation.skippedAtPercent = percent;
      } finally {
        activation.compacting = false;
      }
    } catch (error) {
      await log($, config, `auto-compaction failed: ${errorText(error)}`);
    }
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    const outcome = await next(e);
    if (e.agentId !== undefined) return outcome;
    const config = await configOf($, activation);
    if (!config.gate || !config.apiKey || !config.gateTools.includes(e.tool)) return outcome;
    if (outcome.deny !== undefined || outcome.isError) return outcome;
    const output = outputOf(e.tool, outcome.result);
    if (!output || output.length < config.gateMinChars) return outcome;
    if (output.length <= config.gateHeadChars + config.gateTailChars) return outcome;
    try {
      const {
        tool: _tool,
        tool_use_id: _id,
        agentId: _agent,
        consent: _consent,
        ...input
      } = e as Record<string, unknown>;
      const recent = await $.session.messages();
      const state = gateState(recent, e.tool, input, output, config, config.goal);
      const response = await askerOver(transportOf($), clientOf(config)).ask(state, gateQuestions());
      const need = noulOf(response.answers, GATE_QUESTION);
      const result = need < config.gateThreshold ? cutResult(e.tool, outcome.result, config) : undefined;
      const cut = result !== undefined;
      activation.gates.push({ tool: e.tool, chars: output.length, need, cut });
      if (activation.gates.length > 20) activation.gates.shift();
      await log(
        $,
        config,
        `gate ${e.tool} ${output.length} chars: P(need full)=${need.toFixed(2)}, ${cut ? 'cut' : 'kept'}`,
      );
      if (!cut) return outcome;
      const answer: ToolCallResult = { result } as ToolCallResult;
      if (outcome.context !== undefined) answer.context = outcome.context;
      return answer;
    } catch (error) {
      await log($, config, `gate skipped: ${errorText(error)}`);
      return outcome;
    }
  });

  on('command.run', { command: 'jev' }, async ($) => {
    const config = await configOf($, activation);
    return { text: statusText(activation, config) };
  });
};
