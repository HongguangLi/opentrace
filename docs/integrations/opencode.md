# opencode → OpenTrace

opencode has no first-party OTLP exporter, so use the built-in LLM tracing proxy — point the provider `baseURL` at the relay in `~/.config/opencode/opencode.json`:

```jsonc
{
  "provider": {
    "anthropic": {
      "options": { "baseURL": "http://127.0.0.1:4318/proxy/anthropic" }
    }
    // or for OpenAI-compatible providers:
    // "openai": { "options": { "baseURL": "http://127.0.0.1:4318/proxy/openai" } }
  }
}
```

API keys pass through untouched; streaming works transparently. If your model is served by a local gateway (LiteLLM, Ollama, NIM), set the relay's upstream to it:

```bash
opentrace --openai-upstream http://127.0.0.1:4000
```

## Plugin route

opencode has a plugin system with `chat.message` / tool-execution hooks. A native OTLP exporter plugin (mirroring what NeMo Relay does for OpenClaw) would add tool-level spans on top of the proxy's LLM spans — PRs welcome.
