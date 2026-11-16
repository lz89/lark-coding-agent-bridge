import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureLogger,
  closeLogger,
  flushLogger,
  log,
  sanitizeLogsForDoctor,
} from '../../../src/core/logger.js';

let logsDir = '';

describe('logger redaction', () => {
  beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), 'logger-redaction-'));
    configureLogger({
      logsDir,
      now: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeLogger();
    await rm(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  it('redacts sensitive substrings inside arbitrary string fields before writing logs', async () => {
    log.warn('agent', 'stderr', {
      line:
        'Authorization: Bearer secret-token-123 ' +
        'url=https://open.feishu.cn/open-apis?a=1&tenant_access_token=t-tenant-secret ' +
        'cwd=/Users/example/private/project',
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('secret-token-123');
    expect(text).not.toContain('t-tenant-secret');
    expect(text).not.toContain('/Users/example/private/project');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('[REDACTED_PATH]');
  });

  it('redacts nested sdk args after stringify-style recursion', async () => {
    log.warn('sdk', 'error', {
      args: [
        'POST https://open.feishu.cn/open-apis/drive?access_token=drive-token',
        {
          headers: { authorization: 'Bearer nested-token' },
          body: { file_token: 'doc-token-secret' },
          path: '/tmp/lark-channel/secret/file.txt',
        },
      ],
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('drive-token');
    expect(text).not.toContain('nested-token');
    expect(text).not.toContain('doc-token-secret');
    expect(text).not.toContain('/tmp/lark-channel/secret/file.txt');
  });

  it('redacts credentials inside stringified JSON sdk args', async () => {
    log.warn('sdk', 'error', {
      args: [
        '{"app_secret":"json-secret","tenant_access_token":"tenant-secret","token":"plain-token"}',
        '{\\"app_secret\\":\\"escaped-secret\\",\\"authorization\\":\\"Bearer escaped-token\\"}',
      ],
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('json-secret');
    expect(text).not.toContain('tenant-secret');
    expect(text).not.toContain('plain-token');
    expect(text).not.toContain('escaped-secret');
    expect(text).not.toContain('escaped-token');
  });

  it('redacts Lark resource keys and attachment tags from arbitrary previews', async () => {
    log.info('intake', 'enter', {
      preview:
        'please read <file key="file_v2_abc123rawsecret" name="secret.pdf" /> and ' +
        '{"fileKey":"file_v2_jsonrawsecret","sourceFileKey":"file_v2_sourcerawsecret"}',
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('file_v2_abc123rawsecret');
    expect(text).not.toContain('file_v2_jsonrawsecret');
    expect(text).not.toContain('file_v2_sourcerawsecret');
    expect(text).toContain('[REDACTED_RESOURCE]');
  });

  it('redacts home-relative local paths inside arbitrary strings', async () => {
    log.warn('agent', 'stderr', {
      line: 'artifact saved to ~/.lark-channel/profiles/claude/media/private.bin',
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('~/.lark-channel/profiles/claude/media/private.bin');
    expect(text).toContain('[REDACTED_PATH]');
  });

  it('logs a self-referencing field as [Circular] instead of overflowing the stack', async () => {
    // Shape of an SDK/HTTP error that points back at itself. This used to throw
    // `Maximum call stack size exceeded` out of the log call and fail the run.
    const sdkError: Record<string, unknown> = { message: 'Request failed with status code 400' };
    sdkError.self = sdkError;
    const shared = { code: 99991672 };
    expect(() =>
      log.warn('sdk', 'error', { args: [sdkError, { a: shared, b: shared }] }),
    ).not.toThrow();
    await flushLogger();

    const entry = JSON.parse((await readTodayLog()).trim().split('\n').pop() ?? '{}');
    expect(entry.args[0]).toEqual({ message: 'Request failed with status code 400', self: '[Circular]' });
    // Referenced twice but not a cycle: rendered both times.
    expect(entry.args[1]).toEqual({ a: { code: 99991672 }, b: { code: 99991672 } });
  });

  it('caps nesting depth and keeps logging', async () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    expect(() => log.info('agent', 'deep', { deep })).not.toThrow();
    await flushLogger();
    expect(await readTodayLog()).toContain('[MaxDepth]');
  });

  it('never throws from a log call, even when a field cannot be read', async () => {
    const hostile = {
      get boom(): never {
        throw new Error('getter exploded');
      },
    };
    expect(() => log.warn('agent', 'hostile', { hostile })).not.toThrow();
    expect(() => log.fail('flush', new Error('real failure'), { hostile })).not.toThrow();
    await flushLogger();
    const text = await readTodayLog();
    expect(text).toContain('"logError":"getter exploded"');
    expect(text).toContain('"event":"hostile"');
  });

  it('keeps the log-failure record itself safe: unprintable throws and secrets in the message', async () => {
    const unprintable = {
      get boom(): never {
        // A null-prototype object makes String(err) throw too.
        throw Object.create(null);
      },
    };
    const leaky = {
      get boom(): never {
        throw new Error('Authorization: Bearer leak-token-999 at /Users/example/private/repo');
      },
    };
    expect(() => log.warn('agent', 'unprintable', { unprintable })).not.toThrow();
    expect(() => log.warn('agent', 'leaky', { leaky })).not.toThrow();
    expect(() => log.warn('phase token=phase-secret-1', 'token=event-secret-2', { leaky })).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).toContain('"logError":"unprintable error"');
    expect(text).not.toContain('leak-token-999');
    expect(text).not.toContain('phase-secret-1');
    expect(text).not.toContain('event-secret-2');
    expect(text).not.toContain('/Users/example/private/repo');
    const printed = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(printed).not.toContain('leak-token-999');
    expect(printed).not.toContain('/Users/example/private/repo');
    expect(printed).not.toContain('phase-secret-1');
    expect(printed).not.toContain('event-secret-2');
  });

  it('sanitizes doctor log buffers with stderr urls and absolute paths', () => {
    const out = sanitizeLogsForDoctor(
      '{"stderr":"failed /Users/example/work/repo?app_access_token=app-secret","cwd":"/opt/private/repo","authorization":"Bearer raw-token"}',
    );

    expect(out).not.toContain('/Users/example/work/repo');
    expect(out).not.toContain('/opt/private/repo');
    expect(out).not.toContain('app-secret');
    expect(out).not.toContain('raw-token');
    expect(out).toContain('[REDACTED]');
  });

  it('sanitizes stringified JSON credentials in doctor log buffers', () => {
    const out = sanitizeLogsForDoctor(
      '{"args":["{\\"app_secret\\":\\"doctor-secret\\",\\"token\\":\\"doctor-token\\"}"]}',
    );

    expect(out).not.toContain('doctor-secret');
    expect(out).not.toContain('doctor-token');
    expect(out).toContain('[REDACTED]');
  });
});

async function readTodayLog(): Promise<string> {
  return readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
}
