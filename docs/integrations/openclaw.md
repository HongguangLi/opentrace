# OpenClaw → AgentTap (via NeMo Relay)

OpenClaw's [NeMo Relay plugin](https://github.com/NVIDIA/NeMo-Relay) captures LLM and tool activity through OpenClaw's hook system and exports OTLP. This is the most complete integration — it was the original motivation for AgentTap.

## Configuration

In `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": ["nemo-relay"],            // REQUIRED — without this, auto-discovery
                                        // ignores the hooks policy below and all
                                        // conversation hooks are silently blocked
    "entries": {
      "nemo-relay": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "enabled": true,
          "backend": "hooks",
          "plugins": {
            "version": 1,
            "components": [{
              "kind": "observability",
              "enabled": true,
              "config": {
                "version": 1,
                "openinference": {
                  "enabled": true,
                  "transport": "http_binary",
                  "endpoint": "http://127.0.0.1:4318/v1/traces",
                  "service_name": "openclaw"
                }
              }
            }]
          },
          "capture": { "includePrompts": true, "includeResponses": true }
        }
      }
    }
  }
}
```

Restart the gateway afterwards (`systemctl --user restart openclaw` or `openclaw gateway restart`).

## Exporter choice

NeMo Relay offers two OTLP exporters — AgentTap understands both:

- **`openinference`** (recommended): standard `llm.*` attributes; input/output render directly.
- **`opentelemetry`**: NVIDIA's native `nemo_relay.*` attributes; AgentTap digs the messages and token usage out of the `*_json` payloads automatically.

## Migrating from a self-hosted Langfuse

If you previously exported to Langfuse's OTLP endpoint (`/api/public/otel/v1/traces`), just change the host — AgentTap serves the same path and accepts (ignores) the Basic auth header.
