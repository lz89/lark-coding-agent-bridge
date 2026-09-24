import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT,
  isDefaultEffort,
  resolveEffortArg,
  resolveModelArg,
  supportedEfforts,
  supportedModels,
} from '../../../src/agent/models.js';

describe('model catalog', () => {
  it('offers Fable 5 and Opus 5 to Claude profiles', () => {
    const values = supportedModels('claude').map((m) => m.value);
    expect(values).toContain('claude-fable-5');
    expect(values).toContain('claude-opus-5');
    expect(values).toContain('claude-opus-5-5');
  });

  it('forwards a catalogued model verbatim', () => {
    expect(resolveModelArg('claude', 'claude-fable-5')).toBe('claude-fable-5');
    expect(resolveModelArg('claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('forwards an uncatalogued but well-formed model verbatim', () => {
    // A model written straight into config.json (e.g. one released after this
    // catalog) must reach `--model`; the CLI / API validates it and the run
    // surfaces any error instead of silently using the account default.
    expect(resolveModelArg('claude', 'claude-opus-7-2')).toBe('claude-opus-7-2');
    expect(resolveModelArg('claude', 'claude-not-a-model')).toBe('claude-not-a-model');
  });

  it('drops a value that cannot be a Claude model id', () => {
    expect(resolveModelArg('claude', 'not a model')).toBeUndefined();
    expect(resolveModelArg('claude', 'gpt-5')).toBeUndefined();
  });

  it('does not offer Claude models to a codex profile', () => {
    expect(supportedModels('codex').map((m) => m.value)).not.toContain('claude-fable-5');
  });
});

describe('reasoning effort', () => {
  it('accepts every level the claude CLI documents', () => {
    const values = supportedEfforts('claude').map((e) => e.value);
    expect(values).toEqual([DEFAULT_EFFORT, 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('forwards a valid level', () => {
    expect(resolveEffortArg('claude', 'xhigh')).toBe('xhigh');
    expect(resolveEffortArg('claude', 'max')).toBe('max');
  });

  it('omits the flag for the default sentinel and for unset', () => {
    expect(resolveEffortArg('claude', DEFAULT_EFFORT)).toBeUndefined();
    expect(resolveEffortArg('claude', undefined)).toBeUndefined();
    expect(isDefaultEffort(undefined)).toBe(true);
  });

  it('drops an invalid level instead of forwarding it', () => {
    // `claude --effort bogus` exits non-zero, which would fail the whole run —
    // omitting the flag degrades to the default instead.
    expect(resolveEffortArg('claude', 'ultra')).toBeUndefined();
    expect(resolveEffortArg('claude', 'XHIGH')).toBeUndefined();
  });

  it('never forwards effort for codex, which has no such flag', () => {
    expect(supportedEfforts('codex')).toEqual([]);
    expect(resolveEffortArg('codex', 'xhigh')).toBeUndefined();
  });
});
