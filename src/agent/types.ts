import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      /** `cache_creation_input_tokens` — part of the prompt, so part of context. */
      cacheCreationInputTokens?: number;
      /**
       * Tokens that will be in context on the next turn. Computed by the
       * adapter, because the arithmetic is provider-specific: Claude reports
       * cached prompt tokens in buckets *separate* from `input_tokens`, while
       * Codex/OpenAI report an `input_tokens` that already includes them.
       * Summing the raw fields generically double-counts on one of the two.
       */
      contextTokens?: number;
      /** Model's context window, reported by the CLI. Used for the % on the footer. */
      contextWindow?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' }
  /**
   * A message handed to a running turn via {@link AgentRun.send} has been
   * incorporated by the agent. Emitted when the CLI replays it, which happens
   * at the agent-loop boundary where it was injected — not when it was
   * written. Until this arrives the message is only *submitted*.
   */
  | { type: 'user_input'; uuid: string; text: string }
  /**
   * Messages that were submitted via `send` but never incorporated before the
   * run ended. The bridge owns them and must deliver them some other way.
   */
  | { type: 'input_dropped'; uuids: string[] }
  /**
   * The CLI finished a turn but the run is not over: a submitted message had
   * not been incorporated yet, so it will run as a further turn in the same
   * process. Not a terminal — `done` only comes with the last turn.
   */
  | { type: 'turn_end' };

/** Outcome of {@link AgentRun.send}. `ok` means submitted, not incorporated. */
export type SendResult =
  | { ok: true; uuid: string }
  | { ok: false; reason: 'closed' | 'write-failed' };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  /** Reasoning effort level, forwarded as `--effort`. Claude Code only. */
  effort?: string;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /**
   * Last-resort teardown: SIGKILL the process and destroy its pipes so the
   * event iterator ends. `stop()` is the graceful path and normally suffices;
   * this exists for the case where it didn't — a child that ignored SIGTERM,
   * or a descendant still holding stdout open — and the caller has given up
   * waiting. Optional: adapters that own no OS resources can omit it.
   */
  destroy?(): void;
  /**
   * Hand a further user message to the turn that is already running, so the
   * agent sees it at its next loop boundary instead of after the run ends.
   *
   * Returns `ok` when the message was *submitted*; incorporation is reported
   * separately by a `user_input` event carrying the same uuid, and a message
   * the run ended without incorporating comes back in `input_dropped`. Refused
   * with `closed` once the run has stopped accepting input — after its last
   * turn's result, on `stop()`, or when the pipe broke. Optional: adapters
   * whose CLI is one-shot omit it, and callers fall back to queueing.
   */
  send?(text: string): SendResult;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
