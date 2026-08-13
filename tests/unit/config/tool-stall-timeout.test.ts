import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_STALL_GRACE_MINUTES,
  DEFAULT_TOOL_STALL_TIMEOUT_MINUTES,
  getRunIdleTimeoutMs,
  getToolStallGraceMs,
  getToolStallTimeoutMs,
  type AppConfig,
} from '../../../src/config/schema.js';

const cfg = (preferences: Record<string, unknown> = {}): AppConfig =>
  ({ preferences }) as unknown as AppConfig;

describe('tool stall watchdog config', () => {
  it('is on by default, unlike the idle watchdog', () => {
    // The distinction that matters: a run wedged behind a tool call has no
    // other timeout, so this one cannot be opt-in the way the idle one is.
    expect(getToolStallTimeoutMs(cfg())).toBe(DEFAULT_TOOL_STALL_TIMEOUT_MINUTES * 60_000);
    expect(getToolStallGraceMs(cfg())).toBe(DEFAULT_TOOL_STALL_GRACE_MINUTES * 60_000);
    expect(getRunIdleTimeoutMs(cfg())).toBeUndefined();
  });

  it('leaves a full 30 minutes of true silence before anything is killed', () => {
    const total = getToolStallTimeoutMs(cfg())! + getToolStallGraceMs(cfg());
    expect(total).toBe(30 * 60_000);
  });

  it('treats an explicit 0 as "disabled", not as "fire immediately"', () => {
    expect(getToolStallTimeoutMs(cfg({ toolStallTimeoutMinutes: 0 }))).toBeUndefined();
    expect(getToolStallTimeoutMs(cfg({ toolStallTimeoutMinutes: -5 }))).toBeUndefined();
  });

  it('clamps typos instead of trusting them', () => {
    expect(getToolStallTimeoutMs(cfg({ toolStallTimeoutMinutes: 99999 }))).toBe(240 * 60_000);
    expect(getToolStallTimeoutMs(cfg({ toolStallTimeoutMinutes: 1.9 }))).toBe(60_000);
    // A positive fraction is a value the user meant, just below the floor —
    // clamped up to the 1-minute minimum rather than silently disabled.
    expect(getToolStallTimeoutMs(cfg({ toolStallTimeoutMinutes: 0.4 }))).toBe(60_000);
    expect(getToolStallGraceMs(cfg({ toolStallGraceMinutes: 99999 }))).toBe(240 * 60_000);
  });

  it('falls back to the default on a non-numeric value rather than disabling', () => {
    expect(getToolStallTimeoutMs(cfg({ toolStallTimeoutMinutes: 'soon' }))).toBeUndefined();
    expect(getToolStallTimeoutMs(cfg({ toolStallTimeoutMinutes: Number.NaN }))).toBeUndefined();
  });

  it('supports a zero grace: warn and stop in the same breath', () => {
    expect(getToolStallGraceMs(cfg({ toolStallGraceMinutes: 0 }))).toBe(0);
  });
});
