// SQLite persistence built on the Node.js built-in `node:sqlite` module —
// the whole point of AgentTap is that "install a database" is not a
// prerequisite for tracing your coding agent.
import { DatabaseSync } from 'node:sqlite';
import { extractSessionId, extractUserId } from './semantics.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spans (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT,
  service TEXT,
  scope TEXT,
  start_ns TEXT NOT NULL,
  end_ns TEXT NOT NULL,
  duration_ms REAL,
  status_code TEXT,
  status_message TEXT,
  span_type TEXT,
  session_id TEXT,
  user_id TEXT,
  model TEXT,
  input_text TEXT,
  output_text TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  attributes_json TEXT,
  resource_json TEXT,
  events_json TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans (trace_id, start_ns);
CREATE INDEX IF NOT EXISTS idx_spans_start ON spans (start_ns DESC);
CREATE INDEX IF NOT EXISTS idx_spans_service ON spans (service);
`;

export class SpanStore {
  #db;
  #insert;

  constructor(dbPath) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(SCHEMA);
    // Migrate databases created before these columns existed; indexes come
    // after the ALTERs so they never reference a missing column.
    for (const col of ['session_id TEXT', 'user_id TEXT']) {
      try {
        this.#db.exec(`ALTER TABLE spans ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_spans_session ON spans (session_id)');
    this.#db.exec('CREATE INDEX IF NOT EXISTS idx_spans_user ON spans (user_id)');
    this.#insert = this.#db.prepare(`
      INSERT INTO spans (
        trace_id, span_id, parent_span_id, name, kind, service, scope,
        start_ns, end_ns, duration_ms, status_code, status_message,
        span_type, session_id, user_id, model, input_text, output_text,
        prompt_tokens, completion_tokens, total_tokens, cost_usd,
        attributes_json, resource_json, events_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (trace_id, span_id) DO UPDATE SET
        end_ns = excluded.end_ns,
        duration_ms = excluded.duration_ms,
        status_code = excluded.status_code,
        attributes_json = excluded.attributes_json,
        events_json = excluded.events_json
    `);
    this.#backfill();
  }

  // One-time re-extraction of session/user ids for rows ingested before the
  // columns existed; local trace volumes make this cheap.
  #backfill() {
    const rows = this.#db
      .prepare(
        'SELECT trace_id, span_id, attributes_json, input_text FROM spans WHERE session_id IS NULL OR user_id IS NULL',
      )
      .all();
    if (rows.length === 0) return;
    const update = this.#db.prepare(
      'UPDATE spans SET session_id = ?, user_id = ? WHERE trace_id = ? AND span_id = ?',
    );
    for (const row of rows) {
      try {
        const attrs = JSON.parse(row.attributes_json || '{}');
        update.run(
          extractSessionId(attrs),
          extractUserId(attrs, row.input_text),
          row.trace_id,
          row.span_id,
        );
      } catch {
        /* unparseable attributes: leave NULL */
      }
    }
  }

  insertSpans(spans) {
    const now = Date.now();
    this.#db.exec('BEGIN');
    try {
      for (const span of spans) {
        this.#insert.run(
          span.traceId,
          span.spanId,
          span.parentSpanId || null,
          span.name,
          span.kind,
          span.service,
          span.scope,
          String(span.startNs),
          String(span.endNs),
          span.durationMs,
          span.statusCode,
          span.statusMessage,
          span.semantics.spanType,
          span.semantics.sessionId ?? null,
          span.semantics.userId ?? null,
          span.semantics.model,
          span.semantics.inputText,
          span.semantics.outputText,
          span.semantics.promptTokens,
          span.semantics.completionTokens,
          span.semantics.totalTokens,
          span.semantics.costUsd,
          JSON.stringify(span.attributes),
          JSON.stringify(span.resource),
          JSON.stringify(span.events),
          now,
        );
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return spans.length;
  }

  listTraces({ limit = 50, offset = 0, service = null, q = null, session = null, user = null, sinceMs = null } = {}) {
    const filters = [];
    const params = [];
    if (service) {
      filters.push('service = ?');
      params.push(service);
    }
    if (session) {
      filters.push('trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE session_id = ?)');
      params.push(session);
    }
    if (user) {
      filters.push('trace_id IN (SELECT DISTINCT trace_id FROM spans WHERE user_id = ?)');
      params.push(user);
    }
    if (sinceMs) {
      filters.push('CAST(start_ns AS INTEGER) / 1000000 >= ?');
      params.push(sinceMs);
    }
    if (q) {
      filters.push('(name LIKE ? OR model LIKE ? OR input_text LIKE ? OR output_text LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    return this.#db
      .prepare(
        `SELECT
           trace_id,
           -- Nanosecond timestamps exceed JS safe-integer range, so reduce to
           -- milliseconds inside SQL before they cross the JS boundary.
           MIN(CAST(start_ns AS INTEGER) / 1000000) AS start_ms,
           MAX(CAST(end_ns AS INTEGER) / 1000000) AS end_ms,
           COUNT(*) AS span_count,
           SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
           SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
           SUM(COALESCE(total_tokens, 0)) AS total_tokens,
           SUM(COALESCE(cost_usd, 0)) AS cost_usd,
           MAX(service) AS service,
           MAX(CASE WHEN span_type = 'llm' THEN model END) AS model,
           SUM(CASE WHEN span_type = 'llm' THEN 1 ELSE 0 END) AS llm_calls,
           SUM(CASE WHEN status_code = 'ERROR' THEN 1 ELSE 0 END) AS error_count,
           MAX(CASE WHEN parent_span_id IS NULL THEN name END) AS root_name,
           MAX(session_id) AS session_id
         FROM spans ${where}
         GROUP BY trace_id
         ORDER BY start_ms DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
  }

  // Flat list of individual observations (spans), Langfuse's Observations
  // tab — every LLM/tool call across all traces, newest first.
  listObservations({ limit = 100, offset = 0, type = null, sinceMs = null, q = null } = {}) {
    const filters = [];
    const params = [];
    if (type) {
      filters.push('span_type = ?');
      params.push(type);
    }
    if (sinceMs) {
      filters.push('CAST(start_ns AS INTEGER) / 1000000 >= ?');
      params.push(sinceMs);
    }
    if (q) {
      filters.push('(name LIKE ? OR model LIKE ? OR input_text LIKE ? OR output_text LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    return this.#db
      .prepare(
        `SELECT trace_id, span_id, name, span_type, kind, service, model,
                CAST(start_ns AS INTEGER) / 1000000 AS start_ms,
                duration_ms, status_code,
                prompt_tokens, completion_tokens, total_tokens, cost_usd,
                substr(input_text, 1, 200) AS input_preview,
                substr(output_text, 1, 200) AS output_preview
         FROM spans ${where}
         ORDER BY CAST(start_ns AS INTEGER) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
  }

  listUsers({ limit = 100, offset = 0 } = {}) {
    return this.#db
      .prepare(
        `SELECT
           user_id,
           COUNT(DISTINCT trace_id) AS trace_count,
           COUNT(DISTINCT session_id) AS session_count,
           SUM(CASE WHEN span_type = 'llm' THEN 1 ELSE 0 END) AS llm_calls,
           SUM(COALESCE(total_tokens, 0)) AS total_tokens,
           SUM(COALESCE(cost_usd, 0)) AS cost_usd,
           MIN(CAST(start_ns AS INTEGER) / 1000000) AS first_ms,
           MAX(CAST(end_ns AS INTEGER) / 1000000) AS last_ms,
           MAX(service) AS service
         FROM spans
         WHERE user_id IS NOT NULL
         GROUP BY user_id
         ORDER BY last_ms DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  }

  listSessions({ limit = 100, offset = 0 } = {}) {
    return this.#db
      .prepare(
        `SELECT
           session_id,
           COUNT(DISTINCT trace_id) AS trace_count,
           COUNT(*) AS span_count,
           SUM(CASE WHEN span_type = 'llm' THEN 1 ELSE 0 END) AS llm_calls,
           SUM(COALESCE(total_tokens, 0)) AS total_tokens,
           SUM(COALESCE(cost_usd, 0)) AS cost_usd,
           MIN(CAST(start_ns AS INTEGER) / 1000000) AS first_ms,
           MAX(CAST(end_ns AS INTEGER) / 1000000) AS last_ms,
           MAX(service) AS service,
           SUM(CASE WHEN status_code = 'ERROR' THEN 1 ELSE 0 END) AS error_count
         FROM spans
         WHERE session_id IS NOT NULL
         GROUP BY session_id
         ORDER BY last_ms DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  }

  getTrace(traceId) {
    return this.#db
      .prepare(
        `SELECT trace_id, span_id, parent_span_id, name, kind, service, scope,
                start_ns, end_ns, duration_ms, status_code, status_message,
                span_type, session_id, user_id, model, input_text, output_text,
                prompt_tokens, completion_tokens, total_tokens, cost_usd,
                attributes_json, resource_json, events_json
         FROM spans WHERE trace_id = ?
         ORDER BY CAST(start_ns AS INTEGER) ASC`,
      )
      .all(traceId);
  }

  stats({ sinceMs = null } = {}) {
    const since = sinceMs ? 'CAST(start_ns AS INTEGER) / 1000000 >= ?' : '1=1';
    const p = sinceMs ? [sinceMs] : [];
    const totals = this.#db
      .prepare(
        `SELECT COUNT(DISTINCT trace_id) AS traces,
                COUNT(*) AS spans,
                SUM(CASE WHEN span_type = 'llm' THEN 1 ELSE 0 END) AS llm_calls,
                SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd
         FROM spans WHERE ${since}`,
      )
      .get(...p);
    const services = this.#db
      .prepare(
        `SELECT service, COUNT(DISTINCT trace_id) AS traces, COUNT(*) AS spans
         FROM spans WHERE ${since} GROUP BY service ORDER BY spans DESC`,
      )
      .all(...p);
    const models = this.#db
      .prepare(
        `SELECT model,
                COUNT(*) AS calls,
                SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
                SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd,
                AVG(duration_ms) AS avg_ms
         FROM spans WHERE span_type = 'llm' AND model IS NOT NULL AND ${since}
         GROUP BY model ORDER BY calls DESC`,
      )
      .all(...p);
    return { totals, services, models };
  }

  close() {
    this.#db.close();
  }
}
