import type { NormalizedMessage } from '@larksuite/channel';
import { existsSync } from 'node:fs';
import { realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
  SendResult,
} from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import {
  DEFAULT_TOOL_STALL_GRACE_MINUTES,
  DEFAULT_TOOL_STALL_TIMEOUT_MINUTES,
} from '../../../src/config/schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

const MINUTE = 60_000;
const DEBOUNCE_MS = 600;
const WARN = DEFAULT_TOOL_STALL_TIMEOUT_MINUTES;
const GRACE = DEFAULT_TOOL_STALL_GRACE_MINUTES;

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Drain the microtask chains: dispatcher preparation, receipts, renders. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
}

/**
 * A run starts only after real file I/O (wake inbox, attachment cache), which
 * fake timers cannot advance; yielding to the event loop while nudging the
 * clock lets both the debounce and the I/O get there.
 */
async function waitForRun(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < 200 && h.agent.runOptions.length < n; i++) {
    await vi.advanceTimersByTimeAsync(20);
    await settle();
  }
  expect(h.agent.runOptions.length).toBeGreaterThanOrEqual(n);
  await h.agent.started(n);
}

/** First message of a scope: through the debounce and into a run. */
async function startRun(h: Harness, msg: NormalizedMessage): Promise<void> {
  await h.channel.handlers.message?.(msg);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
  await waitForRun(h, 1);
}

/** A message sent while a run is going: through the debounce, to the dispatcher. */
async function sendMidRun(h: Harness, msg: NormalizedMessage): Promise<void> {
  await h.channel.handlers.message?.(msg);
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
  await settle();
}

async function emit(h: Harness, evt: AgentEvent): Promise<void> {
  await h.agent.emit(evt);
  await settle();
}

async function finishRun(h: Harness): Promise<void> {
  await emit(h, { type: 'done', terminationReason: 'normal' });
  // Run teardown, dispatcher retirement, and the re-armed quiet window.
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
  await settle();
}

describe('steering: a message that arrives mid-run', () => {
  it('is handed to the running turn, and shown on the reply once the agent takes it in', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', '把按钮改成红色'));
    await emit(h, { type: 'text', delta: '开始改…' });

    await sendMidRun(h, message('om_2', '等等，改成蓝色'));

    expect(h.agent.sends).toHaveLength(1);
    const steer = h.agent.sends[0]!;
    expect(steer.text).toContain('<bridge_steer>');
    expect(steer.text).toContain('"kind":"mid-run"');
    expect(steer.text).toContain('"messageIds":["om_2"]');
    expect(steer.text).toContain('[User (user)]: 等等，改成蓝色');
    expect(steer.text).toContain('不是新的一轮');
    expect(steer.text).not.toContain('闭环模式提示');
    // Still one run — nothing was queued for later.
    expect(h.agent.runOptions).toHaveLength(1);

    // Before the receipt the card shows nothing of it; after, it is quoted.
    expect(h.lastCardJson()).not.toContain('改成蓝色');
    await emit(h, { type: 'user_input', uuid: steer.uuid, text: '[User (user)]: 等等，改成蓝色' });
    expect(h.lastCardJson()).toContain('> 💬 [User (user)]: 等等，改成蓝色');
    await emit(h, { type: 'text', delta: '好，蓝色。' });

    await finishRun(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('merges several quick messages into one steer, each with its sender', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await h.channel.handlers.message?.(message('om_2', '第一条'));
    await vi.advanceTimersByTimeAsync(200);
    await h.channel.handlers.message?.(
      message('om_3', '第二条', { senderId: 'ou_other', senderName: 'Other' }),
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
    await settle();

    expect(h.agent.sends).toHaveLength(1);
    const text = h.agent.sends[0]!.text;
    expect(text).toContain('"messageIds":["om_2","om_3"]');
    expect(text).toContain('[User (user)]: 第一条');
    expect(text).toContain('[Other (user)]: 第二条');
    expect(text.indexOf('第一条')).toBeLessThan(text.indexOf('第二条'));
  });

  it('keeps a message the run cannot take as text for the next run, and everything after it', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    // An interactive card needs its structured body; the plain text after it
    // could go in, but must not overtake it.
    await sendMidRun(h, message('om_2', '看这张卡片', { rawContentType: 'interactive' } as never));
    await sendMidRun(h, message('om_3', '然后这个'));
    expect(h.agent.sends).toHaveLength(0);

    await finishRun(h);
    await waitForRun(h, 2);
    const next = h.agent.runOptions[1]!.prompt;
    expect(next).toContain('om_2');
    expect(next).toContain('om_3');
    expect(next.indexOf('看这张卡片')).toBeLessThan(next.indexOf('然后这个'));
  });

  it('never steers the task a /goal command generates; the goal starts after the run', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '/goal 把测试修绿'));
    expect(h.agent.sends).toHaveLength(0);
    expect(h.agent.runOptions).toHaveLength(1);

    await finishRun(h);
    await waitForRun(h, 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('闭环模式(第 1/');
    expect(h.agent.runOptions[1]!.prompt).toContain('把测试修绿');
  });

  it('does not clear a stall warning or rewind the watchdog', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'tool_use', id: 't1', name: 'Bash', input: {} });
    await vi.advanceTimersByTimeAsync(WARN * MINUTE + 100);
    expect(h.lastCardJson()).toContain(`工具 Bash 已 ${WARN} 分钟无输出`);

    await sendMidRun(h, message('om_2', '还在吗'));
    const steer = h.agent.sends[0]!;
    await emit(h, { type: 'user_input', uuid: steer.uuid, text: '[User (user)]: 还在吗' });
    // The receipt is rendered, and the warning is still there next to it.
    expect(h.lastCardJson()).toContain('还在吗');
    expect(h.lastCardJson()).toContain('无输出');
    expect(h.agent.stopped).toBe(false);

    // The kill still lands on the original schedule.
    await vi.advanceTimersByTimeAsync(GRACE * MINUTE + 100);
    expect(h.agent.stopped).toBe(true);
  });

  it('re-delivers a message the run ended without taking in', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '补一句'));
    const steer = h.agent.sends[0]!;
    await emit(h, { type: 'input_dropped', uuids: [steer.uuid] });
    await finishRun(h);

    await waitForRun(h, 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('补一句');
  });

  it('re-delivers a message whose receipt never came, even without a drop report', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '没收到的'));
    expect(h.agent.sends).toHaveLength(1);
    // The run ends with no receipt and no drop report at all.
    await finishRun(h);

    await waitForRun(h, 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('没收到的');
  });

  it('counts a receipt the render loop never saw, so the message is not sent twice', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '只发一次'));
    const steer = h.agent.sends[0]!;
    // Kill the render loop without touching the dispatcher: the next card
    // update throws, the stream is abandoned, and everything after that is
    // seen only by the receipt ledger.
    h.channel.failCardUpdatesFrom = h.channel.cardUpdates.length + 1;
    await emit(h, { type: 'text', delta: '这条会让渲染失败' });
    await emit(h, { type: 'user_input', uuid: steer.uuid, text: '[User (user)]: 只发一次' });
    await finishRun(h);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    await settle();

    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('without that receipt, the same render failure leads to re-delivery', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '要重发的'));
    h.channel.failCardUpdatesFrom = h.channel.cardUpdates.length + 1;
    await emit(h, { type: 'text', delta: '这条会让渲染失败' });
    await finishRun(h);

    await waitForRun(h, 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('要重发的');
  });

  it('falls back to the old serial behaviour for an agent that cannot be steered', async () => {
    const h = await createHarness({}, { steerable: false });
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '后来的'));
    expect(h.agent.runOptions).toHaveLength(1);

    await finishRun(h);
    await waitForRun(h, 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('后来的');
  });

  it('/stop drops what the dispatcher was holding, as it drops the queue', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '卡片', { rawContentType: 'interactive' } as never));
    await h.channel.handlers.message?.(message('om_3', '/stop'));
    await settle();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    await settle();

    expect(h.agent.stopped).toBe(true);
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('a turn that only took in a message and said nothing is not an answer', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', 'go'));

    await sendMidRun(h, message('om_2', '算了'));
    const steer = h.agent.sends[0]!;
    await emit(h, { type: 'user_input', uuid: steer.uuid, text: '[User (user)]: 算了' });
    await finishRun(h);

    // No progress stream was opened for the receipt alone, and no fallback
    // reply was posted for a state with nothing from the agent in it.
    expect(JSON.stringify(h.channel.cardUpdates)).not.toContain('算了');
    expect(JSON.stringify(h.channel.sent)).not.toContain('算了');
  });

  it('in a /goal round the steer hands out a fresh signal path, and only that one counts', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', '/goal 修好所有测试'));
    const prompt = h.agent.runOptions[0]!.prompt;
    expect(prompt).toContain('闭环模式(第 1/');
    // Every prompt section is JSON-encoded, so the path arrives with escaped
    // quotes around it — match the path itself.
    const roundPath = /([^\s"\\]+\.continue)/.exec(prompt)?.[1];
    expect(roundPath).toBeTruthy();
    await emit(h, { type: 'text', delta: '…' });

    await sendMidRun(h, message('om_2', '先别管 flaky 的'));
    expect(h.agent.sends).toHaveLength(1);
    const steer = h.agent.sends[0]!;
    expect(steer.text).toContain('闭环模式提示');
    const steerPath = /([^\s"\\]+\.continue\.steer1)/.exec(steer.text)?.[1];
    expect(steerPath).toBe(`${roundPath}.steer1`);
    await emit(h, { type: 'user_input', uuid: steer.uuid, text: '[User (user)]: 先别管 flaky 的' });

    // The agent asked to continue on the round's original path — before it
    // read the message, or from something it detached that wrote late. Only
    // the path the message named decides the round; that one was left empty.
    await writeFile(roundPath!, '继续修 flaky');
    await finishRun(h);
    // The verdict comes after the stale file is removed and the effective one
    // read — real file I/O, so yield until the notice has gone out.
    const goalClosed = (): boolean =>
      h.channel.sent.some((s) => JSON.stringify(s.content).includes('闭环模式结束'));
    for (let i = 0; i < 200 && !goalClosed(); i++) await settle();

    expect(existsSync(roundPath!)).toBe(false);
    expect(existsSync(steerPath!)).toBe(false);
    // The goal closed instead of running a round on the stale reason.
    expect(goalClosed()).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    await settle();
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('in a /goal round, a continue written to the path the steer named is honoured', async () => {
    const h = await createHarness();
    await startTestBridge(h);
    vi.useFakeTimers();

    await startRun(h, message('om_1', '/goal 修好所有测试'));
    await emit(h, { type: 'text', delta: '…' });
    await sendMidRun(h, message('om_2', '先别管 flaky 的'));
    const steer = h.agent.sends[0]!;
    const steerPath = /([^\s"\\]+\.continue\.steer1)/.exec(steer.text)?.[1];
    expect(steerPath).toBeTruthy();
    await emit(h, { type: 'user_input', uuid: steer.uuid, text: '[User (user)]: 先别管 flaky 的' });

    await writeFile(steerPath!, '接着修剩下的');
    await finishRun(h);

    await waitForRun(h, 2);
    expect(h.agent.runOptions[1]!.prompt).toContain('闭环续跑 · 第 2 轮');
    expect(h.agent.runOptions[1]!.prompt).toContain('接着修剩下的');
  });
});

/**
 * An agent whose event stream is driven by the test, and that can be handed
 * messages while a run is going: `send` records the text and returns a uuid
 * the test later echoes back as a `user_input` receipt (or reports dropped).
 */
class ControllableAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly runOptions: AgentRunOptions[] = [];
  readonly sends: Array<{ text: string; uuid: string }> = [];
  stopped = false;
  botIdentity: AgentBotIdentity | undefined;
  #steerable: boolean;
  #push: ((evt: AgentEvent) => void) | undefined;
  #end: (() => void) | undefined;
  #accepting = false;
  /** One deferred per run index (1-based), resolved when its stream is first pulled. */
  #startedDeferreds: Array<{ promise: Promise<void>; resolve: () => void }> = [];

  constructor(opts: { steerable?: boolean } = {}) {
    this.#steerable = opts.steerable ?? true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  /** Resolves once the n-th run's event stream is being consumed. */
  started(n: number): Promise<void> {
    return this.#deferred(n).promise;
  }

  async emit(evt: AgentEvent): Promise<void> {
    await this.started(Math.max(1, this.runOptions.length));
    this.#push?.(evt);
    await Promise.resolve();
    await Promise.resolve();
  }

  run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    const index = this.runOptions.length;
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    this.#accepting = true;
    this.#push = (evt) => {
      queue.push(evt);
      if (evt.type === 'done' || evt.type === 'error') this.#accepting = false;
      wake?.();
    };
    this.#end = () => {
      ended = true;
      this.#accepting = false;
      wake?.();
    };
    const self = this;
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      self.#deferred(index).resolve();
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = undefined;
            resolve();
          };
        });
      }
    })();
    const run: AgentRun = {
      runId: opts.runId,
      events,
      stop: async () => {
        this.stopped = true;
        this.#end?.();
      },
      waitForExit: async () => true,
    };
    if (this.#steerable) {
      run.send = (text: string): SendResult => {
        if (!this.#accepting) return { ok: false, reason: 'closed' };
        const uuid = `steer-${this.sends.length + 1}`;
        this.sends.push({ text, uuid });
        return { ok: true, uuid };
      };
    }
    return run;
  }

  #deferred(n: number): { promise: Promise<void>; resolve: () => void } {
    while (this.#startedDeferreds.length < n) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.#startedDeferreds.push({ promise, resolve });
    }
    return this.#startedDeferreds[n - 1]!;
  }
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness(
  preferences: Record<string, unknown> = {},
  agentOpts: { steerable?: boolean } = {},
): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: ControllableAgent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
  lastCardJson: () => string;
}> {
  const tmp = await createTmpProfile('steering-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user', 'ou_other'] },
    preferences: { messageReply: 'card', ...preferences },
  });
  const profileConfig = {
    ...base,
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new ControllableAgent(agentOpts);
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls: createControls(profileConfig),
    lastCardJson: () => JSON.stringify(channel.cardUpdates.at(-1) ?? {}),
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: ControllableAgent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  /** Make streaming card updates throw from the Nth call on. */
  failCardUpdatesFrom?: number;
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown }>;
  cardUpdates: unknown[];
  rawClient: Record<string, unknown>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const cardUpdates: unknown[] = [];
  let updateCalls = 0;
  const self: FakeLarkChannel = {
    handlers,
    sent,
    cardUpdates,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })),
          },
        },
      },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(next) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content) {
      sent.push({ chatId, content });
      const card = (content as { card?: unknown } | undefined)?.card;
      if (card) cardUpdates.push(card);
      return { messageId: `sent_${sent.length}` };
    },
    async stream(_chatId, input) {
      const cardInput = input as
        | { card?: { producer?: (ctrl: { update(c: unknown): Promise<void> }) => Promise<void> } }
        | undefined;
      if (typeof cardInput?.card?.producer === 'function') {
        await cardInput.card.producer({
          async update(card) {
            updateCalls += 1;
            if (self.failCardUpdatesFrom !== undefined && updateCalls >= self.failCardUpdatesFrom) {
              throw new Error('card update rejected by Feishu (simulated 400)');
            }
            cardUpdates.push(card);
          },
        });
      }
    },
    async recallMessage() {},
    async addReaction() {
      return 'r1';
    },
    async removeReaction() {},
  };
  return self;
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(
  messageId: string,
  content: string,
  extra: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
    raw: { sender: { sender_type: 'user' } },
    ...extra,
  } as unknown as NormalizedMessage;
}
