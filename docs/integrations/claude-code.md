# Claude Code → AgentTap

Both capture interfaces work; pick one.

## LLM tracing proxy (recommended — full request/response)

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4318/proxy/anthropic
claude
```

Every LLM call appears in the dashboard with model, token usage, and full message content. Your `ANTHROPIC_API_KEY` passes through the relay untouched; streaming works transparently.

## OTLP ingest (native telemetry)

Claude Code has built-in OpenTelemetry support via environment variables:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
claude
```

Note: Claude Code's native telemetry focuses on **metrics and log events** (API request counts, token usage, cost) rather than full traces — use the proxy interface when you want conversation content.
