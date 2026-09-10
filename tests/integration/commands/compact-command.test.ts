import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import { ProcessPool } from '../../../src/bot/process-pool';
import { commandSessionCatalogIdentity } from '../../../src/bot/session-catalog-identity';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { canUseDm } from '../../../src/policy/access';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import type { AgentAdapter, AgentEvent, AgentRunOptions } from '../../../src/agent/types';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe('/compact command', () => {
  it('includes the model, effort and compacted context in the success reply footer', async () => {
    const h = await harness(false, [
      { type: 'system', model: 'gpt-6-astra', effort: 'high' },
      { type: 'usage', contextTokens: 16_000, contextWindow: 258_400 },
    ]);
    const task = h.run('/compact');
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledTimes(1));
    expect(h.markdown()).not.toContain('🧠');
    h.finish({ type: 'done', threadId: 'thread-1', terminationReason: 'normal' });
    await task;
    expect(h.markdown()).toBe('✓ 当前会话上下文已压缩，可以继续对话。\n\n---\n🧠 16K / 6% · gpt-6-astra · high');
  });

  it('marks missing telemetry explicitly without substituting profile defaults', async () => {
    const h = await harness(false, [{ type: 'system', model: 'gpt-6-astra' }]);
    const task = h.run('/compact');
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledTimes(1));
    h.finish({ type: 'done', terminationReason: 'normal' });
    await task;
    expect(h.markdown()).toContain('🧠 gpt-6-astra · context 未返回');
    expect(h.markdown()).not.toContain('0%');
  });

  it('uses the catalog thread and executor, retains queued messages and preserves the session', async () => {
    const h = await harness();
    const before = h.catalog.activeFor(h.identity);
    const task = h.run('/compact');
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledTimes(1));
    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.compact.mock.calls[0]?.[0]).toMatchObject({
      prompt: '', threadId: 'thread-1', cwd: h.identity.cwdRealpath,
    });
    expect(h.keepPending).toHaveBeenCalled();
    expect(h.activeRuns.get(h.ctx.scope)).toBeDefined();
    expect(h.pool.snapshot().active).toBe(1);
    expect(h.markdown()).not.toContain('上下文已压缩');
    h.finish({ type: 'done', threadId: 'thread-1', terminationReason: 'normal' });
    await task;
    expect(h.markdown()).toContain('上下文已压缩');
    expect(h.markdown()).toContain('🧠 context 未返回 · 模型未返回');
    expect(h.catalog.activeFor(h.identity)).toEqual(before);
    expect(h.sessions.getRaw(h.ctx.scope)).toBeUndefined();
    expect(h.activeRuns.get(h.ctx.scope)).toBeUndefined();
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('rejects a second compact while the first is active, then supports /stop', async () => {
    const h = await harness();
    const task = h.run('/compact');
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledTimes(1));
    await h.run('/compact');
    expect(h.markdown()).toContain('任务运行中');
    expect(h.compact).toHaveBeenCalledTimes(1);
    await h.run('/stop');
    await task;
    expect(h.markdown()).toContain('已停止压缩');
    expect(h.pool.snapshot().active).toBe(0);
    expect(h.catalog.activeFor(h.identity)?.threadId).toBe('thread-1');
  });

  it('does not fall back to a legacy session or another policy identity', async () => {
    const h = await harness();
    h.catalog.archiveActive({ ...h.identity, now: Date.now() });
    h.sessions.set(h.ctx.scope, 'legacy-thread', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, policyFingerprint: 'different', threadId: 'other-thread', now: Date.now() });
    await h.run('/compact');
    expect(h.markdown()).toContain('没有可压缩');
    expect(h.compact).not.toHaveBeenCalled();
  });

  it('isolates topic sessions and replies in the originating topic', async () => {
    const h = await harness(true);
    h.catalog.upsertActive({ ...h.identity, scopeId: 'chat-1:other-topic', threadId: 'other', now: Date.now() });
    const task = h.run('/compact');
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledTimes(1));
    expect(h.compact.mock.calls[0]?.[0].threadId).toBe('thread-1');
    expect(h.activeRuns.get('chat-1:topic-1')).toBeDefined();
    h.finish({ type: 'done', threadId: 'thread-1', terminationReason: 'normal' });
    await task;
    expect(h.channel.sent.at(-1)?.options).toMatchObject({ replyInThread: true, replyTo: 'message-1' });
  });

  it.each(['failed', 'timeout'] as const)('reports %s without claiming success or changing sessions', async (terminationReason) => {
    const h = await harness();
    const task = h.run('/compact');
    await vi.waitFor(() => expect(h.compact).toHaveBeenCalledTimes(1));
    h.finish({ type: 'error', terminationReason, message: 'sensitive backend detail' });
    await task;
    expect(h.markdown()).toContain(terminationReason === 'timeout' ? '超时' : '失败');
    expect(h.markdown()).not.toContain('sensitive');
    expect(h.catalog.activeFor(h.identity)?.threadId).toBe('thread-1');
    expect(h.pool.snapshot().active).toBe(0);
  });

  it('rejects unsupported agents, arguments, and denied users without spawning', async () => {
    const h = await harness();
    await h.run('/compact custom instructions');
    expect(h.markdown()).toContain('不带参数');
    h.ctx.controls.profileConfig.agentKind = 'claude';
    await h.run('/compact');
    expect(h.markdown()).toContain('仅支持 Codex');
    h.ctx.controls.profileConfig.agentKind = 'codex';
    h.ctx.msg.senderId = 'not-allowed';
    await h.run('/compact');
    expect(h.markdown()).toContain('无权');
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.keepPending).toHaveBeenCalledTimes(3);
  });

  it('rejects a reserved scope or full pool and keeps the queue intact', async () => {
    const h = await harness();
    const release = h.activeRuns.reserve(h.ctx.scope)!;
    await h.run('/compact');
    expect(h.markdown()).toContain('任务运行中');
    release();
    const releasePool = h.pool.tryAcquire()!;
    await h.run('/compact');
    expect(h.markdown()).toContain('资源暂不可用');
    releasePool();
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.keepPending).toHaveBeenCalledTimes(2);
  });

  it('reports spawn failure and releases the reservation and pool slot', async () => {
    const h = await harness();
    h.compact.mockImplementationOnce(() => { throw new Error('missing app-server'); });
    await h.run('/compact');
    expect(h.markdown()).toContain('无法启动压缩');
    expect(h.pool.snapshot().active).toBe(0);
    const release = h.activeRuns.reserve(h.ctx.scope);
    expect(release).toBeTypeOf('function');
    release?.();
  });
});

describe('maintenance queue holds', () => {
  it('retains messages until both maintenance holds and run blocking are released', async () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const pending = new PendingQueue(10, flush);
    const msg = { content: 'next' } as CommandContext['msg'];
    pending.push('scope', msg);
    const release = pending.hold('scope');
    const releaseSecond = pending.hold('scope');
    await vi.advanceTimersByTimeAsync(20);
    expect(flush).not.toHaveBeenCalled();
    pending.block('scope');
    release();
    release();
    releaseSecond();
    await vi.advanceTimersByTimeAsync(20);
    expect(flush).not.toHaveBeenCalled();
    pending.unblock('scope');
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('scope', [msg]);
  });

  it('does not let run cleanup unblock an ongoing compact', async () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const pending = new PendingQueue(10, flush);
    pending.block('scope');
    const release = pending.hold('scope');
    pending.push('scope', { content: 'next' } as CommandContext['msg']);
    pending.unblock('scope');
    await vi.advanceTimersByTimeAsync(20);
    expect(flush).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

async function harness(topic = false, metadata: AgentEvent[] = []) {
  const tmp = await createTmpProfile('compact-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const profile = createDefaultProfileConfig({
    agentKind: 'codex', accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
    access: { admins: ['user-1'], allowedChats: ['chat-1'] },
  });
  profile.workspaces.default = tmp.workspace;
  const controls: Controls = {
    profile: 'codex', profileConfig: profile, cfg: profile, botOwnerId: 'user-1', ownerRefreshState: 'ok',
    refreshOwner: async () => {}, restart: async () => {}, exit: async () => {},
    configPath: join(tmp.profile, 'config.json'), processId: 'proc',
  };
  let finish!: (event: AgentEvent) => void;
  const completion = new Promise<AgentEvent>((resolve) => { finish = resolve; });
  const compact = vi.fn((opts: AgentRunOptions) => ({
    runId: opts.runId,
    events: { async *[Symbol.asyncIterator]() { yield* metadata; yield await completion; } },
    stop: async () => { finish({ type: 'done', terminationReason: 'interrupted' }); },
    waitForExit: async () => true,
  }));
  const agent: AgentAdapter = {
    id: 'codex', displayName: 'Codex CLI', isAvailable: async () => true,
    run: vi.fn(() => { throw new Error('must not submit a user turn'); }), compact,
  };
  const pending = new PendingQueue(60_000, () => {});
  const keepPending = vi.fn();
  const ctx: CommandContext = {
    channel: channel as unknown as CommandContext['channel'],
    msg: { chatId: 'chat-1', senderId: 'user-1', messageId: 'message-1', content: '',
      chatType: topic ? 'group' : 'p2p', ...(topic ? { threadId: 'topic-1' } : {}),
    } as CommandContext['msg'],
    scope: topic ? 'chat-1:topic-1' : 'chat-1', chatMode: topic ? 'topic' : 'p2p',
    sessions, sessionCatalog: catalog, workspaces, agent, activeRuns, controls,
    runExecutor: new RunExecutor({ agent, activeRuns, pool }),
    keepPending, holdPending: () => pending.hold(topic ? 'chat-1:topic-1' : 'chat-1'),
  };
  const identity = (await commandSessionCatalogIdentity({
    msg: ctx.msg, scope: ctx.scope, mode: ctx.chatMode, workspaces, controls,
    access: canUseDm(profile, controls, 'user-1'),
  }))!;
  catalog.upsertActive({ ...identity, threadId: 'thread-1', now: Date.now() });
  cleanups.push(async () => {
    finish({ type: 'done', terminationReason: 'interrupted' });
    await activeRuns.stopAll();
    pending.cancelAll();
    await Promise.all([sessions.flush(), catalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    ctx, agent, compact, activeRuns, pool, catalog, identity, sessions, channel, keepPending, finish,
    run: (content: string) => tryHandleCommand({ ...ctx, msg: { ...ctx.msg, content } }),
    markdown: () => (channel.sent.at(-1)?.content as { markdown: string } | undefined)?.markdown ?? '',
  };
}
