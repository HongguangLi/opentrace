// Minimal smoke tests: exercise the semantic extraction that turns raw
// OTLP attributes into unified fields, across the conventions AgentTap
// supports. No network or DB needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSemantics, extractSessionId, extractUserId } from '../src/semantics.js';

test('GenAI conventions: model + token usage', () => {
  const s = extractSemantics({
    name: 'chat',
    attributes: {
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
    },
    events: [],
  });
  assert.equal(s.model, 'gpt-4o');
  assert.equal(s.promptTokens, 100);
  assert.equal(s.completionTokens, 20);
  assert.equal(s.totalTokens, 120);
  assert.equal(s.spanType, 'llm');
});

test('NeMo Relay: output content + usage from *_json payloads', () => {
  const s = extractSemantics({
    name: 'nvidia-api',
    attributes: {
      'nemo_relay.model_name': 'claude-opus',
      'nemo_relay.end.output_json': JSON.stringify({
        content: 'hi there',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    },
    events: [],
  });
  assert.equal(s.model, 'claude-opus');
  assert.equal(s.outputText, 'hi there');
  assert.equal(s.promptTokens, 5);
});

test('session + user extraction', () => {
  const attrs = { 'session.id': 'sess-1', 'user.id': 'user-9' };
  assert.equal(extractSessionId(attrs), 'sess-1');
  assert.equal(extractUserId(attrs, ''), 'user-9');
  // OpenClaw Feishu open-id fallback from message text
  assert.equal(extractUserId({}, '[user] ou_2b02c83ce1a3023ab0b434e000eeb7d7: hi'), 'ou_2b02c83ce1a3023ab0b434e000eeb7d7');
});
