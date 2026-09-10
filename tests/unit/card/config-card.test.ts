import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  ackReaction: 'Pin',
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});

type Select = { tag: string; name?: string; initial_option?: string; options?: Array<{ value: string }> };

function findSelect(card: object, name: string): Select {
  const found: Select[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const el = node as Select;
      if (el.tag === 'select_static' && el.name === name) found.push(el);
      Object.values(node).forEach(walk);
    }
  };
  walk(card);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe('configFormCard receipt reaction picker', () => {
  it('offers the stickers that read as "got it", plus off, with the current one selected', () => {
    const select = findSelect(configFormCard(base), 'ack_reaction');
    expect(select.initial_option).toBe('Pin');
    expect(select.options!.map((o) => o.value)).toEqual(['Pin', 'Get', 'OK', 'THUMBSUP', 'off']);
  });

  it('shows the receipt as off when it is', () => {
    const select = findSelect(configFormCard({ ...base, ackReaction: undefined }), 'ack_reaction');
    expect(select.initial_option).toBe('off');
  });

  it('lists a hand-configured emoji as itself, so re-submitting keeps it', () => {
    const select = findSelect(configFormCard({ ...base, ackReaction: 'OnIt' }), 'ack_reaction');
    expect(select.initial_option).toBe('OnIt');
    expect(select.options!.map((o) => o.value)).toEqual(['OnIt', 'Pin', 'Get', 'OK', 'THUMBSUP', 'off']);
  });

  it('is echoed on the saved card', () => {
    expect(JSON.stringify(configSavedCard(base))).toContain('**收到回执**:`Pin`');
    expect(JSON.stringify(configSavedCard({ ...base, ackReaction: undefined }))).toContain(
      '**收到回执**:`关闭`',
    );
  });
});
