# Codex → AgentTap

## Native OTel export

Recent Codex CLI versions ship experimental OpenTelemetry support. In `~/.codex/config.toml`:

```toml
[otel]
environment = "dev"
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/traces", protocol = "binary" } }
```

Check `codex --help` / the [Codex config docs](https://github.com/openai/codex/blob/main/docs/config.md) for the exact schema on your version — the `[otel]` surface is still evolving.

## LLM tracing proxy (works on any version)

Point Codex's OpenAI base URL at the relay's built-in proxy:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:4318/proxy/openai
```

Your API key passes through untouched; every LLM call is recorded with model, tokens, and content.
