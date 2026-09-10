import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/agent/claude/adapter.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';

interface FakeBinary {
  path: string;
  dir: string;
  recordPath: string;
}

/**
 * Base argv every run starts with. stdin is stream-json too, and stays open,
 * so a further message can be handed to a run in flight; replay is what turns
 * the CLI's echo of such a message into a receipt.
 */
const BASE_ARGV = [
  '-p',
  '--output-format',
  'stream-json',
  '--input-format',
  'stream-json',
  '--replay-user-messages',
  '--verbose',
  '--permission-mode',
];

describe('ClaudeAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('spawns a fresh run with stream-json in and out, verbose, permission mode, and bridge prompt args', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-fresh' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fresh',
      prompt: 'hello',
      cwd: fake.dir,
      permissionMode: 'acceptEdits',
    });

    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-fresh', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(await realpath(record.cwd)).toBe(await realpath(fake.dir));
    expect(record.env.LARK_CHANNEL).toBe('1');
    // The prompt goes via stdin as the first stream-json user line — tagged,
    // so its replay can be told apart from a steer's — and the bridge system
    // prompt via a temp file, so neither ever touches argv (which cmd.exe
    // would mangle on Windows).
    expect(record.inputs).toHaveLength(1);
    const first = JSON.parse(record.inputs[0]!) as {
      type: string;
      uuid: string;
      message: { role: string; content: Array<{ type: string; text: string }> };
    };
    expect(first.type).toBe('user');
    expect(first.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.message).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(record.argv.slice(0, BASE_ARGV.length + 2)).toEqual([
      ...BASE_ARGV,
      'acceptEdits',
      '--append-system-prompt-file',
    ]);
    expect(record.argv).not.toContain('hello');
    expect(record.systemPrompt).toContain('lark-channel-bridge 运行约定');
    expect(record.systemPrompt).toContain('__bridge_cb');
    expect(record.systemPrompt).toContain('LARK_CHANNEL_PROFILE');
    expect(record.systemPrompt).toContain('LARKSUITE_CLI_CONFIG_DIR');
    expect(record.systemPrompt).not.toContain('lark-cli config bind --source lark-channel');
    expect(record.systemPrompt).not.toContain('__claude_cb');
    expect(record.argv).not.toContain('--resume');
    expect(record.argv).not.toContain('--model');
  });

  it('injects the active bridge profile env into spawned runs', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-profile' }],
    });
    cleanup.push(fake.dir);
    const rootDir = join(fake.dir, 'channel-home');
    const configPath = join(rootDir, 'config.custom.json');
    const larkCliConfigDir = join(rootDir, 'profiles', 'codex-dev', 'lark-cli');
    const larkCliSourceConfigFile = join(rootDir, 'profiles', 'codex-dev', 'lark-cli-source', 'config.json');

    const run = new ClaudeAdapter({
      binary: fake.path,
      larkChannel: {
        profile: 'codex-dev',
        rootDir,
        configPath,
        larkCliConfigDir,
        larkCliSourceConfigFile,
      },
    }).run({
      runId: 'run-profile-env',
      prompt: 'profile',
      cwd: fake.dir,
    });

    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'codex-dev',
      LARK_CHANNEL_HOME: rootDir,
      LARK_CHANNEL_CONFIG: larkCliSourceConfigFile,
      LARKSUITE_CLI_CONFIG_DIR: larkCliConfigDir,
    });
  });

  it('passes resume and model after the base CLI contract', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-resumed' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: fake.dir,
      sessionId: 'sess-old',
      model: 'sonnet',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'done', sessionId: 'sess-resumed', terminationReason: 'normal' },
    ]);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--resume', 'sess-old', '--model', 'sonnet']);
    expect(record.argv[BASE_ARGV.length]).toBe('bypassPermissions');
  });

  it('passes the reasoning effort level through to the CLI', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-1' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-effort',
      prompt: 'go',
      cwd: fake.dir,
      model: 'claude-fable-5',
      effort: 'xhigh',
    });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--model', 'claude-fable-5', '--effort', 'xhigh']);
  });

  it('omits --effort entirely when no level is set', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-1' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-no-effort',
      prompt: 'go',
      cwd: fake.dir,
      model: 'claude-fable-5',
    });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.argv).not.toContain('--effort');
  });

  it('passes the reasoning effort level through to the CLI', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-1' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-effort',
      prompt: 'go',
      cwd: fake.dir,
      model: 'claude-fable-5',
      effort: 'xhigh',
    });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.argv.slice(-4)).toEqual(['--model', 'claude-fable-5', '--effort', 'xhigh']);
  });

  it('omits --effort entirely when no level is set', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-1' }],
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-no-effort',
      prompt: 'go',
      cwd: fake.dir,
    });
    await collect(run.events);
    const record = await readRecord(fake.recordPath);

    expect(record.argv).not.toContain('--effort');
  });

  it('includes stderr when the process exits non-zero', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'before failure' }] } }],
      stderr: 'boom\n',
      exitCode: 42,
      exitAfterTurns: true,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fail',
      prompt: 'fail',
      cwd: fake.dir,
    });

    expect(await collect(run.events)).toEqual([
      { type: 'text', delta: 'before failure' },
      {
        type: 'error',
        message: 'claude exited with code 42: boom',
        terminationReason: 'failed',
      },
    ]);
  });

  it('surfaces spawn errors as stream error events', async () => {
    let run: ReturnType<ClaudeAdapter['run']>;
    if (process.platform === 'win32') {
      const fake = await createFakeClaude({
        lines: [],
        stderr: 'missing command\n',
        exitCode: 1,
        exitAfterTurns: true,
      });
      cleanup.push(fake.dir);
      run = new ClaudeAdapter({ binary: fake.path }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: fake.dir,
      });
    } else {
      const missing = join(tmpdir(), `missing-claude-${Date.now()}`);
      run = new ClaudeAdapter({ binary: missing }).run({
        runId: 'run-missing',
        prompt: 'hi',
        cwd: tmpdir(),
      });
    }

    const events = await collect(run.events);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect((events[0] as { message?: string }).message).toMatch(
      /failed to spawn claude|spawn returned no pid|claude exited with code/,
    );
  });

  it('waits for post-done process exit before stop fallback is needed', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-tail' }],
      exitDelayMs: 150,
    });
    cleanup.push(fake.dir);

    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-tail',
      prompt: 'tail',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-tail', terminationReason: 'normal' },
    });
    expect(await run.waitForExit(10)).toBe(false);
    expect(await run.waitForExit(1_000)).toBe(true);
    await iterator.return?.();
  });

  it('requires cwd to be resolved by policy before spawning', () => {
    expect(() =>
      new ClaudeAdapter({ binary: 'unused' }).run({ runId: 'run-no-cwd', prompt: 'hi' }),
    ).toThrow(/cwd is required/);
  });
});

/**
 * Handing a message to a run in flight. The fake CLI reproduces the three
 * behaviours measured on the real one: a message that arrives inside the turn
 * is folded into it (one result), one that arrives outside it runs as a further
 * turn (a result each), and every message is replayed with its uuid at the
 * moment it is taken in.
 */
describe('ClaudeAdapter steering', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('a message folded into the running turn: receipt, then a single done', async () => {
    const fake = await createFakeClaude({
      turns: [
        [
          text('working…'),
          { __awaitInput: true },
          text('STEERED'),
          { type: 'result', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 2 } },
        ],
      ],
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-fold',
      prompt: 'start',
      cwd: fake.dir,
    });

    const events = await driveWithSteer(run, 'change of plan', (e) => e.type === 'text');

    expect(events.map((e) => e.type)).toEqual(['text', 'user_input', 'text', 'usage', 'done']);
    const receipt = events[1] as { uuid: string; text: string };
    expect(receipt.text).toBe('change of plan');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);

    const record = await readRecord(fake.recordPath);
    expect(record.inputs).toHaveLength(2);
    const steerLine = JSON.parse(record.inputs[1]!) as { uuid: string; message: unknown };
    expect(steerLine.uuid).toBe(receipt.uuid);
    expect(steerLine.message).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'change of plan' }],
    });
  });

  it('a message that spills into a further turn: the first result is a boundary, the last is done', async () => {
    const fake = await createFakeClaude({
      turns: [
        [text('turn one'), { type: 'result', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 } }],
        [text('turn two'), { type: 'result', session_id: 'sess-1', usage: { input_tokens: 5, output_tokens: 5 } }],
      ],
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-spill',
      prompt: 'start',
      cwd: fake.dir,
    });

    const events = await driveWithSteer(run, 'and also this', (e) => e.type === 'text');

    expect(events.map((e) => e.type)).toEqual([
      'text',
      'usage',
      'turn_end',
      'user_input',
      'text',
      'usage',
      'done',
    ]);
    // The footer numbers come from the last turn.
    const usages = events.filter((e) => e.type === 'usage') as Array<{ inputTokens?: number }>;
    expect(usages.map((u) => u.inputTokens)).toEqual([1, 5]);
    expect((events.at(-1) as { sessionId?: string }).sessionId).toBe('sess-1');
  });

  it('a follow-on turn that dies after taking the message in is a failure, not the held result', async () => {
    const fake = await createFakeClaude({
      turns: [
        [text('turn one'), { type: 'result', session_id: 'sess-1' }],
        // Takes the message in (replay), starts working, then crashes.
        [text('turn two'), { __exit: 1 }],
      ],
      stderr: 'segfault\n',
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-spill-crash',
      prompt: 'start',
      cwd: fake.dir,
    });

    const events = await driveWithSteer(run, 'and this', (e) => e.type === 'text');

    expect(events.map((e) => e.type)).toEqual(['text', 'turn_end', 'user_input', 'text', 'error']);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect((events.at(-1) as { message: string }).message).toContain('exited with code 1');
  });

  it('a message the CLI never took in is reported dropped, and the held result still ends the run normally', async () => {
    const fake = await createFakeClaude({
      turns: [
        [text('only turn'), { type: 'result', session_id: 'sess-1' }],
        // The second line gets no echo and no turn: the process just exits on EOF.
        null,
      ],
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-drop',
      prompt: 'start',
      cwd: fake.dir,
    });

    const events: AgentEvent[] = [];
    let uuid: string | undefined;
    for await (const evt of run.events) {
      events.push(evt);
      if (evt.type === 'text' && !uuid) {
        const res = run.send!('lost');
        expect(res.ok).toBe(true);
        if (res.ok) uuid = res.uuid;
      }
    }
    expect(events.map((e) => e.type)).toEqual(['text', 'turn_end', 'input_dropped', 'done']);
    expect((events[2] as { uuids: string[] }).uuids).toEqual([uuid]);
    expect((events[3] as { sessionId?: string }).sessionId).toBe('sess-1');
  });

  it('refuses a message once the run has stopped taking input', async () => {
    const fake = await createFakeClaude({
      lines: [{ type: 'result', session_id: 'sess-1' }],
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-closed',
      prompt: 'start',
      cwd: fake.dir,
    });

    const events = await collect(run.events);
    expect(events.map((e) => e.type)).toEqual(['done']);
    expect(run.send!('too late')).toEqual({ ok: false, reason: 'closed' });
  });

  it('stop() closes admission before it signals', async () => {
    const fake = await createFakeClaude({
      turns: [[text('busy'), { __awaitInput: true }, { type: 'result', session_id: 'sess-1' }]],
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path, }).run({
      runId: 'run-stop',
      prompt: 'start',
      cwd: fake.dir,
      stopGraceMs: 200,
    });

    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'text', delta: 'busy' });
    await run.stop();
    expect(run.send!('after stop')).toEqual({ ok: false, reason: 'closed' });
    await iterator.return?.();
  });

  it('refuses a message once the CLI has closed its end of stdin', async () => {
    const fake = await createFakeClaude({
      // The turn keeps going after stdin is closed from the CLI side.
      turns: [[text('busy'), { __closeStdin: true }, { __awaitEvent: 'never' }]],
      closeStdinInsteadOfWaiting: true,
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-stdin-closed',
      prompt: 'start',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'text', delta: 'busy' });
    // Give the close a moment to propagate through the pipe.
    for (let i = 0; i < 50 && run.send!('probe').ok; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(run.send!('after close')).toEqual({ ok: false, reason: 'closed' });
    run.destroy?.();
    await iterator.return?.();
  });

  it('destroy() closes admission too', async () => {
    const fake = await createFakeClaude({
      turns: [[text('busy'), { __awaitInput: true }, { type: 'result', session_id: 'sess-1' }]],
    });
    cleanup.push(fake.dir);
    const run = new ClaudeAdapter({ binary: fake.path }).run({
      runId: 'run-destroy',
      prompt: 'start',
      cwd: fake.dir,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'text', delta: 'busy' });
    run.destroy?.();
    expect(run.send!('after destroy')).toEqual({ ok: false, reason: 'closed' });
    await iterator.return?.();
    await run.waitForExit(2_000);
  });
});

function text(t: string): unknown {
  return { type: 'assistant', message: { content: [{ type: 'text', text: t }] } };
}

/** Consume the run, handing `steer` over the first time `when` matches. */
async function driveWithSteer(
  run: AgentRun,
  steer: string,
  when: (e: AgentEvent) => boolean,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  let sent = false;
  for await (const evt of run.events) {
    out.push(evt);
    if (!sent && when(evt)) {
      sent = true;
      const res = run.send!(steer);
      expect(res.ok).toBe(true);
    }
  }
  return out;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * A stand-in for the `claude` binary that behaves like the real one on stdin:
 * it reads stream-json user lines as they arrive rather than waiting for EOF,
 * replays each one it takes in (uuid intact) when asked to, runs one scripted
 * turn per line, and exits on its own once stdin closes and it has nothing
 * left to say.
 *
 * `turns[i]` is the script for the i-th user line. A `{ __awaitInput: true }`
 * entry inside a script makes that turn wait for the next line and take it in
 * *there* — the folded case. A `null` script ignores the line entirely — the
 * case where the CLI never takes a message in.
 */
async function createFakeClaude(options: {
  lines?: unknown[];
  turns?: Array<unknown[] | null>;
  stderr?: string;
  exitCode?: number;
  exitDelayMs?: number;
  /** Exit as soon as the scripts are done instead of waiting for EOF. */
  exitAfterTurns?: boolean;
  /** Do not exit on EOF (used with a `__closeStdin` script that closes it itself). */
  closeStdinInsteadOfWaiting?: boolean;
}): Promise<FakeBinary> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-adapter-test-'));
  const path = join(dir, 'fake-claude.mjs');
  const recordPath = join(dir, 'argv.json');
  const turns = options.turns ?? [options.lines ?? []];
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      'import { writeFileSync, readFileSync } from "node:fs";',
      'import readline from "node:readline";',
      'const argv = process.argv.slice(2);',
      'const spIdx = argv.indexOf("--append-system-prompt-file");',
      'const systemPrompt = spIdx !== -1 ? readFileSync(argv[spIdx + 1], "utf8") : null;',
      'const replay = argv.includes("--replay-user-messages");',
      `const turns = ${JSON.stringify(turns)};`,
      `const exitAfterTurns = ${options.exitAfterTurns ? 'true' : 'false'};`,
      `const ignoreEof = ${options.closeStdinInsteadOfWaiting ? 'true' : 'false'};`,
      'const inputs = [];',
      'let turnIdx = 0;',
      'let waiting = null;',
      'let finished = false;',
      'let chain = Promise.resolve();',
      'const emit = (line) => console.log(JSON.stringify(line));',
      'const echo = (parsed) => {',
      '  if (!replay) return;',
      '  emit({ type: "user", isReplay: true, uuid: parsed.uuid, message: parsed.message, session_id: "sess-fake" });',
      '};',
      'async function runTurn(script) {',
      '  for (const line of script) {',
      '    if (line && line.__awaitInput) {',
      '      const next = await new Promise((resolve) => { waiting = resolve; });',
      '      echo(next);',
      '      continue;',
      '    }',
      '    if (line && line.__closeStdin) { process.stdin.destroy(); continue; }',
      '    if (line && line.__awaitEvent === "never") { await new Promise(() => {}); }',
      '    if (line && typeof line.__exit === "number") { finish(line.__exit); return; }',
      '    emit(line);',
      '  }',
      '}',
      'function finish(code) {',
      '  if (finished) return;',
      '  finished = true;',
      `  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
      '    argv,',
      '    stdin: inputs.join("\\n"),',
      '    inputs,',
      '    systemPrompt,',
      '    cwd: process.cwd(),',
      '    env: {',
      '      LARK_CHANNEL: process.env.LARK_CHANNEL,',
      '      LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,',
      '      LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,',
      '      LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,',
      '      LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,',
      '    },',
      '  }));',
      options.stderr ? `  process.stderr.write(${JSON.stringify(options.stderr)});` : '',
      `  setTimeout(() => process.exit(code ?? ${options.exitCode ?? 0}), ${options.exitDelayMs ?? 0});`,
      '}',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", (raw) => {',
      '  if (!raw.trim()) return;',
      '  inputs.push(raw);',
      '  let parsed;',
      '  try { parsed = JSON.parse(raw); } catch { return; }',
      '  if (waiting) { const resolve = waiting; waiting = null; resolve(parsed); return; }',
      '  const script = turnIdx < turns.length ? turns[turnIdx] : [];',
      '  turnIdx += 1;',
      '  if (script === null) return;',
      '  chain = chain.then(async () => {',
      '    echo(parsed);',
      '    await runTurn(script);',
      '    if (exitAfterTurns && turnIdx >= turns.length) finish();',
      '  });',
      '});',
      'rl.on("close", () => { if (!ignoreEof) chain.then(finish); });',
      'process.on("SIGTERM", () => process.exit(143));',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function readRecord(path: string): Promise<{
  argv: string[];
  stdin: string;
  inputs: string[];
  systemPrompt: string | null;
  cwd: string;
  env: {
    LARK_CHANNEL?: string;
    LARK_CHANNEL_PROFILE?: string;
    LARK_CHANNEL_HOME?: string;
    LARK_CHANNEL_CONFIG?: string;
    LARKSUITE_CLI_CONFIG_DIR?: string;
  };
}> {
  return JSON.parse(await readFile(path, 'utf8')) as {
    argv: string[];
    stdin: string;
    inputs: string[];
    systemPrompt: string | null;
    cwd: string;
    env: {
      LARK_CHANNEL?: string;
      LARK_CHANNEL_PROFILE?: string;
      LARK_CHANNEL_HOME?: string;
      LARK_CHANNEL_CONFIG?: string;
      LARKSUITE_CLI_CONFIG_DIR?: string;
    };
  };
}
