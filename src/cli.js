#!/usr/bin/env node
// CLI entry: `agenttap [--port 4318] [--db path] [--host 127.0.0.1]`.
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from './server.js';

// Env vars are read under the AGENTTAP_ prefix, falling back to the legacy
// LANGFUSE_RELAY_ names so pre-rename setups keep working.
const env = (name) => process.env[`AGENTTAP_${name}`] ?? process.env[`LANGFUSE_RELAY_${name}`];

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: env('PORT') ?? '4318' },
    host: { type: 'string', default: env('HOST') ?? '127.0.0.1' },
    db: { type: 'string', default: env('DB') ?? '' },
    token: { type: 'string', default: env('TOKEN') ?? '' },
    'openai-upstream': {
      type: 'string',
      default: env('OPENAI_UPSTREAM') ?? 'https://api.openai.com',
    },
    'anthropic-upstream': {
      type: 'string',
      default: env('ANTHROPIC_UPSTREAM') ?? 'https://api.anthropic.com',
    },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`AgentTap — tap into your coding agents' LLM traffic (local-first observability)

Usage: agenttap [options]

Options:
  --port <n>                Listen port (default 4318, the OTLP/HTTP standard port)
  --host <h>                Bind address (default 127.0.0.1; use 0.0.0.0 to expose)
  --db <path>               SQLite file (default ~/.agenttap/traces.db)
  --token <t>               Require this token on ingest (Authorization: Bearer/Basic)
                            and proxy routes (x-agenttap-token header)
  --openai-upstream <url>   Upstream for /proxy/openai capture (default https://api.openai.com;
                            point at any OpenAI-compatible server: LiteLLM, Ollama, NIM, ...)
  --anthropic-upstream <url> Upstream for /proxy/anthropic capture (default https://api.anthropic.com)
  --help                    Show this help

Environment: AGENTTAP_PORT, AGENTTAP_HOST, AGENTTAP_DB, AGENTTAP_TOKEN,
  AGENTTAP_OPENAI_UPSTREAM, AGENTTAP_ANTHROPIC_UPSTREAM`);
  process.exit(0);
}

const dbPath = values.db || path.join(os.homedir(), '.agenttap', 'traces.db');
mkdirSync(path.dirname(dbPath), { recursive: true });

// One-time migration from a pre-rename location so existing traces survive.
if (!values.db && !existsSync(dbPath)) {
  for (const dir of ['.opentrace', '.langfuse-relay']) {
    const legacy = path.join(os.homedir(), dir, 'traces.db');
    if (existsSync(legacy)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(legacy + suffix)) copyFileSync(legacy + suffix, dbPath + suffix);
      }
      console.log(`migrated existing traces from ~/${dir}`);
      break;
    }
  }
}

const server = createServer({
  dbPath,
  token: values.token || null,
  upstreams: {
    openai: values['openai-upstream'],
    anthropic: values['anthropic-upstream'],
  },
});
const port = Number(values.port);

server.listen(port, values.host, () => {
  console.log(`AgentTap listening on http://${values.host}:${port}`);
  console.log(`  dashboard     http://${values.host}:${port}/`);
  console.log(`  OTLP ingest   http://${values.host}:${port}/v1/traces`);
  console.log(`  LLM proxy     http://${values.host}:${port}/proxy/openai -> ${values['openai-upstream']}`);
  console.log(`                http://${values.host}:${port}/proxy/anthropic -> ${values['anthropic-upstream']}`);
  console.log(`  db            ${dbPath}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Force-exit if in-flight requests hang shutdown.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
