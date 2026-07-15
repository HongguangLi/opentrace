// Map OTLP log events into spans. Some agents (notably Claude Code) emit
// their telemetry as log events rather than spans: each api_request event
// carries model, token counts, cost, and duration as attributes. We
// synthesize one span per relevant event so log-only agents show up in the
// same Traces / Observations / Sessions / Models views as everything else.
import crypto from 'node:crypto';
import { extractSessionId, extractUserId } from './semantics.js';

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function classify(name, attrs) {
  const n = String(name).toLowerCase();
  if (/api_error/.test(n)) return { type: 'llm', error: true };
  if (/api_request/.test(n)) return { type: 'llm', error: false };
  if (/tool/.test(n)) return { type: 'tool', error: false };
  if (/prompt/.test(n)) return { type: 'agent', error: false };
  // Fall back on the shape of the attributes.
  if (attrs.model && (attrs.input_tokens != null || attrs.output_tokens != null)) {
    return { type: 'llm', error: false };
  }
  return { type: 'other', error: false };
}

/**
 * Convert one normalized OTLP log event into a span record with semantics
 * already attached, or null to skip events that carry no useful signal.
 */
export function logEventToSpan(ev) {
  const a = ev.attributes ?? {};
  const name = ev.name || a['event.name'] || 'log';
  const { type, error } = classify(name, a);

  const model = a.model ?? a['gen_ai.request.model'] ?? null;
  const promptTokens = num(a.input_tokens ?? a['gen_ai.usage.input_tokens']);
  const completionTokens = num(a.output_tokens ?? a['gen_ai.usage.output_tokens']);
  // Skip pure noise: an event that is neither an LLM/tool/prompt signal nor
  // carries any measurable data isn't worth a span.
  if (type === 'other' && model === null && promptTokens === null) return null;

  const startNs = ev.timeNs ?? 0n;
  const durMs = num(a.duration_ms) ?? 0;
  const endNs = startNs + BigInt(Math.round(durMs * 1e6));

  // Prompt content only present when the agent is configured to log it.
  const inputText = a.prompt ?? a['gen_ai.prompt'] ?? null;

  const semantics = {
    spanType: type,
    model: model ? String(model) : null,
    inputText: inputText ? String(inputText) : null,
    outputText: null,
    promptTokens,
    completionTokens,
    totalTokens:
      promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null,
    costUsd: num(a.cost_usd),
    sessionId: extractSessionId(a),
    userId: extractUserId(a, inputText),
  };

  // Claude Code labels its events with a "claude_code." prefix; surface a
  // clean span name (e.g. "api_request") while keeping the raw one in attrs.
  const shortName = String(name).replace(/^claude_code\./, '');

  return {
    // Each event is its own trace; the Sessions view reunites them by session.
    traceId: ev.traceId || crypto.randomBytes(16).toString('hex'),
    spanId: ev.spanId || crypto.randomBytes(8).toString('hex'),
    parentSpanId: '',
    name: model ? `${shortName} ${model}` : shortName,
    kind: 'CLIENT',
    service: ev.service ?? 'unknown',
    scope: ev.scope ?? 'otlp-logs',
    startNs,
    endNs,
    durationMs: durMs,
    statusCode: error ? 'ERROR' : 'OK',
    statusMessage: error ? String(a.error ?? a.status_code ?? 'error') : '',
    attributes: a,
    resource: ev.resource ?? {},
    events: [],
    semantics,
  };
}
