import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('Claude stream-json translator', () => {
  it('translates system init metadata', () => {
    expect([
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'sonnet',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'sonnet' },
    ]);
    expect([...translateEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })][0]).not.toHaveProperty('threadId');
  });

  it('translates assistant text, thinking, and tool_use blocks in order', () => {
    expect([
      ...translateEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'checking' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
    ]).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'thinking', delta: 'checking' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('translates user tool_result blocks including structured output and errors', () => {
    expect([
      ...translateEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      }),
    ]).toEqual([
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 'tool-2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('translates a replayed user message into a receipt carrying its uuid', () => {
    // `--replay-user-messages`: the CLI echoes a user line at the moment it
    // takes it in, with whatever uuid the writer put on it. That echo is how
    // the bridge learns a mid-run message reached the agent.
    expect([
      ...translateEvent({
        type: 'user',
        isReplay: true,
        uuid: 'steer-1',
        session_id: 'sess-1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '改成蓝色' },
            { type: 'text', text: '别动其它' },
          ],
        },
      }),
    ]).toEqual([{ type: 'user_input', uuid: 'steer-1', text: '改成蓝色\n别动其它' }]);
  });

  it('does not mistake a tool_result user line for a receipt', () => {
    expect([
      ...translateEvent({
        type: 'user',
        uuid: 'cli-generated',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
      }),
    ]).toEqual([{ type: 'tool_result', id: 't', output: 'ok', isError: false }]);
  });

  it('translates result usage before done', () => {
    expect([
      ...translateEvent({
        type: 'result',
        session_id: 'sess-2',
        // Top-level totals are summed over every request the agentic loop
        // made; `iterations` describes the final message. Shapes and ratios
        // here are taken from a real 4-tool-call run.
        usage: {
          input_tokens: 8,
          output_tokens: 895,
          cache_read_input_tokens: 144_499,
          cache_creation_input_tokens: 15_764,
          iterations: [
            {
              input_tokens: 2,
              output_tokens: 678,
              cache_read_input_tokens: 40_113,
              cache_creation_input_tokens: 75,
            },
          ],
        },
        total_cost_usd: 0.1234,
      }),
    ]).toEqual([
      {
        type: 'usage',
        // Final request only: 2 + 40113 + 75 + 678. Summing the top-level
        // totals instead would give 161166 — four times over, and past a 1M
        // window within a normal session.
        contextTokens: 40_868,
        inputTokens: 8,
        outputTokens: 895,
        cachedInputTokens: 144_499,
        cacheCreationInputTokens: 15_764,
        contextWindow: undefined,
        costUsd: 0.1234,
      },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
    expect([...translateEvent({ type: 'result', session_id: 'sess-2' })][0]).not.toHaveProperty('threadId');
  });

  it('reports no context size when the CLI gives no per-request breakdown', () => {
    // Cumulative totals cannot be decomposed into the final request, and no
    // footer beats a fourfold-wrong one.
    const [usage] = [...translateEvent({
      type: 'result',
      session_id: 'sess-3',
      usage: { input_tokens: 8, output_tokens: 895, cache_read_input_tokens: 144_499 },
    })];
    expect(usage).toMatchObject({ type: 'usage', contextTokens: undefined });
  });

  it('reads plain-string message content as a single text block', () => {
    // The CLI replays user lines it injects itself (e.g. a background task's
    // notification) with string content, not an array. Seen in production as
    // `evt.message.content.filter is not a function`, which failed the run.
    expect([
      ...translateEvent({
        type: 'user',
        isReplay: true,
        uuid: 'cli-injected',
        message: { role: 'user', content: '<task-notification>done</task-notification>' },
      }),
    ]).toEqual([{ type: 'user_input', uuid: 'cli-injected', text: '<task-notification>done</task-notification>' }]);
    expect([...translateEvent({ type: 'user', message: { content: 'no tool result here' } })]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: 'plain reply' } })]).toEqual([
      { type: 'text', delta: 'plain reply' },
    ]);
  });

  it('never throws on content that is neither an array nor a string', () => {
    for (const content of [42, true, { type: 'text', text: 'x' }, [null, 'x', 7, { text: 'no type' }]]) {
      expect(() => [...translateEvent({ type: 'assistant', message: { content } })]).not.toThrow();
      expect([...translateEvent({ type: 'assistant', message: { content } })]).toEqual([]);
      expect([
        ...translateEvent({ type: 'user', isReplay: true, uuid: 'u', message: { content } }),
      ]).toEqual([{ type: 'user_input', uuid: 'u', text: '' }]);
    }
  });

  it('ignores unknown, empty, and incomplete raw events', () => {
    expect([...translateEvent(null)]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'system', subtype: 'other' })]).toEqual([]);
  });
});

describe('Claude stream-json reader behavior', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('skips non-JSON stdout lines and reports non-zero stderr detail without redacting visible paths', async () => {
    const stderr = 'fatal stderr at /Users/example/work/repo/file.ts';
    const binary = await createFakeBinary([
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } }),
    ], 7, stderr);
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-reader',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const events = await collect(run.events);

    expect(events).toEqual([
      { type: 'text', delta: 'kept' },
      {
        type: 'error',
        message: `claude exited with code 7: ${stderr}`,
        terminationReason: 'failed',
      },
    ]);
  });

  it('drops a whole line whose translation throws midway and keeps reading', async () => {
    // Defence in depth: whatever the translator yielded before throwing is
    // discarded with the line, and the stream carries on to the result.
    vi.resetModules();
    vi.doMock('../../../src/agent/claude/stream-json', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/agent/claude/stream-json.js')>();
      return {
        ...actual,
        *translateEvent(raw: unknown) {
          if ((raw as { poison?: boolean } | null)?.poison) {
            yield { type: 'text', delta: 'partial' } as AgentEvent;
            throw new Error('translator blew up');
          }
          yield* actual.translateEvent(raw);
        },
      };
    });
    try {
      const { ClaudeAdapter: MockedAdapter } = await import('../../../src/agent/claude/adapter.js');
      const binary = await createFakeBinary([
        JSON.stringify({ type: 'assistant', poison: true, message: { content: [] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'after' }] } }),
        JSON.stringify({ type: 'result', session_id: 'sess-p' }),
      ], 0, '');
      cleanup = binary.cleanup;
      const run = new MockedAdapter({ binary: binary.path }).run({ runId: 'run-poison', prompt: 'hi', cwd: tmpdir() });
      expect(await collect(run.events)).toEqual([
        { type: 'text', delta: 'after' },
        { type: 'done', sessionId: 'sess-p', terminationReason: 'normal' },
      ]);
    } finally {
      vi.doUnmock('../../../src/agent/claude/stream-json');
      vi.resetModules();
    }
  });

  it('finishes normally when the CLI replays a string-content user line it injected itself', async () => {
    // Production shape (lin, 2026-11-02): the run's reply was complete, then the
    // CLI echoed a self-injected user line with string content; the run used to
    // fail with `evt.message.content.filter is not a function`.
    const binary = await createFakeBinary([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }),
      JSON.stringify({
        type: 'user',
        isReplay: true,
        uuid: 'cli-injected',
        message: { role: 'user', content: '<task-notification>bg done</task-notification>' },
      }),
      'null',
      JSON.stringify({ type: 'result', session_id: 'sess-x' }),
    ], 0, '');
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-string-replay',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const events = await collect(run.events);

    expect(events).toEqual([
      { type: 'text', delta: 'answer' },
      { type: 'done', sessionId: 'sess-x', terminationReason: 'normal' },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeBinary(lines: string[], exitCode: number, stderr: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stream-json-test-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(lines)};`,
      'for (const line of lines) console.log(line);',
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return {
    path,
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
