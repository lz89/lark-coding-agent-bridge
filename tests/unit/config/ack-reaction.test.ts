import { describe, expect, it } from 'vitest';
import { DEFAULT_ACK_REACTION, getAckReaction, type AppConfig } from '../../../src/config/schema.js';

const cfg = (preferences: Record<string, unknown> = {}): AppConfig =>
  ({ preferences }) as unknown as AppConfig;

describe('receipt reaction config', () => {
  it('is on by default, with the 收到 sticker', () => {
    expect(getAckReaction(cfg())).toBe(DEFAULT_ACK_REACTION);
    expect(getAckReaction({} as AppConfig)).toBe('Get');
  });

  it('turns off on false, "off" (any case) and an empty value', () => {
    expect(getAckReaction(cfg({ ackReaction: false }))).toBeUndefined();
    expect(getAckReaction(cfg({ ackReaction: 'off' }))).toBeUndefined();
    expect(getAckReaction(cfg({ ackReaction: 'OFF' }))).toBeUndefined();
    expect(getAckReaction(cfg({ ackReaction: '  ' }))).toBeUndefined();
  });

  it('takes any other string as the emoji type, trimmed', () => {
    expect(getAckReaction(cfg({ ackReaction: 'OK' }))).toBe('OK');
    expect(getAckReaction(cfg({ ackReaction: ' OnIt ' }))).toBe('OnIt');
  });

  it('falls back to the default on a value of the wrong shape', () => {
    expect(getAckReaction(cfg({ ackReaction: null }))).toBe('Get');
    expect(getAckReaction(cfg({ ackReaction: 1 }))).toBe('Get');
    expect(getAckReaction(cfg({ ackReaction: true }))).toBe('Get');
  });
});
