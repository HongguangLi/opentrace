// Semantic-convention extraction: agents speak different OTLP dialects, so
// this module maps OpenTelemetry GenAI (`gen_ai.*`), OpenInference (`llm.*`,
// `input.value`), and NVIDIA NeMo Relay (`nemo_relay.*`) attributes onto one
// unified record so the dashboard can always show model, input/output, and
// token usage regardless of which agent produced the span.

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function asNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const parts = [];
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const role = msg.role ?? msg['message.role'] ?? '';
    let content = msg.content ?? msg['message.content'] ?? '';
    if (Array.isArray(content)) {
      content = content
        .map((c) => (typeof c === 'string' ? c : c?.text ?? c?.content ?? JSON.stringify(c)))
        .join('\n');
    } else if (typeof content === 'object' && content !== null) {
      content = JSON.stringify(content);
    }
    if (role || content) parts.push(role ? `[${role}] ${content}` : String(content));
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// OpenInference flattens lists into indexed keys, e.g.
// `llm.input_messages.0.message.role`; rebuild them into message arrays.
function collectIndexedMessages(attributes, prefix) {
  const byIndex = new Map();
  const re = new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.(\\d+)\\.message\\.(role|content)$`);
  for (const [key, value] of Object.entries(attributes)) {
    const match = re.exec(key);
    if (!match) continue;
    const idx = Number(match[1]);
    if (!byIndex.has(idx)) byIndex.set(idx, {});
    byIndex.get(idx)[match[2]] = value;
  }
  if (byIndex.size === 0) return null;
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, msg]) => msg);
}

function extractGenAi(attrs, events) {
  const out = {};
  out.model = firstDefined(attrs['gen_ai.response.model'], attrs['gen_ai.request.model']);
  out.promptTokens = asNumber(
    firstDefined(attrs['gen_ai.usage.input_tokens'], attrs['gen_ai.usage.prompt_tokens']),
  );
  out.completionTokens = asNumber(
    firstDefined(attrs['gen_ai.usage.output_tokens'], attrs['gen_ai.usage.completion_tokens']),
  );
  out.inputText = firstDefined(attrs['gen_ai.prompt'], attrs['gen_ai.input.messages']);
  out.outputText = firstDefined(attrs['gen_ai.completion'], attrs['gen_ai.output.messages']);

  // Newer semconv moves content onto span events (gen_ai.user.message etc.).
  if (!out.inputText || !out.outputText) {
    const inputs = [];
    const outputs = [];
    for (const ev of events ?? []) {
      const content = ev.attributes?.['gen_ai.event.content'] ?? ev.attributes?.content;
      if (!content) continue;
      if (ev.name === 'gen_ai.choice' || ev.name === 'gen_ai.assistant.message') {
        outputs.push(String(content));
      } else if (ev.name.startsWith('gen_ai.')) {
        inputs.push(String(content));
      }
    }
    out.inputText ??= inputs.length > 0 ? inputs.join('\n\n') : null;
    out.outputText ??= outputs.length > 0 ? outputs.join('\n\n') : null;
  }
  if (attrs['gen_ai.operation.name'] || out.model || out.promptTokens !== null) {
    out.spanType = attrs['gen_ai.tool.name'] ? 'tool' : 'llm';
  }
  return out;
}

function extractOpenInference(attrs) {
  const out = {};
  const kind = attrs['openinference.span.kind'];
  if (kind) {
    out.spanType = { LLM: 'llm', TOOL: 'tool', AGENT: 'agent', CHAIN: 'chain' }[kind] ?? 'other';
  }
  out.model = firstDefined(attrs['llm.model_name'], attrs['embedding.model_name']);
  out.promptTokens = asNumber(attrs['llm.token_count.prompt']);
  out.completionTokens = asNumber(attrs['llm.token_count.completion']);
  out.totalTokens = asNumber(attrs['llm.token_count.total']);

  const inputMessages =
    tryParseJson(attrs['llm.input_messages']) ?? collectIndexedMessages(attrs, 'llm.input_messages');
  const outputMessages =
    tryParseJson(attrs['llm.output_messages']) ?? collectIndexedMessages(attrs, 'llm.output_messages');
  out.inputText = firstDefined(renderMessages(inputMessages), attrs['input.value']);
  out.outputText = firstDefined(renderMessages(outputMessages), attrs['output.value']);
  return out;
}

// NeMo Relay exports its own `nemo_relay.*` namespace, with rich payloads
// tucked into `*_json` string attributes (metadata_json, messages_json, ...).
function extractNemoRelay(attrs) {
  const out = {};
  const parsed = {};
  let sawNamespace = false;
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith('nemo_relay.')) continue;
    sawNamespace = true;
    parsed[key] = key.endsWith('_json') ? tryParseJson(value) ?? value : value;
  }
  if (!sawNamespace) return out;
  // Direct attributes observed from real NeMo Relay exports.
  out.spanType =
    { llm: 'llm', tool: 'tool', agent: 'agent' }[attrs['nemo_relay.scope_type']] ?? 'llm';
  if (attrs['nemo_relay.model_name']) out.model = String(attrs['nemo_relay.model_name']);
  out.costUsd = asNumber(attrs['nemo_relay.llm.cost.total']);

  const scan = (node) => {
    if (Array.isArray(node)) {
      // A bare array of {role, content} objects is a message list.
      if (node.some((item) => item && typeof item === 'object' && 'role' in item)) {
        return { messages: node };
      }
      for (const item of node) {
        const found = scan(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== 'object' || node === null) return null;
    const found = {};
    if (node.usage && typeof node.usage === 'object') found.usage = node.usage;
    if (Array.isArray(node.messages)) found.messages = node.messages;
    // NeMo Relay's end.output_json carries the completion as a bare
    // top-level `content` string rather than a message list.
    if (typeof node.content === 'string') found.text = node.content;
    if (node.model ?? node.model_id ?? node.modelId) {
      found.model = node.model ?? node.model_id ?? node.modelId;
    }
    if (Object.keys(found).length > 0) return found;
    for (const value of Object.values(node)) {
      const nested = scan(value);
      if (nested) return nested;
    }
    return null;
  };

  for (const [key, value] of Object.entries(parsed)) {
    const found = scan(value);
    if (!found) continue;
    if (found.usage) {
      out.promptTokens ??= asNumber(found.usage.prompt_tokens ?? found.usage.input_tokens);
      out.completionTokens ??= asNumber(
        found.usage.completion_tokens ?? found.usage.output_tokens,
      );
      out.totalTokens ??= asNumber(found.usage.total_tokens);
      out.costUsd ??= asNumber(found.usage.cost_usd);
    }
    const rendered = found.messages ? renderMessages(found.messages) : found.text ?? null;
    if (rendered) {
      if (key.includes('output') || key.includes('end') || key.includes('response')) {
        out.outputText ??= rendered;
      } else {
        out.inputText ??= rendered;
      }
    }
    if (found.model) out.model ??= String(found.model);
  }
  return out;
}

/**
 * Extract a session/conversation identifier from any known convention.
 * Exported separately so the store can backfill old rows.
 */
export function extractSessionId(attrs) {
  const direct = firstDefined(
    attrs['session.id'],
    attrs['gen_ai.conversation.id'],
    attrs['langfuse.session.id'],
  );
  if (direct) return String(direct);
  // NeMo Relay tucks sessionId/sessionKey inside *_json metadata payloads.
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith('nemo_relay.') || !key.endsWith('_json')) continue;
    const parsed = tryParseJson(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const found = parsed.sessionId ?? parsed.session_id ?? parsed.sessionKey;
      if (found) return String(found);
    }
  }
  return null;
}

/**
 * Extract an end-user identifier from any known convention, so traces can
 * be grouped by user like Langfuse's Users view. Falls back to OpenClaw's
 * Feishu open-id (`ou_<hex>:`) embedded at the start of a user message.
 */
export function extractUserId(attrs, inputText) {
  const direct = firstDefined(
    attrs['user.id'],
    attrs['gen_ai.user.id'],
    attrs['langfuse.user.id'],
    attrs['enduser.id'],
  );
  if (direct) return String(direct);
  for (const [key, value] of Object.entries(attrs)) {
    if (!key.startsWith('nemo_relay.') || !key.endsWith('_json')) continue;
    const parsed = tryParseJson(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const found = parsed.userId ?? parsed.user_id ?? parsed.endUserId;
      if (found) return String(found);
    }
  }
  // OpenClaw prefixes Feishu messages with the sender open-id.
  const match = /\b(ou_[0-9a-f]{16,})/.exec(inputText ?? '');
  return match ? match[1] : null;
}

function guessSpanType(span) {
  const name = span.name.toLowerCase();
  if (/(llm|model|completion|generation|chat)/.test(name)) return 'llm';
  if (/(tool|exec|bash|read|write|edit|search)/.test(name)) return 'tool';
  if (/agent/.test(name)) return 'agent';
  return 'other';
}

/**
 * Merge all convention extractors over a normalized span. Later extractors
 * only fill fields earlier ones left empty, so explicit conventions win
 * over heuristics.
 */
export function extractSemantics(span) {
  const attrs = span.attributes ?? {};
  const layers = [
    extractGenAi(attrs, span.events),
    extractOpenInference(attrs),
    extractNemoRelay(attrs),
  ];
  const merged = {
    spanType: null,
    model: null,
    inputText: null,
    outputText: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    costUsd: null,
  };
  for (const layer of layers) {
    for (const key of Object.keys(merged)) {
      if (merged[key] === null && layer[key] !== undefined && layer[key] !== null) {
        merged[key] = layer[key];
      }
    }
  }
  merged.spanType ??= guessSpanType(span);
  if (merged.totalTokens === null && merged.promptTokens !== null && merged.completionTokens !== null) {
    merged.totalTokens = merged.promptTokens + merged.completionTokens;
  }
  merged.sessionId = extractSessionId(attrs);
  merged.userId = extractUserId(attrs, merged.inputText);
  return merged;
}
