import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import {
  hasDeliverableContent,
  renderText,
  withoutUserInput,
} from '../../../src/card/text-renderer.js';
import { quoteUserInput } from '../../../src/card/user-input.js';
import { finalAnswerOnlyState } from '../../../src/bot/cot.js';

function withUser(text: string, before: RunState = initialState): RunState {
  return reduce(before, { type: 'user_input', uuid: 'u1', text });
}

describe('user_input in RunState', () => {
  it('closes streaming text, appends a user block, and returns the footer to thinking', () => {
    const streaming = reduce(initialState, { type: 'text', delta: '正在改…' });
    expect(streaming.footer).toBe('streaming');
    const next = withUser('[U (user)]: 等等，先别改', streaming);
    expect(next.blocks).toEqual([
      { kind: 'text', content: '正在改…', streaming: false },
      { kind: 'user', content: '[U (user)]: 等等，先别改', uuid: 'u1' },
    ]);
    expect(next.footer).toBe('thinking');
  });

  it('is rendered as a quote in text mode, every line included', () => {
    const state = withUser('第一段\n\n第二段\n```\ncode\n```');
    const out = renderText({ ...state, footer: null });
    expect(out.split('\n').every((line) => line.startsWith('>'))).toBe(true);
    expect(out).toContain('> 💬 第一段');
    expect(out).toContain('> 第二段');
  });

  it('is rendered as a small note in card mode, quoted', () => {
    const card = renderCard(withUser('改成蓝色')) as {
      body: { elements: Array<{ tag: string; content?: string; text_size?: string }> };
    };
    const note = card.body.elements.find((e) => e.content?.includes('改成蓝色'));
    expect(note).toBeDefined();
    expect(note!.tag).toBe('markdown');
    expect(note!.text_size).toBe('notation');
    expect(note!.content).toBe('> 💬 改成蓝色');
  });

  it('is never counted as the agent having answered', () => {
    const done = reduce(withUser('等等'), { type: 'done', terminationReason: 'normal' });
    expect(hasDeliverableContent(done)).toBe(false);
    const answered = reduce(reduce(withUser('等等'), { type: 'text', delta: '好' }), {
      type: 'done',
      terminationReason: 'normal',
    });
    expect(hasDeliverableContent(answered)).toBe(true);
  });

  it('withoutUserInput strips only user blocks and is identity when there are none', () => {
    const s = reduce(withUser('x'), { type: 'text', delta: 'y' });
    expect(withoutUserInput(s).blocks.map((b) => b.kind)).toEqual(['text']);
    const plain = reduce(initialState, { type: 'text', delta: 'y' });
    expect(withoutUserInput(plain)).toBe(plain);
  });

  it('stays out of the final-answer-only projection', () => {
    const s = reduce(withUser('x'), { type: 'text', delta: 'answer' });
    expect(finalAnswerOnlyState(s).blocks).toEqual([
      { kind: 'text', content: 'answer', streaming: true },
    ]);
  });

  it('turn_end and input_dropped leave the state untouched', () => {
    const s = reduce(initialState, { type: 'text', delta: 'y' });
    expect(reduce(s, { type: 'turn_end' })).toBe(s);
    expect(reduce(s, { type: 'input_dropped', uuids: ['u'] })).toBe(s);
  });
});

describe('quoteUserInput', () => {
  it('prefixes every line, blank lines as a bare marker', () => {
    expect(quoteUserInput('a\n\nb')).toBe('> 💬 a\n>\n> b');
  });
  it('normalises CRLF', () => {
    expect(quoteUserInput('a\r\nb')).toBe('> 💬 a\n> b');
  });
  it('handles a single line', () => {
    expect(quoteUserInput('only')).toBe('> 💬 only');
  });
});
