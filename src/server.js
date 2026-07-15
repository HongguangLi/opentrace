// AgentTap — single-process HTTP server: OTLP ingestion + LLM proxy
// capture + query API + dashboard. No framework — node:http is plenty for
// a local-first tool.
import http from 'node:http';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeTraceExport } from './otlp.js';
import { extractSemantics } from './semantics.js';
import { SpanStore } from './store.js';
import { handleProxyRequest } from './capture.js';

const UI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html');

// OTLP standard path plus a Langfuse-compatible alias, so existing exporters
// pointed at Langfuse's OTLP endpoint only need a host/port change.
const INGEST_PATHS = new Set(['/v1/traces', '/api/public/otel/v1/traces']);

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createServer({
  dbPath,
  token = null,
  maxBodyBytes = 32 * 1024 * 1024,
  logger = console,
  upstreams = {},
}) {
  const store = new SpanStore(dbPath);
  const proxyUpstreams = {
    openai: upstreams.openai ?? 'https://api.openai.com',
    anthropic: upstreams.anthropic ?? 'https://api.anthropic.com',
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const proxyMatch = /^\/proxy\/(openai|anthropic)\//.exec(url.pathname);
      if (proxyMatch) {
        // The Authorization header on proxy routes belongs to the upstream
        // (it carries the agent's API key), so relay auth uses its own
        // header here — without this check a non-loopback bind would be an
        // open relay to the configured upstreams.
        const proxyToken = req.headers['x-agenttap-token'] ?? req.headers['x-opentrace-token'] ?? req.headers['x-langfuse-relay-token'];
        if (token && proxyToken !== token) {
          sendJson(res, 401, { error: 'unauthorized: set x-agenttap-token header' });
          return;
        }
        const body = await readBody(req, maxBodyBytes);
        await handleProxyRequest(req, res, body, {
          provider: proxyMatch[1],
          upstream: proxyUpstreams[proxyMatch[1]],
          store,
          logger,
        });
        return;
      }

      if (req.method === 'POST' && INGEST_PATHS.has(url.pathname)) {
        // Auth is optional: local-first means zero-config by default, but a
        // shared token can be required when exposed beyond localhost.
        if (token) {
          const auth = req.headers.authorization ?? '';
          if (auth !== `Bearer ${token}` && auth !== `Basic ${token}`) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
          }
        }
        let body = await readBody(req, maxBodyBytes);
        // OTLP exporters commonly compress payloads; decode errors from
        // treating gzip bytes as protobuf look like "index out of range".
        const encoding = req.headers['content-encoding'] ?? '';
        if (encoding.includes('gzip')) {
          body = zlib.gunzipSync(body);
        } else if (encoding.includes('deflate')) {
          body = zlib.inflateSync(body);
        }
        const contentType = req.headers['content-type'] ?? 'application/x-protobuf';
        let spans;
        try {
          spans = await decodeTraceExport(body, contentType);
        } catch (error) {
          const debugDir = process.env.AGENTTAP_DEBUG_DIR ?? process.env.LANGFUSE_RELAY_DEBUG_DIR;
          if (debugDir) {
            const { writeFileSync } = await import('node:fs');
            const dump = path.join(debugDir, `failed-${Date.now()}.bin`);
            writeFileSync(dump, body);
            writeFileSync(dump + '.headers.json', JSON.stringify(req.headers, null, 2));
            logger.error(`[debug] decode failed, payload dumped to ${dump}`);
          }
          throw error;
        }
        for (const span of spans) {
          span.semantics = extractSemantics(span);
        }
        const count = store.insertSpans(spans);
        logger.log(`[ingest] ${count} span(s) from ${spans[0]?.service ?? 'unknown'}`);
        // OTLP/HTTP success response: empty partial-success object.
        sendJson(res, 200, {});
        return;
      }

      // A time-range window shared by list/stat endpoints; `since` is the
      // number of ms to look back (0 or absent = all time).
      const sinceParam = Number(url.searchParams.get('since') ?? 0);
      const sinceMs = sinceParam > 0 ? Date.now() - sinceParam : null;

      if (req.method === 'GET' && url.pathname === '/api/traces') {
        sendJson(res, 200, {
          traces: store.listTraces({
            limit: Math.min(Number(url.searchParams.get('limit') ?? 50), 500),
            offset: Number(url.searchParams.get('offset') ?? 0),
            service: url.searchParams.get('service'),
            q: url.searchParams.get('q'),
            session: url.searchParams.get('session'),
            user: url.searchParams.get('user'),
            sinceMs,
          }),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/observations') {
        sendJson(res, 200, {
          observations: store.listObservations({
            limit: Math.min(Number(url.searchParams.get('limit') ?? 100), 500),
            offset: Number(url.searchParams.get('offset') ?? 0),
            type: url.searchParams.get('type'),
            q: url.searchParams.get('q'),
            sinceMs,
          }),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        sendJson(res, 200, {
          sessions: store.listSessions({
            limit: Math.min(Number(url.searchParams.get('limit') ?? 100), 500),
            offset: Number(url.searchParams.get('offset') ?? 0),
          }),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/users') {
        sendJson(res, 200, {
          users: store.listUsers({
            limit: Math.min(Number(url.searchParams.get('limit') ?? 100), 500),
            offset: Number(url.searchParams.get('offset') ?? 0),
          }),
        });
        return;
      }

      const traceMatch = /^\/api\/traces\/([0-9a-f]{1,64})$/.exec(url.pathname);
      if (req.method === 'GET' && traceMatch) {
        const spans = store.getTrace(traceMatch[1]);
        if (spans.length === 0) {
          sendJson(res, 404, { error: 'trace not found' });
          return;
        }
        sendJson(res, 200, { spans });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/stats') {
        sendJson(res, 200, store.stats({ sinceMs }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // Re-read per request so dashboard tweaks don't need a restart.
        const html = readFileSync(UI_PATH);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const statusCode = error.statusCode ?? (error instanceof SyntaxError ? 400 : 500);
      logger.error(`[error] ${req.method} ${url.pathname}: ${error.message}`);
      sendJson(res, statusCode, { error: error.message });
    }
  });

  server.on('close', () => store.close());
  return server;
}
