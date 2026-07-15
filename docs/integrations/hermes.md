# Hermes → AgentTap

## LLM tracing proxy (recommended)

Point Hermes's provider base URL at the relay:

```bash
# OpenAI-compatible endpoint config in Hermes:
base_url: http://127.0.0.1:4318/proxy/openai
# or for Anthropic-API builds:
base_url: http://127.0.0.1:4318/proxy/anthropic
```

Every completion call is forwarded verbatim (your key passes through) and recorded with model, tokens, and message content. If Hermes talks to a local gateway (LiteLLM, Ollama, NIM), chain it: `agenttap --openai-upstream http://127.0.0.1:4000`.

## OTLP ingest (if your build supports OTel)

```bash
export OTEL_TRACES_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

AgentTap accepts both `http/protobuf` and `http/json` OTLP.
