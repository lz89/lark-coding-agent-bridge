import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

/**
 * Add a "Typing" reaction (敲键盘) to a message to give text-mode users an
 * instant "I got your message and I'm responding" cue while Claude is still
 * thinking. Matches the conventional Feishu UX for "the other side is
 * replying". Card mode doesn't need this — the streaming card already
 * shows a "正在思考…" footer the moment it's posted.
 *
 * Returns the reaction id on success, undefined on any failure. Failures
 * are logged but never thrown — losing a decoration must not break the
 * actual reply flow.
 */
export async function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const id = await channel.addReaction(messageId, 'Typing');
    if (id) log.info('reaction', 'added', { messageId, reactionId: id });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The receipt a message gets the moment the bridge takes it on: a reaction on
 * the message itself, before anything else happens to it.
 *
 * Card and COT modes show a run starting within a second or two, but a message
 * queued behind a run, or handed to one in flight, shows nothing until the
 * agent gets to it — and a follow-up that sits there for a minute looks exactly
 * like one that was never delivered. The reaction is what tells them apart.
 *
 * It is taken back when the bridge lets a message go without handling it (a
 * `/stop`, a queue-dropping command, a run that could not start), so a mark
 * that stays means the message reached the agent, or still will. Only
 * messages marked here are ever touched: a wake or a goal continuation carries
 * the id of a message that earned its own mark, and keeps it.
 */
export class ReceiptAcks {
  /** By message object: the emoji used, and the add call a withdrawal waits on. */
  private readonly marked = new WeakMap<NormalizedMessage, { emoji: string; added: Promise<void> }>();

  constructor(
    private readonly channel: Pick<LarkChannel, 'addReaction' | 'removeReactionByEmoji'>,
    /** Read per message — `/config` changes it while the bridge runs. */
    private readonly emoji: () => string | undefined,
  ) {}

  /** Mark `msg` as received. Never blocks, never throws; a failure is logged. */
  acknowledge(msg: NormalizedMessage): void {
    const emoji = this.emoji();
    if (!emoji || this.marked.has(msg)) return;
    const added = this.channel.addReaction(msg.messageId, emoji).then(
      (reactionId) => {
        log.info('reaction', 'ack-added', { messageId: msg.messageId, emoji, reactionId });
      },
      (err: unknown) => {
        log.warn('reaction', 'ack-failed', {
          messageId: msg.messageId,
          emoji,
          err: err instanceof Error ? err.message : String(err),
        });
      },
    );
    this.marked.set(msg, { emoji, added });
  }

  /**
   * The bridge let these go unhandled: take their marks back. Each waits for
   * its own add call first, so a `/stop` right behind a message cannot race
   * the mark it is withdrawing.
   */
  withdraw(msgs: readonly NormalizedMessage[]): void {
    for (const msg of msgs) {
      const mark = this.marked.get(msg);
      if (!mark) continue;
      this.marked.delete(msg);
      void mark.added
        .then(() => this.channel.removeReactionByEmoji(msg.messageId, mark.emoji))
        .then(
          (removed) => {
            log.info('reaction', 'ack-withdrawn', {
              messageId: msg.messageId,
              emoji: mark.emoji,
              removed,
            });
          },
          (err: unknown) => {
            log.warn('reaction', 'ack-withdraw-failed', {
              messageId: msg.messageId,
              emoji: mark.emoji,
              err: err instanceof Error ? err.message : String(err),
            });
          },
        );
    }
  }
}
