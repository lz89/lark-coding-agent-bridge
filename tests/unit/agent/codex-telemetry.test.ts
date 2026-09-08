import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCodexTelemetry } from '../../../src/agent/codex/telemetry';
import { renderFooterMeta } from '../../../src/card/run-footer';
import { initialState, withMeta } from '../../../src/card/run-state';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../../src/platform/spawn', async (original) => ({
  ...await original<typeof import('../../../src/platform/spawn')>(),
  spawnProcess: mocks.spawn,
}));
import { CodexAdapter } from '../../../src/agent/codex/adapter';

const thread = '01a07ef0-ee9e-7702-af6b-eb7af6e0996e';
const oldTime = '2026-09-08T01:00:00.000Z';
const now = '2026-09-08T02:00:00.000Z';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function context(model: string, effort: string, timestamp = now) {
  return { timestamp, type: 'turn_context', payload: { turn_id: timestamp, model, effort } };
}
function usage(tokens: unknown, timestamp = now) {
  return { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { total_tokens: 2_000_000 },
    last_token_usage: { total_tokens: tokens, input_tokens: 65_000, cached_input_tokens: 60_000 },
    model_context_window: 258_400,
  } } };
}
async function fixture(rows: unknown[], id = thread) {
  const root = await mkdtemp(join(tmpdir(), 'codex-telemetry-'));
  roots.push(root);
  const dir = join(root, 'sessions', '2026', '09', '08');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-2026-09-08T01-00-00-${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return root;
}

describe('Codex footer telemetry', () => {
  it('uses the last request, including cached tokens once, and renders actual model/effort', async () => {
    const root = await fixture([
      context('old-model', 'low', oldTime), usage(100_000, oldTime),
      context('gpt-6-astra', 'high'), usage(62_000), usage(66_412),
    ]);
    const events = await readCodexTelemetry(root, thread, Date.parse(now));
    let state = initialState;
    for (const event of events) {
      if (event.type === 'system') state = withMeta(state, { model: event.model, effort: event.effort });
      if (event.type === 'usage') state = withMeta(state, { contextTokens: event.contextTokens, contextWindow: event.contextWindow });
    }
    expect(renderFooterMeta(state.meta)).toBe('🧠 66K / 26% · gpt-6-astra · high');
  });

  it('does not reuse a previous turn or another thread', async () => {
    const root = await fixture([context('old-model', 'low', oldTime), usage(100_000, oldTime)]);
    expect(await readCodexTelemetry(root, thread, Date.parse(now))).toEqual([]);
    expect(await readCodexTelemetry(root, '01a07ef0-ee9e-7702-af6b-eb7af6e0996f', 0)).toEqual([]);
    expect(await readCodexTelemetry(root, '../escape', 0)).toEqual([]);
  });

  it('drops missing or invalid counts instead of using cumulative totals', async () => {
    for (const value of [undefined, -1, '66412', 200_000_000]) {
      const root = await fixture([context('gpt-6-astra', 'high'), usage(value)]);
      expect(await readCodexTelemetry(root, thread, 0)).toEqual([
        { type: 'system', model: 'gpt-6-astra', effort: 'high' },
      ]);
    }
    expect(await readCodexTelemetry('/missing-codex-home', thread, 0)).toEqual([]);
  });

  it('clears context when the turn changes and tolerates truncated records', async () => {
    const root = await fixture([usage(100_000, oldTime), context('gpt-6-astra', 'high'), null]);
    const file = join(root, 'sessions/2026/09/08', `rollout-2026-09-08T01-00-00-${thread}.jsonl`);
    await writeFile(file, '{"type":', { flag: 'a' });
    expect(await readCodexTelemetry(root, thread, 0)).toEqual([
      { type: 'system', model: 'gpt-6-astra', effort: 'high' },
    ]);
  });

  it.each([false, true])('adapter enriches the reply before completion (resume=%s)', async (resume) => {
    const future = new Date(Date.now() + 1000).toISOString();
    const root = await fixture([context('gpt-6-astra', 'high', future), usage(66_412, future)]);
    const child = Object.assign(new EventEmitter(), {
      pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: 0, signalCode: null, kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    const adapter = new CodexAdapter({ binary: 'codex', profileStateDir: root, codexHome: root });
    const run = adapter.run({ runId: 'test', cwd: root, prompt: 'hello', ...(resume ? { threadId: thread } : {}) });
    child.stdout.end([
      ...(resume ? [] : [{ type: 'thread.started', thread_id: thread }]),
      { type: 'item.completed', item: { type: 'agent_message', text: 'hello' } },
      { type: 'turn.completed', usage: { input_tokens: 2_000_000 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const events = [];
    for await (const event of run.events) events.push(event);
    expect(events).toContainEqual({ type: 'system', model: 'gpt-6-astra', effort: 'high' });
    const contextIndex = events.findIndex(event => event.type === 'usage' && event.contextTokens === 66_412);
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(contextIndex).toBeLessThan(events.findIndex(event => event.type === 'final_text'));
    expect(events.at(-1)?.type).toBe('done');
  });
});
