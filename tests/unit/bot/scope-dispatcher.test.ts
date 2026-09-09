import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import type { SendResult } from '../../../src/agent/types.js';
import {
  DEFAULT_MAX_STEERS_PER_RUN,
  ScopeDispatcher,
  isSteerableBatch,
} from '../../../src/bot/steering.js';

function msg(id: string, content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_u',
    senderName: 'U',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 0,
    ...extra,
  } as unknown as NormalizedMessage;
}

/** A run whose `send` the test controls. */
function fakeRun(opts: { accept?: boolean; result?: SendResult } = {}) {
  const sent: string[] = [];
  let n = 0;
  const run = {
    send(text: string): SendResult {
      sent.push(text);
      if (opts.result) return opts.result;
      if (opts.accept === false) return { ok: false, reason: 'closed' };
      return { ok: true, uuid: `u${++n}` };
    },
  };
  return { run, sent };
}

/** Preparation that the test releases by hand. */
function gatedPrepare() {
  const gates: Array<() => void> = [];
  const prepare = (batch: NormalizedMessage[]): Promise<string> =>
    new Promise<string>((resolve) => {
      gates.push(() => resolve(batch.map((m) => m.content).join('\n')));
    });
  return { prepare, release: () => gates.splice(0).forEach((g) => g()) };
}

// Steer jobs are chained one after another, each with its own preparation
// await and bookkeeping `finally`s; give the whole chain room to run.
const tick = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

function dispatcher(
  prepare: (batch: NormalizedMessage[], ctx: { goalRound: boolean }) => Promise<string> = async (b) =>
    b.map((m) => m.content).join('\n'),
  extra: Partial<ConstructorParameters<typeof ScopeDispatcher>[0]> = {},
): ScopeDispatcher {
  return new ScopeDispatcher({
    scope: 'oc_1',
    isNonSteerable: () => false,
    prepare,
    ...extra,
  });
}

describe('isSteerableBatch', () => {
  const no = () => false;
  it('accepts plain text and post', () => {
    expect(isSteerableBatch([msg('1', 'hi')], no)).toBe(true);
    expect(isSteerableBatch([msg('1', 'hi', { rawContentType: 'post' } as never)], no)).toBe(true);
  });
  it('refuses attachments, structured content, command tasks, and empty text', () => {
    expect(isSteerableBatch([msg('1', 'hi', { resources: [{ fileKey: 'f' }] } as never)], no)).toBe(false);
    expect(isSteerableBatch([msg('1', 'hi', { rawContentType: 'interactive' } as never)], no)).toBe(false);
    expect(isSteerableBatch([msg('1', '   ')], no)).toBe(false);
    expect(isSteerableBatch([msg('1', 'hi')], () => true)).toBe(false);
    expect(isSteerableBatch([], no)).toBe(false);
  });
  it('is all-or-nothing across the batch', () => {
    const batch = [msg('1', 'ok'), msg('2', 'file', { resources: [{ fileKey: 'f' }] } as never)];
    expect(isSteerableBatch(batch, no)).toBe(false);
  });
});

describe('ScopeDispatcher', () => {
  it('retains an offer when no run is active, and drains oldest first', () => {
    const d = dispatcher();
    d.offer([msg('2', 'second')]);
    d.offer([msg('3', 'third')]);
    expect(d.stats()).toEqual({ backlog: 2, inflight: 0, preparing: 0 });
    expect(d.drain().map((m) => m.messageId)).toEqual(['2', '3']);
    expect(d.stats().backlog).toBe(0);
  });

  it('steers a text batch into the active run and tracks it until the receipt', async () => {
    const d = dispatcher();
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });

    d.offer([msg('1', 'change of plan')]);
    expect(d.stats().preparing).toBe(1);
    await tick();
    expect(sent).toEqual(['change of plan']);
    expect(d.stats()).toEqual({ backlog: 0, inflight: 1, preparing: 0 });

    expect(d.acknowledge('u1')).toBe(true);
    expect(d.stats().inflight).toBe(0);
    expect(d.drain()).toEqual([]);
  });

  it('a message the run never took in comes back at its original position', async () => {
    const d = dispatcher();
    const { run } = fakeRun();
    d.setActive({ run, goalRound: false });

    // A: steered at seq 1.
    d.offer([msg('A', 'text')]);
    await tick();
    // B: not steerable (attachment) → retained at seq 2.
    d.offer([msg('B', 'with file', { resources: [{ fileKey: 'f' }] } as never)]);
    expect(d.stats()).toEqual({ backlog: 1, inflight: 1, preparing: 0 });

    // The run ends without incorporating A.
    d.dropped(['u1']);
    // Arrival order, not "dropped last".
    expect(d.drain().map((m) => m.messageId)).toEqual(['A', 'B']);
  });

  it('holds a steerable batch behind an older one that is being kept for the next run', async () => {
    const d = dispatcher();
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });

    d.offer([msg('A', 'with file', { resources: [{ fileKey: 'f' }] } as never)]);
    d.offer([msg('B', 'plain text')]);
    await tick();
    // B could have gone in, but the user sent A first.
    expect(sent).toEqual([]);
    expect(d.drain().map((m) => m.messageId)).toEqual(['A', 'B']);

    // With nothing older waiting, the next one goes straight in.
    d.offer([msg('C', 'later')]);
    await tick();
    expect(sent).toEqual(['later']);
  });

  it('reconcileRunEnd treats whatever is still in flight as never delivered', async () => {
    const d = dispatcher();
    const { run } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'x')]);
    await tick();
    expect(d.stats().inflight).toBe(1);

    d.clearActive();
    d.reconcileRunEnd();
    expect(d.stats()).toEqual({ backlog: 1, inflight: 0, preparing: 0 });
  });

  it('a refused send leaves the batch retained', async () => {
    const d = dispatcher();
    const { run } = fakeRun({ accept: false });
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'x')]);
    await tick();
    expect(d.stats()).toEqual({ backlog: 1, inflight: 0, preparing: 0 });
  });

  it('a preparation that throws leaves the batch retained', async () => {
    const d = dispatcher(async () => {
      throw new Error('quote fetch failed');
    });
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'x')]);
    await tick();
    expect(sent).toEqual([]);
    expect(d.stats().backlog).toBe(1);
  });

  it('does not send a batch whose preparation finished after the run went away', async () => {
    const gate = gatedPrepare();
    const d = dispatcher(gate.prepare);
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'x')]);
    expect(d.stats().preparing).toBe(1);
    // Let the job reach its preparation before the run goes away under it.
    await tick();

    d.clearActive();
    gate.release();
    await tick();
    expect(sent).toEqual([]);
    expect(d.stats()).toEqual({ backlog: 1, inflight: 0, preparing: 0 });
  });

  it('a discard mid-preparation wins: the batch is neither sent nor retained', async () => {
    const gate = gatedPrepare();
    const d = dispatcher(gate.prepare);
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'x')]);

    expect(d.discard()).toEqual({ backlog: 1, inflight: 0 });
    gate.release();
    await tick();
    expect(sent).toEqual([]);
    expect(d.drain()).toEqual([]);
  });

  it('settle waits for preparation in flight, after which drain is exact', async () => {
    const gate = gatedPrepare();
    const d = dispatcher(gate.prepare);
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'x')]);

    let settled = false;
    const settling = d.settle().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    gate.release();
    await settling;
    // Retired before the preparation came back: not sent, still owned.
    expect(sent).toEqual([]);
    expect(d.drain().map((m) => m.messageId)).toEqual(['1']);
  });

  it('an offer after settle is retained without any steering attempt', async () => {
    const d = dispatcher();
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    await d.settle();
    d.offer([msg('1', 'late')]);
    await tick();
    expect(sent).toEqual([]);
    expect(d.stats()).toEqual({ backlog: 1, inflight: 0, preparing: 0 });
  });

  it('caps the number of steers per run and retains the rest', async () => {
    const d = dispatcher(undefined, { maxSteersPerRun: 2 });
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'a')]);
    d.offer([msg('2', 'b')]);
    d.offer([msg('3', 'c')]);
    await tick();
    expect(sent).toEqual(['a', 'b']);
    expect(d.stats()).toEqual({ backlog: 1, inflight: 2, preparing: 0 });
    // The one held on quota keeps everything after it in order behind it.
    d.offer([msg('4', 'd')]);
    await tick();
    expect(d.stats().backlog).toBe(2);

    // A fresh run gets a fresh quota, once the previous run's books are settled.
    d.clearActive();
    d.reconcileRunEnd();
    expect(d.drain().map((m) => m.messageId)).toEqual(['1', '2', '3', '4']);
    const next = fakeRun();
    d.setActive({ run: next.run, goalRound: false });
    d.offer([msg('5', 'e')]);
    await tick();
    expect(next.sent).toEqual(['e']);
  });

  it('hands over what arrived before the run existed, once it does', async () => {
    const d = dispatcher();
    // No run yet — attachments downloading, or the pool was full.
    d.offer([msg('1', 'early')]);
    d.offer([msg('2', 'also early')]);
    expect(d.stats()).toEqual({ backlog: 2, inflight: 0, preparing: 0 });

    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    await tick();
    expect(sent).toEqual(['early', 'also early']);
    expect(d.stats()).toEqual({ backlog: 0, inflight: 2, preparing: 0 });
  });

  it('stops handing over early arrivals at the first one that must wait', async () => {
    const d = dispatcher();
    d.offer([msg('1', 'text')]);
    d.offer([msg('2', 'file', { resources: [{ fileKey: 'f' }] } as never)]);
    d.offer([msg('3', 'after the file')]);

    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    await tick();
    expect(sent).toEqual(['text']);
    expect(d.drain().map((m) => m.messageId)).toEqual(['2', '3']);
  });

  it('retains a steer longer than the size cap', async () => {
    const d = dispatcher(undefined, { maxSteerChars: 5 });
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([msg('1', 'this is far too long')]);
    await tick();
    expect(sent).toEqual([]);
    expect(d.stats().backlog).toBe(1);
  });

  it('never steers a batch the caller marked non-steerable', async () => {
    const task = msg('t', '/goal task');
    const d = new ScopeDispatcher({
      scope: 'oc_1',
      isNonSteerable: (m) => m === task,
      prepare: async (b) => b.map((m) => m.content).join('\n'),
    });
    const { run, sent } = fakeRun();
    d.setActive({ run, goalRound: false });
    d.offer([task]);
    await tick();
    expect(sent).toEqual([]);
    expect(d.drain()).toEqual([task]);
  });

  it('passes the goal-round flag to preparation', async () => {
    const seen: boolean[] = [];
    const d = dispatcher(async (b, ctx) => {
      seen.push(ctx.goalRound);
      return b[0]!.content;
    });
    d.setActive({ run: fakeRun().run, goalRound: true });
    d.offer([msg('1', 'x')]);
    await tick();
    expect(seen).toEqual([true]);
  });

  it('ignores receipts and drops for uuids it does not know', () => {
    const d = dispatcher();
    expect(d.acknowledge('nope')).toBe(false);
    d.dropped(['nope']);
    expect(d.stats()).toEqual({ backlog: 0, inflight: 0, preparing: 0 });
  });

  it('exposes the default quota', () => {
    expect(DEFAULT_MAX_STEERS_PER_RUN).toBeGreaterThan(0);
  });
});
