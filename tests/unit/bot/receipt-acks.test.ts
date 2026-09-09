import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { ReceiptAcks } from '../../../src/bot/reaction.js';

function msg(id: string): NormalizedMessage {
  return { messageId: id, chatId: 'oc_1', content: 'x' } as unknown as NormalizedMessage;
}

interface Call {
  messageId: string;
  emojiType: string;
}

function fakeChannel(opts: { failAdd?: boolean } = {}) {
  const added: Call[] = [];
  const removed: Call[] = [];
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
    async removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean> {
      removed.push({ messageId, emojiType });
      return true;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('ReceiptAcks', () => {
  it('marks a message with the configured emoji, once, and withdraws the same emoji', async () => {
    const ch = fakeChannel();
    let emoji: string | undefined = 'Get';
    const acks = new ReceiptAcks(ch, () => emoji);
    const m = msg('om_1');
    acks.acknowledge(m);
    acks.acknowledge(m);
    expect(ch.added).toEqual([{ messageId: 'om_1', emojiType: 'Get' }]);

    // `/config` switched the emoji in the meantime: the mark that was put on
    // is the one taken off.
    emoji = 'OK';
    acks.withdraw([m]);
    await flush();
    expect(ch.removed).toEqual([{ messageId: 'om_1', emojiType: 'Get' }]);
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

  it('waits for the add to land before taking the mark back', async () => {
    // A `/stop` 100ms behind a message: the reaction API call for the mark is
    // still in flight, and a removal issued now would find nothing to remove.
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
    expect(ch.removed).toEqual([{ messageId: 'om_1', emojiType: 'Get' }]);
  });

  it('swallows a failed add, and still tries the withdrawal after it', async () => {
    const ch = fakeChannel({ failAdd: true });
    const acks = new ReceiptAcks(ch, () => 'Nope');
    const m = msg('om_1');
    expect(() => acks.acknowledge(m)).not.toThrow();
    await flush();
    acks.withdraw([m]);
    await flush();
    expect(ch.removed).toEqual([{ messageId: 'om_1', emojiType: 'Nope' }]);
  });
});
