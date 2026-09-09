import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface PendingEntry {
  messages: NormalizedMessage[];
  timer?: NodeJS.Timeout;
  /** When the oldest message in this entry arrived — the max-age clock. */
  firstAt: number;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * A stream of messages arriving faster than the quiet window can never go
 * silent, so the debounce alone would hold them forever. Past this age the
 * batch goes out on the next push regardless.
 */
export const DEFAULT_MAX_BATCH_AGE_MS = 3_000;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer — pushed messages still accumulate
 * but no flush fires until `unblock(scope)`, which arms a fresh quiet window.
 * The flush handler no longer blocks around a run: messages that arrive while
 * a run is in flight are flushed as usual and the scope's dispatcher decides
 * whether to steer them into the run or hold them for the next one.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private readonly delayMs: number;
  private readonly maxAgeMs: number;
  private readonly onFlush: FlushHandler;

  constructor(
    delayMs: number,
    onFlush: FlushHandler,
    opts: { maxAgeMs?: number } = {},
  ) {
    this.delayMs = delayMs;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_BATCH_AGE_MS;
    this.onFlush = onFlush;
  }

  push(scope: string, msg: NormalizedMessage): number {
    const existing = this.map.get(scope);
    if (!existing) {
      this.map.set(scope, {
        messages: [msg],
        timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
        firstAt: Date.now(),
      });
      return 1;
    }
    if (existing.timer) clearTimeout(existing.timer);
    existing.messages.push(msg);
    const size = existing.messages.length;
    if (this.blocked.has(scope)) {
      existing.timer = undefined;
      return size;
    }
    // Bounded latency: a batch that has been collecting for longer than the
    // max age goes out now instead of being re-armed yet again.
    if (Date.now() - existing.firstAt >= this.maxAgeMs) {
      existing.timer = undefined;
      log.info('queue', 'max-age-flush', { scope, size });
      this.flush(scope);
      return size;
    }
    existing.timer = this.armTimer(scope);
    return size;
  }

  /**
   * Put messages back at the *front* of the scope's queue, in the order given.
   * For messages a dispatcher owned but could not deliver: they were admitted
   * before anything now waiting, so they go out first. Arms the quiet window
   * like a push, so the next flush picks them up together with whatever else
   * has arrived.
   */
  prepend(scope: string, msgs: readonly NormalizedMessage[]): number {
    if (msgs.length === 0) return this.map.get(scope)?.messages.length ?? 0;
    const existing = this.map.get(scope);
    if (!existing) {
      this.map.set(scope, {
        messages: [...msgs],
        timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
        firstAt: Date.now(),
      });
      return msgs.length;
    }
    if (existing.timer) clearTimeout(existing.timer);
    existing.messages.unshift(...msgs);
    existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
    return existing.messages.length;
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}
