#!/usr/bin/env node
// Sends a small synthetic agent trace (agent → LLM call + tool call) to a
// running agenttap instance using OTLP/JSON. Usage:
//   node examples/send-test-trace.js [endpoint]
const endpoint = process.argv[2] ?? 'http://127.0.0.1:4318/v1/traces';

const hex = (bytes) =>
  Array.from({ length: bytes * 2 }, () => '0123456789abcdef'[(Math.random() * 16) | 0]).join('');

const traceId = hex(16);
const agentSpanId = hex(8);
const llmSpanId = hex(8);
const toolSpanId = hex(8);
const now = BigInt(Date.now()) * 1_000_000n;

const attr = (key, value) => ({
  key,
  value:
    typeof value === 'number' && Number.isInteger(value)
      ? { intValue: String(value) }
      : { stringValue: String(value) },
});

const span = (spanId, parentSpanId, name, startNs, endNs, attributes) => ({
  traceId,
  spanId,
  ...(parentSpanId ? { parentSpanId } : {}),
  name,
  kind: 1,
  startTimeUnixNano: String(startNs),
  endTimeUnixNano: String(endNs),
  attributes,
  status: { code: 1 },
});

const payload = {
  resourceSpans: [
    {
      resource: { attributes: [attr('service.name', 'example-agent')] },
      scopeSpans: [
        {
          scope: { name: 'agenttap-example' },
          spans: [
            span(agentSpanId, null, 'agent-turn', now, now + 3_000_000_000n, [
              attr('openinference.span.kind', 'AGENT'),
            ]),
            span(llmSpanId, agentSpanId, 'chat claude-sonnet-4-6', now + 100_000_000n, now + 2_200_000_000n, [
              attr('gen_ai.operation.name', 'chat'),
              attr('gen_ai.request.model', 'claude-sonnet-4-6'),
              attr('gen_ai.usage.input_tokens', 1234),
              attr('gen_ai.usage.output_tokens', 256),
              attr('gen_ai.prompt', '[user] What files changed in the last commit?'),
              attr('gen_ai.completion', '[assistant] Let me check with git show --stat.'),
            ]),
            span(toolSpanId, agentSpanId, 'exec git show --stat', now + 2_300_000_000n, now + 2_800_000_000n, [
              attr('openinference.span.kind', 'TOOL'),
              attr('tool.name', 'bash'),
            ]),
          ],
        },
      ],
    },
  ],
};

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
console.log(`POST ${endpoint} -> ${res.status}`);
console.log(`trace: ${traceId}`);
