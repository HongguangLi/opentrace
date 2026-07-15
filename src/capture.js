// Built-in capture: a transparent LLM tracing proxy. Agents that can't
// export OTLP (most of them) just point their provider base URL at
// /proxy/openai or /proxy/anthropic — requests are forwarded verbatim
// (including the agent's own API key) and recorded as spans on the side.
// This is NeMo Relay's capture idea moved from the runtime boundary to
// the network boundary: no per-agent plugin required.
import crypto from 'node:crypto';
import { extractSemantics } from './semantics.js';

const RECORDABLE_PATHS = /\/(chat\/completions|completions|messages)$/;
const MAX_RECORDED_RESPONSE = 8 * 1024 * 1024;

// Hop-by-hop headers must not be forwarded.
const SKIP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding',
  'keep-alive', 'upgrade', 'proxy-authorization', 'te', 'trailer',
  // OpenTrace-internal headers must never leak to the upstream.
  'x-opentrace-token', 'x-langfuse-relay-token', 'x-session-id', 'x-service-name',
]);

function forwardHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!SKIP_HEADERS.has(key)) headers[key] = value;
  }
  return headers;
}

function messagesToText(messages) {
  if (!Array.isArray(messages)) return null;
  const parts = [];
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content
        .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof content !== 'string') content = content == null ? '' : JSON.stringify(content);
    parts.push(msg.role ? `[${msg.role}] ${content}` : content);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// Pull output text + token usage out of a completed response body,
// handling both providers in both plain-JSON and SSE-stream forms.
function parseResponse(provider, contentType, bodyText) {
  const out = { outputText: null, promptTokens: null, completionTokens: null, model: null };
  if (contentType.includes('text/event-stream')) {
    const texts = [];
    for (const line of bodyText.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (provider === 'openai') {
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') texts.push(delta);
        if (event.usage) {
          out.promptTokens = event.usage.prompt_tokens ?? null;
          out.completionTokens = event.usage.completion_tokens ?? null;
        }
        out.model ??= event.model ?? null;
      } else {
        if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
          texts.push(event.delta.text);
        }
        if (event.type === 'message_start' && event.message?.usage) {
          out.promptTokens = event.message.usage.input_tokens ?? null;
          out.model ??= event.message.model ?? null;
        }
        if (event.type === 'message_delta' && event.usage) {
          out.completionTokens = event.usage.output_tokens ?? null;
        }
      }
    }
    out.outputText = texts.length > 0 ? texts.join('') : null;
    return out;
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return out;
  }
  out.model = body.model ?? null;
  if (provider === 'openai') {
    const message = body.choices?.[0]?.message;
    out.outputText = typeof message?.content === 'string' ? message.content : null;
    out.promptTokens = body.usage?.prompt_tokens ?? null;
    out.completionTokens = body.usage?.completion_tokens ?? null;
  } else {
    if (Array.isArray(body.content)) {
      const text = body.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      out.outputText = text || null;
    }
    out.promptTokens = body.usage?.input_tokens ?? null;
    out.completionTokens = body.usage?.output_tokens ?? null;
  }
  return out;
}

function traceIdFrom(req) {
  // Honor W3C traceparent so callers can correlate proxy spans with their
  // own traces; otherwise every call becomes its own trace.
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(req.headers.traceparent ?? '');
  if (match) return { traceId: match[1], parentSpanId: match[2] };
  return { traceId: crypto.randomBytes(16).toString('hex'), parentSpanId: '' };
}

/**
 * Forward a /proxy/<provider>/... request to the configured upstream,
 * streaming the response back and recording an LLM span on the side.
 */
export async function handleProxyRequest(req, res, body, { provider, upstream, store, logger }) {
  const prefix = `/proxy/${provider}`;
  const upstreamUrl = upstream.replace(/\/$/, '') + req.url.slice(prefix.length);
  const startMs = Date.now();

  let response;
  try {
    response = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders(req),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream unreachable: ${error.message}` }));
    logger.error(`[proxy] ${provider} ${upstreamUrl}: ${error.message}`);
    return;
  }

  const responseHeaders = {};
  for (const [key, value] of response.headers.entries()) {
    if (!SKIP_HEADERS.has(key) && key !== 'content-encoding') responseHeaders[key] = value;
  }
  res.writeHead(response.status, responseHeaders);

  // Stream through to the client while accumulating a bounded copy for
  // span extraction — the agent sees identical latency and bytes.
  const chunks = [];
  let recordedBytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      res.write(chunk);
      if (recordedBytes < MAX_RECORDED_RESPONSE) {
        chunks.push(chunk);
        recordedBytes += chunk.length;
      }
    }
  }
  res.end();
  const endMs = Date.now();

  if (!(req.method === 'POST' && RECORDABLE_PATHS.test(upstreamUrl.split('?')[0]))) return;

  try {
    let request = {};
    try {
      request = JSON.parse(body.toString('utf8'));
    } catch {
      /* non-JSON request body: record what we can */
    }
    const contentType = response.headers.get('content-type') ?? '';
    const parsed = parseResponse(provider, contentType, Buffer.concat(chunks).toString('utf8'));
    const { traceId, parentSpanId } = traceIdFrom(req);
    const model = parsed.model ?? request.model ?? 'unknown';
    const service = req.headers['x-service-name'] ?? `proxy:${provider}`;
    const span = {
      traceId,
      spanId: crypto.randomBytes(8).toString('hex'),
      parentSpanId,
      name: `${provider} ${model}`,
      kind: 'CLIENT',
      service,
      scope: 'opentrace/proxy',
      startNs: BigInt(startMs) * 1_000_000n,
      endNs: BigInt(endMs) * 1_000_000n,
      durationMs: endMs - startMs,
      statusCode: response.ok ? 'OK' : 'ERROR',
      statusMessage: response.ok ? '' : `upstream HTTP ${response.status}`,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': request.model ?? model,
        ...(parsed.model ? { 'gen_ai.response.model': parsed.model } : {}),
        ...(parsed.promptTokens != null ? { 'gen_ai.usage.input_tokens': parsed.promptTokens } : {}),
        ...(parsed.completionTokens != null
          ? { 'gen_ai.usage.output_tokens': parsed.completionTokens }
          : {}),
        // Anthropic carries the system prompt as a top-level field rather
        // than a messages[] entry — prepend it so nothing is lost.
        ...((() => {
          const system = typeof request.system === 'string'
            ? request.system
            : Array.isArray(request.system)
              ? request.system.map((b) => b?.text ?? '').join('\n')
              : null;
          const text = [system ? `[system] ${system}` : null, messagesToText(request.messages)]
            .filter(Boolean)
            .join('\n\n');
          return text ? { 'gen_ai.prompt': text } : {};
        })()),
        ...(parsed.outputText ? { 'gen_ai.completion': parsed.outputText } : {}),
        // Callers can group proxy calls into a session with x-session-id.
        ...(req.headers['x-session-id'] ? { 'session.id': req.headers['x-session-id'] } : {}),
        'http.response.status_code': response.status,
        'server.address': upstream,
      },
      resource: { 'service.name': service },
      events: [],
    };
    span.semantics = extractSemantics(span);
    store.insertSpans([span]);
    logger.log(
      `[proxy] ${provider} ${model} ${response.status} ${endMs - startMs}ms` +
        (parsed.completionTokens != null ? ` ${parsed.promptTokens}+${parsed.completionTokens} tok` : ''),
    );
  } catch (error) {
    // Recording must never break the proxied call the agent depends on.
    logger.error(`[proxy] failed to record span: ${error.message}`);
  }
}
