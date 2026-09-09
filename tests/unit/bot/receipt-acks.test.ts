import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { ReceiptAcks } from '../../../src/bot/reaction.js';

function msg(id: string): NormalizedMessage {
  return { messageId: id, chatId: 'oc_1', content: 'x' } as unknown as NormalizedMessage;
}

function fakeChannel(opts: { failAdd?: boolean } = {}) {
  const added: Array<{ messageId: string; emojiType: string }> = [];
  const removed: Array<{ messageId: string; reactionId: string }> = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  return {
    added,
    removed,
    /** Hold every add until `release()`. */
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
    },
    async addReaction(messageId: string, emojiType: string): Promise<string> {
      added.push({ messageId, emojiType });
      if (gate) await gate;
      if (opts.failAdd) throw new Error('invalid emoji');
      return `r${added.length}`;
    },
    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      removed.push({ messageId, reactionId });
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('ReceiptAcks', () => {
  it('marks a message with the configured emoji, once, and withdraws that very reaction', async () => {
    const ch = fakeChannel();
    let emoji: string | undefined = 'Get';
    const acks = new ReceiptAcks(ch, () => emoji);
    const m = msg('om_1');
    acks.acknowledge(m);
    acks.acknowledge(m);
    expect(ch.added).toEqual([{ messageId: 'om_1', emojiType: 'Get' }]);

    // `/config` switched the emoji in the meantime; irrelevant — what comes
    // off is the reaction that went on, by id (never "whichever GET is on the
    // message": another bot's is not ours).
    emoji = 'OK';
    acks.withdraw([m]);
    await flush();
    expect(ch.removed).toEqual([{ messageId: 'om_1', reactionId: 'r1' }]);
  });

  it('does nothing when the receipt is off', async () => {
    const ch = fakeChannel();
    const acks = new ReceiptAcks(ch, () => undefined);
    const m = msg('om_1');
    acks.acknowledge(m);
    acks.withdraw([m]);
    await flush();
    expect(ch.added).toEqual([]);
    expect(ch.removed).toEqual([]);
  });

  it('never touches a message it did not mark', async () => {
    // A wake or a goal continuation carries the id of a message that earned
    // its own mark; being dropped as part of a batch must not cost it that.
    const ch = fakeChannel();
    const acks = new ReceiptAcks(ch, () => 'Get');
    acks.acknowledge(msg('om_anchor'));
    acks.withdraw([msg('om_anchor')]);
    await flush();
    expect(ch.removed).toEqual([]);
  });

  it('withdraws only once', async () => {
    const ch = fakeChannel();
    const acks = new ReceiptAcks(ch, () => 'Get');
    const m = msg('om_1');
    acks.acknowledge(m);
    acks.withdraw([m]);
    acks.withdraw([m]);
    await flush();
    expect(ch.removed).toHaveLength(1);
  });

  it('a kept mark is a fact: a later withdrawal of the same message is a no-op', async () => {
    // The batch reached the agent, then the run threw or was dropped: the
    // message was handled, and the mark stays.
    const ch = fakeChannel();
    const acks = new ReceiptAcks(ch, () => 'Get');
    const m = msg('om_1');
    acks.acknowledge(m);
    acks.keep([m]);
    acks.withdraw([m]);
    await flush();
    expect(ch.removed).toEqual([]);
  });

  it('waits for the add to land before taking the mark back', async () => {
    // A `/stop` 100ms behind a message: the reaction API call for the mark is
    // still in flight, and the id to remove is not known yet.
    const ch = fakeChannel();
    ch.hold();
    const acks = new ReceiptAcks(ch, () => 'Get');
    const m = msg('om_1');
    acks.acknowledge(m);
    acks.withdraw([m]);
    await flush();
    expect(ch.removed).toEqual([]);
    ch.release();
    await flush();
    expect(ch.removed).toEqual([{ messageId: 'om_1', reactionId: 'r1' }]);
  });

  it('swallows a failed add; a withdrawal after it has nothing to remove', async () => {
    const ch = fakeChannel({ failAdd: true });
    const acks = new ReceiptAcks(ch, () => 'Nope');
    const m = msg('om_1');
    expect(() => acks.acknowledge(m)).not.toThrow();
    await flush();
    acks.withdraw([m]);
    await flush();
    expect(ch.removed).toEqual([]);
  });
});
