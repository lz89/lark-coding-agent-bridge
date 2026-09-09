import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_BATCH_AGE_MS, PendingQueue } from '../../../src/bot/pending-queue.js';

afterEach(() => {
  vi.useRealTimers();
});

function msg(id: string, content: string): NormalizedMessage {
  return {
    messageId: id,
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_u',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 0,
  } as unknown as NormalizedMessage;
}

describe('PendingQueue', () => {
  it('flushes after the quiet window, merging what arrived inside it', () => {
    vi.useFakeTimers();
    const flushed: NormalizedMessage[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    q.push('s', msg('1', 'a'));
    vi.advanceTimersByTime(300);
    q.push('s', msg('2', 'b'));
    vi.advanceTimersByTime(599);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([[msg('1', 'a'), msg('2', 'b')]]);
  });

  it('does not let a steady trickle starve the flush past the max age', () => {
    // Every push re-arms the 600ms window, so on its own the debounce would
    // hold a stream of messages 500ms apart forever.
    vi.useFakeTimers();
    const flushed: NormalizedMessage[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    let n = 0;
    q.push('s', msg(String(++n), 'x'));
    // 500ms cadence: never a quiet window, but the age keeps growing.
    while (n < 12) {
      vi.advanceTimersByTime(500);
      q.push('s', msg(String(++n), 'x'));
      if (flushed.length > 0) break;
    }
    expect(flushed.length).toBe(1);
    const first = flushed[0]!;
    // Went out on the push that crossed the age line, everything so far inside.
    expect(first.length).toBe(Math.floor(DEFAULT_MAX_BATCH_AGE_MS / 500) + 1);
    expect(first[0]!.messageId).toBe('1');
  });

  it('prepend puts messages ahead of what is already waiting and re-arms the window', () => {
    vi.useFakeTimers();
    const flushed: NormalizedMessage[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    q.push('s', msg('3', 'later'));
    vi.advanceTimersByTime(400);
    expect(q.prepend('s', [msg('1', 'old'), msg('2', 'older-ish')])).toBe(3);
    // The window restarted at the prepend, not at the earlier push.
    vi.advanceTimersByTime(599);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([[msg('1', 'old'), msg('2', 'older-ish'), msg('3', 'later')]]);
  });

  it('prepend on an empty scope behaves like a push of the whole set', () => {
    vi.useFakeTimers();
    const flushed: NormalizedMessage[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    expect(q.prepend('s', [msg('1', 'a'), msg('2', 'b')])).toBe(2);
    vi.advanceTimersByTime(600);
    expect(flushed).toEqual([[msg('1', 'a'), msg('2', 'b')]]);
  });

  it('prepend of nothing is a no-op that does not arm a timer', () => {
    vi.useFakeTimers();
    const flushed: NormalizedMessage[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    expect(q.prepend('s', [])).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(flushed).toEqual([]);
  });

  it('prepend respects a blocked scope', () => {
    vi.useFakeTimers();
    const flushed: NormalizedMessage[][] = [];
    const q = new PendingQueue(600, (_scope, batch) => flushed.push(batch));

    q.block('s');
    q.prepend('s', [msg('1', 'a')]);
    vi.advanceTimersByTime(5_000);
    expect(flushed).toEqual([]);
    q.unblock('s');
    vi.advanceTimersByTime(600);
    expect(flushed).toEqual([[msg('1', 'a')]]);
  });
});
