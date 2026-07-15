# pi → OpenTrace

[pi](https://github.com/badlogic/pi-mono) is a minimal, hackable coding agent.

## LLM tracing proxy (recommended)

Point pi's provider base URL at the relay:

```bash
# Anthropic-API models:
ANTHROPIC_BASE_URL=http://127.0.0.1:4318/proxy/anthropic pi
# OpenAI-compatible models:
OPENAI_BASE_URL=http://127.0.0.1:4318/proxy/openai pi
```

Every LLM call lands in the dashboard with model, tokens, and full content — no code changes.

## Direct OTLP (hackable route)

pi's TypeScript core makes it easy to emit OTLP/JSON directly — a minimal exporter is one HTTP POST per LLM call:

```ts
await fetch("http://127.0.0.1:4318/v1/traces", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "pi" } }] },
      scopeSpans: [{
        scope: { name: "pi-tracer" },
        spans: [{
          traceId, spanId, name: "chat " + model, kind: 1,
          startTimeUnixNano: String(startNs), endTimeUnixNano: String(endNs),
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: model } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: String(inputTokens) } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: String(outputTokens) } },
            { key: "gen_ai.prompt", value: { stringValue: promptText } },
            { key: "gen_ai.completion", value: { stringValue: completionText } },
          ],
        }],
      }],
    }],
  }),
});
```

Useful when you want custom spans (tool calls, agent phases) beyond what the proxy sees.
