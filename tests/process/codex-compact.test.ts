import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { startCodexCompaction } from '../../src/agent/codex/compact';
import type { AgentEvent, AgentRun } from '../../src/agent/types';
import { createTmpProfile } from '../helpers/tmp-profile';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

describe('Codex native compaction process', () => {
  it('resumes the exact thread in the same home and completes without a user turn', async () => {
    const h = await fakeServer('success');
    const run = new CodexAdapter({
      binary: h.binary, profileStateDir: h.tmp.profile, inheritCodexHome: false,
      sandbox: 'danger-full-access', stopGraceMs: 100,
    }).compact({ runId: 'compact-1', cwd: h.tmp.workspace, threadId: 'thread-1', prompt: '', sandbox: 'read-only' });
    expect(await collect(run)).toEqual([{ type: 'done', threadId: 'thread-1', terminationReason: 'normal' }]);
    expect(await run.waitForExit(100)).toBe(true);
    const recorded = await h.read();
    expect(recorded.argv).toEqual(['app-server']);
    expect(recorded.home).toBe(join(h.tmp.profile, 'codex-home'));
    expect(recorded.messages.map((m: any) => m.method)).toEqual([
      'initialize', 'initialized', 'thread/resume', 'thread/compact/start',
    ]);
    expect(recorded.messages[2].params).toEqual({
      threadId: 'thread-1', cwd: h.tmp.workspace, sandbox: 'read-only', approvalPolicy: 'never',
    });
    expect(JSON.stringify(recorded.messages)).not.toContain('"/compact"');
  });

  it('accepts completion notifications that precede the compact RPC acknowledgement', async () => {
    const h = await fakeServer('late-ack');
    expect(await collect(h.run())).toEqual([{ type: 'done', threadId: 'thread-1', terminationReason: 'normal' }]);
  });

  it('emits actual model and the final context usage before completion, ignoring other turns and lifetime totals', async () => {
    const h = await fakeServer('telemetry');
    expect(await collect(h.run())).toEqual([
      { type: 'system', model: 'gpt-6-astra', effort: 'high' },
      { type: 'usage', contextTokens: 16_000, contextWindow: 258_400 },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
  });

  it.each(['telemetry-invalid', 'telemetry-total-only'])('drops stale usage when the final report is %s', async (mode) => {
    const h = await fakeServer(mode);
    const events = await collect(h.run());
    expect(events).toContainEqual({ type: 'system', model: 'gpt-6-astra', effort: 'high' });
    expect(events.some((event) => event.type === 'usage')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  });

  it('keeps a reported zero context usage', async () => {
    const h = await fakeServer('telemetry-zero');
    expect(await collect(h.run())).toContainEqual({ type: 'usage', contextTokens: 0, contextWindow: 258_400 });
  });

  it('does not present failed compaction usage as post-compaction context', async () => {
    const h = await fakeServer('telemetry-failed');
    const events = await collect(h.run());
    expect(events.some((event) => event.type === 'usage')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });

  it.each(['ack-only', 'item-only', 'wrong-thread', 'wrong-turn'])('does not report success for %s', async (mode) => {
    const h = await fakeServer(mode);
    const run = h.run(1000);
    expect(await collect(run)).toMatchObject([{ type: 'error', terminationReason: 'timeout' }]);
    expect(await run.waitForExit(100)).toBe(true);
  });

  it.each(['rpc-error', 'wrong-resume', 'failed', 'malformed', 'exit', 'close-stdout', 'interactive'])('reports %s as failure and reaps the process', async (mode) => {
    const h = await fakeServer(mode);
    const run = h.run();
    expect(await collect(run)).toMatchObject([{ type: 'error', terminationReason: 'failed' }]);
    expect(await run.waitForExit(100)).toBe(true);
    if (mode === 'wrong-resume') {
      expect((await h.read()).messages.map((m: any) => m.method)).not.toContain('thread/compact/start');
    }
  });

  it('stops an in-flight compact and escalates when the child ignores SIGTERM', async () => {
    const h = await fakeServer('ignore-stop');
    const run = h.run();
    await vi.waitFor(async () => {
      expect((await h.read()).messages.some((m: any) => m.method === 'thread/compact/start')).toBe(true);
    });
    await run.stop();
    expect(await collect(run)).toMatchObject([{ type: 'done', terminationReason: 'interrupted' }]);
    expect(await run.waitForExit(100)).toBe(true);
  });

  it('handles a missing binary without waiting for the compaction deadline', async () => {
    const h = await fakeServer('success');
    const run = startCodexCompaction({
      binary: join(h.tmp.root, 'missing'), env: process.env, stopGraceMs: 10,
      opts: { runId: 'missing', cwd: h.tmp.workspace, threadId: 'thread-1', prompt: '' },
    });
    expect(await collect(run)).toMatchObject([{ type: 'error', terminationReason: 'failed' }]);
  });

  it('rejects missing session identifiers and excluded user config before spawning', () => {
    const adapter = new CodexAdapter({ binary: 'must-not-run', profileStateDir: '/tmp/profile' });
    expect(() => adapter.compact({ runId: 'x', prompt: '', cwd: '/tmp/workspace' })).toThrow('threadId');
    const isolated = new CodexAdapter({ binary: 'must-not-run', profileStateDir: '/tmp/profile', ignoreUserConfig: true });
    expect(() => isolated.compact({ runId: 'x', prompt: '', cwd: '/tmp/workspace', threadId: 'thread-1' })).toThrow('ignoreUserConfig');
  });
});

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

async function fakeServer(mode: string) {
  const tmp = await createTmpProfile('codex-compact-');
  cleanup.push(tmp.cleanup);
  const binary = join(tmp.root, 'fake-codex.mjs');
  const recordPath = join(tmp.root, 'requests.json');
  await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
const messages = [];
const send = (message) => console.log(JSON.stringify(message));
const rl = createInterface({ input: process.stdin });
if (mode === 'ignore-stop') process.on('SIGTERM', () => {});
rl.on('line', (line) => {
  const m = JSON.parse(line);
  messages.push(m);
  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.CODEX_HOME, messages }));
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'thread/resume') send({ id: m.id, result: {
    thread: { id: mode === 'wrong-resume' ? 'other' : m.params.threadId },
    ...(mode.startsWith('telemetry') ? { model: 'gpt-6-astra', reasoningEffort: 'high' } : {}),
  } });
  if (m.method !== 'thread/compact/start') return;
  if (mode === 'rpc-error') { send({ id: m.id, error: { code: -32601, message: 'Method not found' } }); return; }
  if (mode === 'malformed') { console.log('bad-json'); return; }
  if (mode === 'exit') { process.exit(7); return; }
  if (mode === 'close-stdout') { process.stdout.end(); return; }
  if (mode === 'interactive') { send({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }); return; }
  if (mode !== 'late-ack') send({ id: m.id, result: {} });
  if (mode === 'ack-only' || mode === 'ignore-stop') return;
  const threadId = mode === 'wrong-thread' ? 'other' : m.params.threadId;
  const turnId = 'compact-turn';
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  const item = { type: 'contextCompaction', id: 'compact-item' };
  send({ method: 'item/started', params: { threadId, turnId, item } });
  if (mode.startsWith('telemetry')) {
    const usage = (totalTokens, tid = turnId, thread = threadId) => send({
      method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId: tid, tokenUsage: {
        last: totalTokens === undefined ? undefined : { totalTokens, cachedInputTokens: 10_000 },
        total: { totalTokens: 2_000_000 }, modelContextWindow: 258_400,
      } },
    });
    usage(90_000);
    usage(mode === 'telemetry-invalid' ? -1 : mode === 'telemetry-total-only' ? undefined : mode === 'telemetry-zero' ? 0 : 16_000);
    usage(700_000, turnId, 'unrelated-thread');
    usage(800_000, 'old-turn');
  }
  send({ method: 'item/completed', params: { threadId, turnId: mode === 'wrong-turn' ? 'other' : turnId, item } });
  if (mode === 'item-only') return;
  const failed = mode === 'failed' || mode === 'telemetry-failed';
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: failed ? 'failed' : 'completed', error: failed ? { message: 'model unavailable' } : null, items: [item] } } });
  if (mode === 'late-ack') send({ id: m.id, result: {} });
});
`, 'utf8');
  await chmod(binary, 0o755);
  const runs: AgentRun[] = [];
  cleanup.push(async () => { await Promise.all(runs.map((run) => run.stop())); });
  return {
    tmp, binary,
    read: async () => JSON.parse(await readFile(recordPath, 'utf8')),
    run(timeoutMs = 3000) {
      const run = startCodexCompaction({
        binary, env: process.env, stopGraceMs: 50, timeoutMs,
        opts: { runId: 'compact-1', cwd: tmp.workspace, threadId: 'thread-1', prompt: '' },
      });
      runs.push(run);
      return run;
    },
  };
}
