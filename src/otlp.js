// OTLP/HTTP payload decoding: accepts both binary protobuf and JSON
// encodings of the trace and logs export requests and normalizes them into
// flat records ready for storage.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import protobuf from 'protobufjs';

const PROTO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'proto',
  'otlp.proto',
);

const types = { root: null };

async function lookup(name) {
  if (!types.root) types.root = await protobuf.load(PROTO_PATH);
  return types.root.lookupType(name);
}

function bytesToHex(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    // OTLP/JSON encodes trace ids as either hex or base64 depending on the
    // exporter; 32/16-char hex strings pass through, anything else is base64.
    if (/^[0-9a-fA-F]{16}$/.test(value) || /^[0-9a-fA-F]{32}$/.test(value)) {
      return value.toLowerCase();
    }
    return Buffer.from(value, 'base64').toString('hex');
  }
  return Buffer.from(value).toString('hex');
}

function toBigIntNano(value) {
  if (value === undefined || value === null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string') return BigInt(value);
  // protobufjs Long
  if (typeof value.toString === 'function') return BigInt(value.toString());
  return 0n;
}

function anyValueToJs(av) {
  if (av === undefined || av === null) return null;
  if (av.stringValue !== undefined && av.stringValue !== null) return av.stringValue;
  if (av.boolValue !== undefined && av.boolValue !== null) return av.boolValue;
  if (av.intValue !== undefined && av.intValue !== null) {
    const n = Number(av.intValue);
    return Number.isSafeInteger(n) ? n : String(av.intValue);
  }
  if (av.doubleValue !== undefined && av.doubleValue !== null) return av.doubleValue;
  if (av.arrayValue?.values) return av.arrayValue.values.map(anyValueToJs);
  if (av.kvlistValue?.values) return keyValuesToObject(av.kvlistValue.values);
  if (av.bytesValue !== undefined && av.bytesValue !== null) {
    return typeof av.bytesValue === 'string'
      ? av.bytesValue
      : Buffer.from(av.bytesValue).toString('base64');
  }
  return null;
}

function keyValuesToObject(kvs) {
  const out = {};
  for (const kv of kvs ?? []) {
    if (kv?.key) out[kv.key] = anyValueToJs(kv.value);
  }
  return out;
}

const SPAN_KIND_NAMES = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];

function spanKindName(kind) {
  if (typeof kind === 'string') return kind.replace('SPAN_KIND_', '');
  return SPAN_KIND_NAMES[kind ?? 0] ?? 'UNSPECIFIED';
}

function statusCodeName(status) {
  const code = status?.code;
  if (typeof code === 'string') return code.replace('STATUS_CODE_', '');
  return ['UNSET', 'OK', 'ERROR'][code ?? 0] ?? 'UNSET';
}

/** Flatten a decoded ExportTraceServiceRequest into normalized span records. */
function normalize(request) {
  const spans = [];
  for (const rs of request.resourceSpans ?? []) {
    const resource = keyValuesToObject(rs.resource?.attributes);
    const service = resource['service.name'] ?? 'unknown';
    for (const ss of rs.scopeSpans ?? []) {
      const scopeName = ss.scope?.name ?? '';
      for (const span of ss.spans ?? []) {
        const startNs = toBigIntNano(span.startTimeUnixNano);
        const endNs = toBigIntNano(span.endTimeUnixNano);
        spans.push({
          traceId: bytesToHex(span.traceId),
          spanId: bytesToHex(span.spanId),
          parentSpanId: bytesToHex(span.parentSpanId),
          name: span.name ?? '',
          kind: spanKindName(span.kind),
          service,
          scope: scopeName,
          startNs,
          endNs,
          durationMs: endNs > startNs ? Number((endNs - startNs) / 1000n) / 1000 : 0,
          statusCode: statusCodeName(span.status),
          statusMessage: span.status?.message ?? '',
          attributes: keyValuesToObject(span.attributes),
          resource,
          events: (span.events ?? []).map((ev) => ({
            timeNs: String(toBigIntNano(ev.timeUnixNano)),
            name: ev.name ?? '',
            attributes: keyValuesToObject(ev.attributes),
          })),
        });
      }
    }
  }
  return spans;
}

/** Decode an OTLP/HTTP trace export body based on its content type. */
export async function decodeTraceExport(body, contentType) {
  if (contentType.includes('application/json')) {
    return normalize(JSON.parse(body.toString('utf8')));
  }
  const type = await lookup('otlp.ExportTraceServiceRequest');
  const message = type.decode(body);
  return normalize(type.toObject(message, { longs: String, bytes: Buffer, defaults: false }));
}

/** Flatten a decoded ExportLogsServiceRequest into normalized log events. */
function normalizeLogs(request) {
  const events = [];
  for (const rl of request.resourceLogs ?? []) {
    const resource = keyValuesToObject(rl.resource?.attributes);
    const service = resource['service.name'] ?? 'unknown';
    for (const sl of rl.scopeLogs ?? []) {
      const scopeName = sl.scope?.name ?? '';
      for (const rec of sl.logRecords ?? []) {
        events.push({
          timeNs: toBigIntNano(rec.timeUnixNano ?? rec.observedTimeUnixNano),
          name: rec.eventName || anyValueToJs(rec.body) || '',
          severity: rec.severityText ?? '',
          service,
          scope: scopeName,
          traceId: bytesToHex(rec.traceId),
          spanId: bytesToHex(rec.spanId),
          attributes: keyValuesToObject(rec.attributes),
          resource,
        });
      }
    }
  }
  return events;
}

/** Decode an OTLP/HTTP logs export body based on its content type. */
export async function decodeLogsExport(body, contentType) {
  if (contentType.includes('application/json')) {
    return normalizeLogs(JSON.parse(body.toString('utf8')));
  }
  const type = await lookup('otlp.ExportLogsServiceRequest');
  const message = type.decode(body);
  return normalizeLogs(type.toObject(message, { longs: String, bytes: Buffer, defaults: false }));
}
