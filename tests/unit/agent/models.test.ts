import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  isDefaultModel,
  formatModelName,
  isClaudeModelId,
  isSelectableModel,
  modelLabel,
  modelOptions,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-5-codex');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelLabel('claude', 'claude-fable-5')).toContain('Fable 5');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });
});

describe('models outside the catalog', () => {
  it('recognises Claude ids and aliases by shape', () => {
    expect(isClaudeModelId('claude-opus-5-5')).toBe(true);
    expect(isClaudeModelId('claude-fable-5-1[1m]')).toBe(true);
    expect(isClaudeModelId('claude-haiku-4-5-20251001')).toBe(true);
    expect(isClaudeModelId('opus')).toBe(true);
    expect(isClaudeModelId('Sonnet')).toBe(true);
    expect(isClaudeModelId('claude-opus 5')).toBe(false);
    expect(isClaudeModelId('claude-')).toBe(false);
    expect(isClaudeModelId('claude-opus')).toBe(false); // no version segment
    expect(isClaudeModelId('gpt-5-codex')).toBe(false);
    expect(isClaudeModelId('claude-opus-5;rm -rf /')).toBe(false);
    expect(isClaudeModelId('')).toBe(false);
  });

  it('forwards a well-formed id that is not in the catalog, so new models need no code change', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-9-9')).toBe('claude-opus-9-9');
    expect(resolveModelArg('claude', 'claude-opus-9-9')).toBe('claude-opus-9-9');
    expect(resolveModelArg('claude', 'opus')).toBe('opus');
    expect(resolveModelArg('claude', ' claude-opus-5-5 ')).toBe('claude-opus-5-5');
    expect(isSelectableModel('claude', 'claude-opus-9-9')).toBe(true);
    expect(isSelectableModel('claude', DEFAULT_MODEL)).toBe(true);
  });

  it('still drops malformed values and never passes Claude ids through for codex', () => {
    expect(resolveModelArg('claude', 'bogus')).toBeUndefined();
    expect(resolveModelArg('claude', 'claude-opus 5')).toBeUndefined();
    expect(resolveModelArg('codex', 'claude-opus-9-9')).toBeUndefined();
    expect(isSelectableModel('claude', 'bogus')).toBe(false);
    expect(isSelectableModel('codex', 'gpt-5-codex')).toBe(true);
  });

  it('derives a display name from the id alone', () => {
    expect(formatModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatModelName('claude-opus-5')).toBe('Opus 5');
    expect(formatModelName('claude-fable-5-1[1m]')).toBe('Fable 5.1 [1M]');
    expect(formatModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelName('opus')).toBe('Opus（跟随最新）');
    expect(formatModelName('opusplan')).toBe('Opus Plan');
    expect(modelLabel('claude', 'claude-opus-9-9')).toBe('Opus 9.9');
  });

  it('keeps the current pass-through id in the picker so the card stays valid', () => {
    const opts = modelOptions('claude', 'claude-opus-9-9');
    expect(opts.slice(0, -1)).toEqual(supportedModels('claude'));
    expect(opts.at(-1)).toEqual({ value: 'claude-opus-9-9', label: 'Opus 9.9（自定义）' });
    expect(modelOptions('claude', 'claude-opus-4-8')).toEqual(supportedModels('claude'));
    expect(modelOptions('claude', undefined)).toEqual(supportedModels('claude'));
    expect(modelOptions('claude', 'bogus')).toEqual(supportedModels('claude'));
  });
});
