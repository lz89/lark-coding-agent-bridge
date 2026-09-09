import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin, never argv (cmd.exe would mangle it on
    // Windows) — as the first stream-json line, with stdin left open so the
    // run can still be handed messages.
    expect(promptText(await readFirstLine(child.stdin))).toBe('hi');
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(promptText(await readFirstLine(child.stdin))).toBe('hi');
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined));
  });

  function promptText(line: string): string {
    const parsed = JSON.parse(line) as {
      type: string;
      uuid: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(parsed.type).toBe('user');
    expect(parsed.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.message.role).toBe('user');
    return parsed.message.content.map((c) => c.text).join('');
  }

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});

describe('CodexAdapter system prompt wiring', () => {
  function codexAdapter(): CodexAdapter {
    return new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
    });
  }

  it('prefixes stdin with the identity-aware bridge system prompt after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The first newline-terminated line, without waiting for the stream to end. */
async function readFirstLine(stream: PassThrough): Promise<string> {
  let buffered = '';
  for await (const chunk of stream) {
    buffered += (chunk as Buffer).toString('utf8');
    const nl = buffered.indexOf('\n');
    if (nl !== -1) return buffered.slice(0, nl);
  }
  return buffered;
}
