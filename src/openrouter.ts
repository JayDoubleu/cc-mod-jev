import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.ts';

export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_MODEL = 'typesafe/jev-1.13';

export type JevRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
};

export type TransportResponse = { status: number; ok: boolean; text: string };

/** The shape of `$.http.fetch`, so the client runs over the engine or a fake. */
export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TransportResponse>;

export type ClientConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
};

/** The HTTP request for one Jev call on OpenRouter's decisions endpoint. */
export function buildRequest(
  config: ClientConfig,
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: config.baseUrl ?? OPENROUTER_DECISIONS_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      'x-title': 'jev-context (Claude Code mod)',
    },
    body: JSON.stringify({ model: config.model ?? DEFAULT_MODEL, state, questions }),
  };
}

/** Validates a response body; throws on anything but an `answers` object. */
export function parseResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** A `JevAsker` over any transport. */
export function askerOver(transport: Transport, config: ClientConfig): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildRequest(config, state, questions);
      const response = await transport(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseResponse(response.status, response.ok, response.text);
    },
  };
}
