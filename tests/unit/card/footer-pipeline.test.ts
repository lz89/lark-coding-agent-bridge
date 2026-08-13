import { describe, expect, it } from 'vitest';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { renderFooterMeta } from '../../../src/card/run-footer.js';
import { finalizeIfRunning, initialState, withMeta, type RunState } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';

/**
 * A verbatim `result` event from `claude -p --output-format stream-json`,
 * captured from the real CLI. The footer's context number is derived from
 * these exact field names, so this doubles as the contract test: if the CLI
 * renames one, the derived total changes and this fails.
 */
const REAL_RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 'sess-1',
  total_cost_usd: 0.1001436,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 15_456,
    cache_read_input_tokens: 24_422,
    output_tokens: 5,
  },
  modelUsage: {
    'claude-sonnet-5': { contextWindow: 1_000_000, costUSD: 0.1001436 },
  },
};

/** Mirrors how `processAgentStream` folds usage/system events into the state. */
function foldMeta(state: RunState, evt: AgentEvent): RunState {
  if (evt.type === 'system' && evt.model) return withMeta(state, { model: evt.model });
  if (evt.type === 'usage') {
    const contextTokens =
      (evt.inputTokens ?? 0) +
      (evt.cachedInputTokens ?? 0) +
      (evt.cacheCreationInputTokens ?? 0) +
      (evt.outputTokens ?? 0);
    return withMeta(state, {
      contextTokens: contextTokens > 0 ? contextTokens : undefined,
      contextWindow: evt.contextWindow,
    });
  }
  return state;
}

describe('footer pipeline', () => {
  it('derives context from every part of the prompt plus the output', () => {
    const [usage] = [...translateEvent(REAL_RESULT)];
    expect(usage).toMatchObject({
      type: 'usage',
      inputTokens: 2,
      cachedInputTokens: 24_422,
      cacheCreationInputTokens: 15_456,
      outputTokens: 5,
      contextWindow: 1_000_000,
    });

    const state = foldMeta(initialState, usage!);
    // 2 + 24422 + 15456 + 5 = 39885 → 40K. Billed-only would read ~0K.
    expect(state.meta?.contextTokens).toBe(39_885);
    expect(renderFooterMeta(state.meta)).toBe('🧠 40K / 4%');
  });

  it('reads the model the CLI actually loaded, not the one requested', () => {
    const [system] = [...translateEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-fable-5',
    })];
    const state = foldMeta(initialState, system!);
    expect(renderFooterMeta(state.meta)).toBe('🧠 Fable 5');
  });

  it('shows the footer on a finished card, behind a divider', () => {
    let state = initialState;
    for (const evt of translateEvent(REAL_RESULT)) state = foldMeta(state, evt);
    state = withMeta(finalizeIfRunning({ ...state, blocks: [{ kind: 'text', content: '好了。', streaming: false }] }), {
      model: 'claude-fable-5',
      effort: 'max',
    });

    const card = renderCard(state) as { body: { elements: Array<Record<string, unknown>> } };
    const json = JSON.stringify(card);
    expect(json).toContain('40K / 4%');
    expect(json).toContain('Fable 5');
    expect(json).toContain('max');
    // Divider immediately precedes the footer note.
    const hrIndex = card.body.elements.findIndex((e) => e.tag === 'hr');
    expect(hrIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(card.body.elements[hrIndex + 1])).toContain('40K');

    expect(renderText(state)).toContain('🧠 40K / 4% · Fable 5 · max');
  });

  it('shows no footer while the run is still going', () => {
    // Usage only arrives with the terminal event, so a running card would be
    // showing the previous turn's number.
    const running = withMeta(
      { ...initialState, blocks: [{ kind: 'text', content: '写…', streaming: true }] },
      { contextTokens: 403_000, model: 'claude-fable-5', effort: 'max' },
    );
    expect(JSON.stringify(renderCard(running))).not.toContain('403K');
    expect(renderText(running)).not.toContain('403K');
  });

  it('renders the reply unchanged when the CLI reports no usage at all', () => {
    const noUsage = [...translateEvent({ type: 'result', session_id: 'sess-1' })];
    expect(noUsage.map((e) => e.type)).toEqual(['done']);

    const state = finalizeIfRunning({
      ...initialState,
      blocks: [{ kind: 'text', content: '答案', streaming: false }],
    });
    expect(renderText(state)).toBe('答案');
    expect(JSON.stringify(renderCard(state))).not.toContain('🧠');
  });
});
