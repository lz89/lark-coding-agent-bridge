import type { NormalizedMessage } from '@larksuite/channel';
import type { SendResult } from '../agent/types';
import { log } from '../core/logger';

/** The part of a running agent the dispatcher talks to. */
export interface SteerTarget {
  send?(text: string): SendResult;
}

export interface ActiveRunInfo {
  run: SteerTarget;
  /** True during a `/goal` round — the steer then carries the signal-file note. */
  goalRound: boolean;
  /**
   * In a `/goal` round, each message handed over is issued a fresh signal
   * path, and only the last one the agent actually took in counts at the end
   * of the round: a `continue` the agent wrote before it read the message —
   * or a late write from something it detached — cannot outlive its later
   * decision, and a message it never saw cannot decide anything.
   */
  steerSignal?: {
    /** A new path for the message about to be handed over. */
    issue(): string;
    /** The agent took in the message that names `path` (its receipt arrived). */
    incorporated(path: string): void;
  };
}

export interface SteerContext {
  goalRound: boolean;
  /** The signal path this message tells the agent to write, in a goal round. */
  signalPath?: string;
}

export interface PreparedSteer {
  /** What the agent is handed: the envelope, quotes, instructions, the text. */
  text: string;
  /** What the reply shows for it: the user's words, sender-annotated. */
  display: string;
}

export interface ScopeDispatcherDeps {
  scope: string;
  /** Messages a command generated (the first task of `/goal`): never steered. */
  isNonSteerable: (msg: NormalizedMessage) => boolean;
  /**
   * Build what is handed to the running agent. May fetch (quotes), may throw;
   * a throw leaves the batch retained for the next run.
   */
  prepare: (batch: NormalizedMessage[], ctx: SteerContext) => Promise<PreparedSteer>;
  maxSteersPerRun?: number;
  maxSteerChars?: number;
}

export const DEFAULT_MAX_STEERS_PER_RUN = 20;
export const DEFAULT_MAX_STEER_CHARS = 4_000;
/**
 * How long retirement waits for a preparation still under way. A quote fetch
 * goes through the SDK's own request timeout, so this is a backstop, not the
 * normal path — but a scope must never be wedged behind one hung fetch: past
 * this, the dispatcher retires anyway and the late job finds itself retired
 * and does nothing.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 15_000;

/** Message shapes whose whole meaning survives being passed as text. */
const STEERABLE_CONTENT_TYPES = new Set(['text', 'post']);

interface InflightSteer {
  seq: number;
  batch: NormalizedMessage[];
  display: string;
  onIncorporated?: () => void;
  /**
   * An interrupt or a queue-dropping command landed after this was handed
   * over. It cannot be taken back from the agent, so its receipt still counts
   * — but if the agent never takes it in, it is not re-delivered either.
   */
  discarded?: boolean;
}

/**
 * Whether a batch can be handed to a running turn as text without losing
 * anything the normal prompt path would have carried. Attachments need the
 * policy pass, an interactive card needs its structured body, and a task a
 * command generated needs to start its own driver — none of those may go in
 * sideways. Anything that fails this stays queued intact for the next run.
 */
export function isSteerableBatch(
  batch: readonly NormalizedMessage[],
  isNonSteerable: (msg: NormalizedMessage) => boolean,
): boolean {
  if (batch.length === 0) return false;
  return batch.every(
    (m) =>
      m.resources.length === 0 &&
      STEERABLE_CONTENT_TYPES.has(m.rawContentType) &&
      !isNonSteerable(m) &&
      m.content.trim().length > 0,
  );
}

/**
 * The one owner of every message a scope admits while a run is in flight.
 *
 * A batch handed over by the queue is registered here **synchronously**, with
 * a sequence number, before anything asynchronous happens to it. From then on
 * it is in exactly one of three places: the backlog (retained for the next
 * run), in flight (handed to the running agent, awaiting its receipt), or
 * gone (receipt seen, or discarded by an interrupt). It can be neither lost
 * nor duplicated by a run ending, a quote fetch finishing late, or a `/stop`
 * landing mid-preparation — those are the cases the sequence, generation and
 * `settle` exist for.
 *
 * Steering is best-effort on top of that guarantee: when a batch cannot be
 * steered, for any reason at any point, it simply stays in the backlog.
 */
export class ScopeDispatcher {
  private seq = 0;
  /** Bumped by `discard`, so a preparation that straddled it does not send. */
  private generation = 0;
  private retired = false;
  private active: (ActiveRunInfo & { steers: number }) | undefined;
  private readonly backlog = new Map<number, NormalizedMessage[]>();
  private readonly inflight = new Map<string, InflightSteer>();
  /**
   * Display text of messages the agent took in, by uuid. The receipt ledger
   * and the render loop read the same event on separate subscriptions in no
   * fixed order, so the text has to outlive the in-flight entry.
   */
  private readonly shown = new Map<string, string>();
  private readonly preparing = new Set<Promise<void>>();
  /** Seqs whose steer job has not finished — in the backlog, but not (yet) retained. */
  private readonly preparingSeqs = new Set<number>();
  /**
   * Steer jobs run one after another, in seq order. That is what makes the
   * cross-message ordering rule exact: when a job runs, every older batch has
   * already been either handed over or retained, so "is something older being
   * kept for the next run" has a definite answer.
   */
  private chain: Promise<void> = Promise.resolve();
  private readonly maxSteers: number;
  private readonly maxChars: number;

  constructor(private readonly deps: ScopeDispatcherDeps) {
    this.maxSteers = deps.maxSteersPerRun ?? DEFAULT_MAX_STEERS_PER_RUN;
    this.maxChars = deps.maxSteerChars ?? DEFAULT_MAX_STEER_CHARS;
  }

  /**
   * A run is live and may be handed messages.
   *
   * Anything already waiting was retained only for want of a run — messages
   * arrive while attachments download or the pool is full — so it gets its
   * chance now, oldest first, up to the first one that has to wait anyway.
   */
  setActive(info: ActiveRunInfo): void {
    const active = { ...info, steers: 0 };
    this.active = active;
    if (this.retired || !active.run.send) return;
    for (const seq of [...this.backlog.keys()].sort((a, b) => a - b)) {
      if (this.preparingSeqs.has(seq)) continue;
      const batch = this.backlog.get(seq);
      if (!batch || !isSteerableBatch(batch, this.deps.isNonSteerable)) break;
      this.enqueue(seq, batch, active);
    }
  }

  /** The run is over, or about to be: nothing more may be handed to it. */
  clearActive(): void {
    this.active = undefined;
  }

  get hasActive(): boolean {
    return this.active !== undefined;
  }

  /**
   * Take ownership of a batch. Returns immediately; steering, if any, happens
   * in the background and the batch stays in the backlog until it succeeds.
   */
  offer(batch: NormalizedMessage[]): void {
    if (batch.length === 0) return;
    const seq = ++this.seq;
    this.backlog.set(seq, batch);
    if (this.retired) return;
    const active = this.active;
    if (!active?.run.send) return;
    if (active.steers >= this.maxSteers) {
      log.info('steer', 'quota-exhausted', { scope: this.deps.scope, seq, max: this.maxSteers });
      return;
    }
    if (!isSteerableBatch(batch, this.deps.isNonSteerable)) {
      log.info('steer', 'retained', { scope: this.deps.scope, seq, reason: 'not-steerable' });
      return;
    }
    // Order is kept across runs, not just within one: once something older is
    // being held for the next run, everything after it waits with it. Handing
    // this batch over now would have the agent act on it before a message the
    // user sent first.
    if (this.hasOlderRetained(seq)) {
      log.info('steer', 'retained', { scope: this.deps.scope, seq, reason: 'behind-retained' });
      return;
    }
    this.enqueue(seq, batch, active);
  }

  /** Queue a steer job for a batch that is in the backlog and may go in. */
  private enqueue(
    seq: number,
    batch: NormalizedMessage[],
    active: ActiveRunInfo & { steers: number },
  ): void {
    this.preparingSeqs.add(seq);
    const generation = this.generation;
    const job = this.chain
      .then(() => this.steer(seq, batch, generation, active))
      .finally(() => this.preparingSeqs.delete(seq));
    this.chain = job.catch(() => {});
    this.preparing.add(job);
    void job.finally(() => this.preparing.delete(job));
  }

  private hasOlderRetained(seq: number): boolean {
    for (const s of this.backlog.keys()) {
      if (s < seq && !this.preparingSeqs.has(s)) return true;
    }
    return false;
  }

  /** The agent took the message in. */
  acknowledge(uuid: string): boolean {
    const entry = this.inflight.get(uuid);
    if (!entry) return false;
    this.inflight.delete(uuid);
    this.shown.set(uuid, entry.display);
    entry.onIncorporated?.();
    log.info('steer', 'incorporated', { scope: this.deps.scope, uuid, seq: entry.seq });
    return true;
  }

  /**
   * What to show on the reply for a message the agent took in — the user's
   * words, not the envelope they travelled in. Known from the moment the
   * message was handed over, whichever subscription asks first.
   */
  displayFor(uuid: string): string | undefined {
    return this.shown.get(uuid) ?? this.inflight.get(uuid)?.display;
  }

  /** The run ended without taking these in: back to the backlog, at their seq. */
  dropped(uuids: readonly string[]): void {
    for (const uuid of uuids) {
      const entry = this.inflight.get(uuid);
      if (!entry) continue;
      this.inflight.delete(uuid);
      if (entry.discarded) {
        // Dropped by the queue in the meantime; a message that never reached
        // the agent and was told to go away is not re-delivered.
        log.info('steer', 'dropped-discarded', { scope: this.deps.scope, uuid, seq: entry.seq });
        continue;
      }
      this.backlog.set(entry.seq, entry.batch);
      log.info('steer', 'dropped', { scope: this.deps.scope, uuid, seq: entry.seq });
    }
  }

  /**
   * The run is over. Whatever is still in flight was never acknowledged —
   * the adapter died before saying so, or never reported — so it is retained
   * like anything else that did not get through.
   */
  reconcileRunEnd(): void {
    if (this.inflight.size === 0) return;
    this.dropped([...this.inflight.keys()]);
  }

  /**
   * An interrupt landed, or a command that drops the queue: what is waiting
   * goes, as `/stop` has always dropped the queue. What is in flight is
   * already in the agent and cannot be taken back — its receipt still counts
   * (the reply shows it, a goal round learns its signal path from it); it is
   * only never re-delivered should the agent not take it in. Messages that
   * arrive after this are new and are kept.
   */
  discard(): { backlog: number; inflight: number } {
    const counts = { backlog: this.backlog.size, inflight: this.inflight.size };
    this.generation += 1;
    this.backlog.clear();
    for (const entry of this.inflight.values()) entry.discarded = true;
    if (counts.backlog > 0 || counts.inflight > 0) {
      log.info('steer', 'discarded', { scope: this.deps.scope, ...counts });
    }
    return counts;
  }

  /**
   * Everything retained, oldest first, flattened for the next run. Synchronous
   * on purpose: the caller drains and hands off in one tick, so nothing can be
   * offered in between and end up in a drained dispatcher.
   */
  drain(): NormalizedMessage[] {
    const seqs = [...this.backlog.keys()].sort((a, b) => a - b);
    const out = seqs.flatMap((seq) => this.backlog.get(seq) ?? []);
    this.backlog.clear();
    return out;
  }

  /**
   * No further steering, ever, and every preparation already under way has
   * finished (sent, or given up) — or the wait has run out. After this `drain`
   * is exact: a job still running when the wait ran out sees `retired` after
   * its await and leaves its batch where `drain` finds it.
   */
  async settle(opts: { timeoutMs?: number } = {}): Promise<void> {
    this.retired = true;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (this.preparing.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        log.warn('steer', 'settle-timeout', {
          scope: this.deps.scope,
          preparing: this.preparing.size,
          timeoutMs,
        });
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      });
      try {
        await Promise.race([Promise.allSettled([...this.preparing]), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  stats(): { backlog: number; inflight: number; preparing: number } {
    return { backlog: this.backlog.size, inflight: this.inflight.size, preparing: this.preparing.size };
  }

  private async steer(
    seq: number,
    batch: NormalizedMessage[],
    generation: number,
    active: ActiveRunInfo & { steers: number },
  ): Promise<void> {
    // Issued before preparation because the text carries it; only reported
    // once the agent's receipt for the message arrives, so a path the agent
    // never saw cannot become the one the round is judged by.
    const signalPath = active.steerSignal?.issue();
    let prepared: PreparedSteer;
    try {
      prepared = await this.deps.prepare(batch, {
        goalRound: active.goalRound,
        ...(signalPath ? { signalPath } : {}),
      });
    } catch (err) {
      log.warn('steer', 'prepare-failed', { scope: this.deps.scope, seq, err: String(err) });
      return;
    }
    const { text, display } = prepared;
    // Everything below re-checks what the await may have changed. Any miss
    // leaves the batch where it is — retained — which is always safe.
    if (this.retired || generation !== this.generation || !this.backlog.has(seq)) return;
    if (this.active !== active || !active.run.send) return;
    if (active.steers >= this.maxSteers) {
      log.info('steer', 'retained', { scope: this.deps.scope, seq, reason: 'quota' });
      return;
    }
    // An older job may have ended up retaining its batch since this one was
    // admitted; the ordering rule applies here just as it did at offer time.
    if (this.hasOlderRetained(seq)) {
      log.info('steer', 'retained', { scope: this.deps.scope, seq, reason: 'behind-retained' });
      return;
    }
    if (text.length > this.maxChars) {
      log.info('steer', 'retained', { scope: this.deps.scope, seq, reason: 'too-long', chars: text.length });
      return;
    }
    const res = active.run.send(text);
    if (!res.ok) {
      log.info('steer', 'refused', { scope: this.deps.scope, seq, reason: res.reason });
      return;
    }
    active.steers += 1;
    this.backlog.delete(seq);
    const steerSignal = active.steerSignal;
    this.inflight.set(res.uuid, {
      seq,
      batch,
      display,
      // Bound now: by the time the receipt arrives the run may already have
      // been cleared as active, and the round still has to learn its path.
      ...(signalPath && steerSignal
        ? { onIncorporated: () => steerSignal.incorporated(signalPath) }
        : {}),
    });
    log.info('steer', 'sent', {
      scope: this.deps.scope,
      seq,
      uuid: res.uuid,
      chars: text.length,
      steers: active.steers,
    });
  }
}
