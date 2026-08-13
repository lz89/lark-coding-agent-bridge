import type { NormalizedMessage } from '@larksuite/channel';
import { writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { goalSignalPath, prepareGoalSignal } from '../../../src/bot/goal.js';

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

const SCOPE = 'oc_dm';
/** How long each scripted round stays in flight. See `ScriptedAgent.run`. */
const ROUND_HOLD_MS = 200;
/**
 * How long to keep watching after the expected rounds have run.
 *
 * Continuation rounds chain directly (no debounce between them), so an
 * unexpected extra round starts within milliseconds of the previous one
 * ending — this only has to outlast that.
 */
const QUIET_MS = 400;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * `/goal` — the bridge keeps starting rounds until the agent stops asking for
 * one. What makes this worth an integration test rather than a unit test of
 * `GoalController` is that a round has to be a *real* run through the whole
 * batch path: same session, same card routing, same watchdogs.
 */
describe('loop continuation', () => {
  it('keeps running rounds until the agent stops asking for another', async () => {
    // Rounds 1 and 2 leave a continuation reason; round 3 doesn't.
    const h = await createHarness(['先起构建', '等 make 收尾', undefined]);
    await startTestBridge(h);

    await h.send('/goal 部署并跑出基线数字');
    await h.settleAt(3);

    expect(h.agent.prompts).toHaveLength(3);
    // The goal is restated every round, not just the first.
    for (const prompt of h.agent.prompts) expect(prompt).toContain('部署并跑出基线数字');
    expect(h.agent.prompts[0]).toContain('第 1/20 轮');
    expect(h.agent.prompts[1]).toContain('第 2/20 轮');
    expect(h.agent.prompts[1]).toContain('先起构建');
    expect(h.agent.prompts[2]).toContain('等 make 收尾');

    expect(h.texts().at(-1)).toContain('目标已达成');
  });

  it('does not run extra rounds without /goal', async () => {
    // Same agent behaviour — writing a signal file is inert unless a loop is
    // armed, so a stray write can never start an unattended run.
    const h = await createHarness(['还没完呢', '还是没完']);
    await startTestBridge(h);

    await h.send('随便问一句');
    await h.settleAt(1);

    expect(h.agent.prompts).toHaveLength(1);
    expect(h.agent.prompts[0]).not.toContain('闭环模式');
  });

  it('gives each round its own signal path', async () => {
    const h = await createHarness(['继续', undefined]);
    await startTestBridge(h);

    await h.send('/goal 目标');
    await h.settleAt(2);

    const paths = h.agent.prompts.map((p) => /(\/[^\s"]*\.continue)/.exec(p)?.[1]);
    expect(paths[0]).toBeTruthy();
    expect(paths[1]).toBeTruthy();
    // Reusing round 1's path would mean round 2's "done" reads as round 1's
    // leftover "continue" — the loop would never end.
    expect(paths[0]).not.toBe(paths[1]);
  });

  it('stops at the configured round ceiling and says so', async () => {
    // Never stops asking for another round.
    const h = await createHarness(Array.from({ length: 10 }, (_, i) => `第 ${i} 步`), {
      goalMaxRounds: 3,
    });
    await startTestBridge(h);

    await h.send('/goal 无限任务');
    await h.settleAt(3);

    expect(h.agent.prompts).toHaveLength(3);
    expect(h.texts().at(-1)).toContain('轮数上限');
  });

  it('stops when the agent repeats one blocker instead of progressing', async () => {
    const h = await createHarness(['在等编译', '在等编译', '在等编译', '在等编译']);
    await startTestBridge(h);

    await h.send('/goal 目标');
    await h.settleAt(3);

    expect(h.agent.prompts).toHaveLength(3);
    expect(h.texts().at(-1)).toContain('卡住');
  });

  it('/stop ends the loop even after the round wrote its signal', async () => {
    const h = await createHarness(['继续', '继续', undefined]);
    await startTestBridge(h);

    await h.send('/goal 目标');
    // Let round 1 start and write its continuation signal, then stop.
    await h.waitForRuns(1);
    await h.send('/stop');
    await h.settleAt(1);

    // Round 2 must not start: the signal was already on disk when /stop ran.
    expect(h.agent.prompts).toHaveLength(1);
    expect(h.texts().some((t) => t.includes('取消'))).toBe(true);
  });

  it('folds a message sent mid-loop into the next round', async () => {
    const h = await createHarness(['继续', undefined]);
    await startTestBridge(h);

    await h.send('/goal 目标');
    await h.waitForRuns(1);
    await h.send('顺便把日志也贴出来');
    await h.settleAt(2);

    expect(h.agent.prompts).toHaveLength(2);
    // Without this the steer would sit queued until the whole loop finished.
    expect(h.agent.prompts[1]).toContain('顺便把日志也贴出来');
  });

  it('refuses to start a second loop over a running one', async () => {
    const h = await createHarness(['继续', undefined]);
    await startTestBridge(h);

    await h.send('/goal 第一个目标');
    await h.waitForRuns(1);
    await h.send('/goal 第二个目标');
    await h.settleAt(2);

    expect(h.texts().some((t) => t.includes('已经有闭环任务在跑'))).toBe(true);
    for (const prompt of h.agent.prompts) expect(prompt).not.toContain('第二个目标');
  });
});

/**
 * An agent scripted per round: round N emits `第N轮进度` and, if the script has
 * a reason for that round, writes it to that round's signal file — exactly what
 * a real agent does with the Bash tool when it isn't finished.
 */
class ScriptedAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly prompts: string[] = [];
  botIdentity: AgentBotIdentity | undefined;
  #round = 0;

  constructor(private readonly script: Array<string | undefined>) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  run(opts: AgentRunOptions): AgentRun {
    this.prompts.push(opts.prompt);
    const round = ++this.#round;
    const reason = this.script[round - 1];
    const events = (async function* (): AsyncGenerator<AgentEvent> {
      if (reason !== undefined) {
        // The signal path is per (scope, round) — derive it the same way the
        // bridge does rather than parsing it back out of the prompt.
        await writeFile(goalSignalPath(SCOPE, round), reason, 'utf8');
      }
      // A round that finished instantly would leave no window for the tests
      // that act *during* one (/stop, a mid-loop steer) to land inside it.
      await new Promise((resolve) => setTimeout(resolve, ROUND_HOLD_MS));
      yield { type: 'text', delta: `第 ${round} 轮进度。` };
    })();
    return {
      runId: opts.runId,
      events,
      stop: async () => {},
      waitForExit: async () => true,
    };
  }
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: ScriptedAgent;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
  send: (content: string) => Promise<void>;
  settleAt: (n: number) => Promise<void>;
  waitForRuns: (n: number) => Promise<void>;
  texts: () => string[];
}

async function createHarness(
  script: Array<string | undefined>,
  preferences: Record<string, unknown> = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('goal-continuation-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    // Markdown replies keep the assertions about what the user saw simple.
    preferences: { messageReply: 'markdown', cotMessages: 'off', ...preferences },
  });
  const profileConfig = {
    ...base,
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new ScriptedAgent(script);
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  // Round 1 of every test starts from a clean signal file.
  for (let round = 1; round <= script.length + 1; round++) {
    await prepareGoalSignal(goalSignalPath(SCOPE, round));
  }
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  const send = async (content: string): Promise<void> => {
    await channel.handlers.message?.(message(`om_${channel.sent.length + 1}`, content));
  };
  const idle = async (ms: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls: createControls(profileConfig),
    send,
    // Real timers: a round chains into the next through several awaits and a
    // file read, and faking them here would mostly be testing the fake.
    // Waiting on the round count rather than on a fixed sleep keeps these
    // tests short — they share the runner with everything else, and a slow
    // file here shows up as flakiness in someone else's timing test.
    waitForRuns: async (n) => {
      for (let i = 0; i < 600 && agent.prompts.length < n; i++) await idle(10);
    },
    settleAt: async (n) => {
      for (let i = 0; i < 600 && agent.prompts.length < n; i++) await idle(10);
      await idle(QUIET_MS);
    },
    texts: () =>
      channel.sent.map((s) => {
        const content = s.content as { markdown?: string; text?: string };
        return content.markdown ?? content.text ?? '';
      }),
  };
}

async function startTestBridge(h: Harness): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown }>;
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
  return {
    handlers,
    sent,
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
      return { messageId: `sent_${sent.length}` };
    },
    async stream(_chatId, input) {
      const cardInput = input as
        | { card?: { producer?: (ctrl: { update(c: unknown): Promise<void> }) => Promise<void> } }
        | undefined;
      if (typeof cardInput?.card?.producer === 'function') {
        await cardInput.card.producer({ async update() {} });
      }
    },
    async recallMessage() {},
    async addReaction() {
      return 'r1';
    },
    async removeReaction() {},
  };
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

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: SCOPE,
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}
