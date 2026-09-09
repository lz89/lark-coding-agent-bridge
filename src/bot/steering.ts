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
}

export interface ScopeDispatcherDeps {
  scope: string;
  /** Messages a command generated (the first task of `/goal`): never steered. */
  isNonSteerable: (msg: NormalizedMessage) => boolean;
  /**
   * Build the text handed to the running agent. May fetch (quotes), may throw;
   * a throw leaves the batch retained for the next run.
   */
  prepare: (batch: NormalizedMessage[], ctx: { goalRound: boolean }) => Promise<string>;
  maxSteersPerRun?: number;
  maxSteerChars?: number;
}

export const DEFAULT_MAX_STEERS_PER_RUN = 20;
export const DEFAULT_MAX_STEER_CHARS = 4_000;

/** Message shapes whose whole meaning survives being passed as text. */
const STEERABLE_CONTENT_TYPES = new Set(['text', 'post']);

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
  private readonly inflight = new Map<string, { seq: number; batch: NormalizedMessage[] }>();
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
    log.info('steer', 'incorporated', { scope: this.deps.scope, uuid, seq: entry.seq });
    return true;
  }

  /** The run ended without taking these in: back to the backlog, at their seq. */
  dropped(uuids: readonly string[]): void {
    for (const uuid of uuids) {
      const entry = this.inflight.get(uuid);
      if (!entry) continue;
      this.inflight.delete(uuid);
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
   * An interrupt landed: drop what is waiting, as `/stop` has always dropped
   * the queue. What is in flight is already in the agent and will still be
   * echoed and shown; it is only removed from retry bookkeeping. Messages that
   * arrive after this are new and are kept.
   */
  discard(): { backlog: number; inflight: number } {
    const counts = { backlog: this.backlog.size, inflight: this.inflight.size };
    this.generation += 1;
    this.backlog.clear();
    this.inflight.clear();
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
   * finished (sent, or given up). After this `drain` is exact.
   */
  async settle(): Promise<void> {
    this.retired = true;
    while (this.preparing.size > 0) {
      await Promise.allSettled([...this.preparing]);
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
    let text: string;
    try {
      text = await this.deps.prepare(batch, { goalRound: active.goalRound });
    } catch (err) {
      log.warn('steer', 'prepare-failed', { scope: this.deps.scope, seq, err: String(err) });
      return;
    }
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
    this.inflight.set(res.uuid, { seq, batch });
    log.info('steer', 'sent', {
      scope: this.deps.scope,
      seq,
      uuid: res.uuid,
      chars: text.length,
      steers: active.steers,
    });
  }
}
