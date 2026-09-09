import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
  type SendResult,
} from '../types';
import { sessionIdFromResult, translateEvent, usageFromResult } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
}

type ClaudeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    // The prompt and bridge system prompt must NOT go through argv. On Windows,
    // `claude` resolves to a `claude.cmd` shim and cross-spawn routes it through
    // `cmd.exe /d /s /c`, which interprets `<` and `>` as redirection operators
    // — that silently eats the prompt's `<bridge_context>` XML, so claude runs
    // with an empty request and replies with its default greeting instead of a
    // stream-json response. Pass the prompt via stdin and the appended system
    // prompt via a temp file (the same approach the Codex adapter uses) so no
    // special characters ever reach the shell.
    const systemPromptFile = writeSystemPromptFile(buildBridgeSystemPrompt(this.botIdentity));

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      // Input is stream-json too, and stdin stays open for the life of the
      // turn: that is what lets a later message be handed to a run that is
      // already working (`AgentRun.send`). Replay gives each such message a
      // receipt — the CLI echoes it, uuid intact, at the point it took it in.
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt-file',
      systemPromptFile.path,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    // Validated upstream by `resolveEffortArg` — `claude` rejects an
    // unrecognised level outright, which would fail the whole run.
    if (opts.effort) args.push('--effort', opts.effort);

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ClaudeChild;
    const input = new StdinInput(child.stdin);

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      effort: opts.effort,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
      systemPromptFile.cleanup();
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      input.markClosed();
      systemPromptFile.cleanup();
    });
    child.stdin.on('error', (err) => {
      log.warn('agent', 'stdin-error', { message: err.message });
      // The pipe itself failed; do not try to end() it, just stop admitting.
      input.markClosed();
    });
    // The CLI can close its end while the process lives on; from then on a
    // write would only fail later, so refuse it now instead.
    child.stdin.on('close', () => input.markClosed());
    // The prompt is the first stream-json line. stdin is deliberately NOT
    // ended here: the run may still be handed further messages. EOF is sent
    // when the run stops taking input — see `StdinInput.close` — and the CLI
    // then exits on its own after the turn, exactly as it did when the prompt
    // and EOF arrived together.
    input.writeInitial(opts.prompt);

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, input),
      send: (text: string) => input.send(text),
      async stop() {
        // Admission closes first, whatever the process state: nothing may be
        // written into a run that is being stopped, and whatever was already
        // written is reported dropped when the stream ends rather than left
        // in limbo. EOF alone does not stop a turn, so the signal still follows.
        input.close();
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      destroy(): void {
        input.markClosed();
        // Order matters: kill first so nothing writes into a destroyed pipe,
        // then tear the pipes down so a readline iterator parked on stdout
        // ends instead of waiting on a descendant that inherited the fd.
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          // Already reaped — nothing to kill.
        }
        log.warn('agent', 'destroy', { pid: child.pid ?? null });
        for (const stream of [child.stdout, child.stderr, child.stdin]) {
          try {
            stream.destroy();
          } catch {
            // Best-effort: a stream already torn down is the desired state.
          }
        }
        systemPromptFile.cleanup();
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  input: StdinInput,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  // One logical run can span several CLI turns: a message handed over with
  // `send` that the CLI did not fold into the running turn is run as the next
  // one, in the same process. So a `result` line is only the end when nothing
  // handed over is still waiting to be incorporated.
  let terminalYielded = false;
  // A result held back because a handed-over message was still outstanding.
  // If the process then exits without running it, this becomes the terminal.
  let heldTerminal: { sessionId: string | undefined } | undefined;
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if ((parsed as { type?: unknown }).type === 'result') {
        if (terminalYielded) {
          log.warn('agent', 'result-after-done', { pid: child.pid ?? null });
          continue;
        }
        const usage = usageFromResult(parsed);
        const sessionId = sessionIdFromResult(parsed);
        // No more input from here on, either way. EOF does not cancel a
        // message already in the pipe (measured), so an outstanding one still
        // runs — as a further turn, after which the process exits by itself.
        input.close();
        if (input.hasOutstanding()) {
          heldTerminal = { sessionId };
          if (usage) yield usage;
          yield { type: 'turn_end' };
          continue;
        }
        heldTerminal = undefined;
        terminalYielded = true;
        // Everything below `done` is unreachable once the consumer breaks on
        // it, so anything that must be said about this run is said first.
        const failed = input.takeFailed();
        if (failed.length > 0) yield { type: 'input_dropped', uuids: failed };
        if (usage) yield usage;
        yield { type: 'done', sessionId, terminationReason: 'normal' };
        continue;
      }
      for (const evt of translateEvent(parsed)) {
        if (evt.type === 'user_input') {
          // The prompt itself is replayed too; only a handed-over message is a
          // receipt anyone is waiting for.
          if (input.acknowledge(evt.uuid) === 'steer') {
            // The follow-on turn this message was waiting for has started. The
            // result held back for it no longer stands in for anything: that
            // turn ends the run with its own result, or — if it dies first —
            // with no terminal at all, which is the truth about it.
            heldTerminal = undefined;
            yield evt;
          }
          continue;
        }
        yield evt;
      }
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  // The stream is over. A handed-over message never incorporated is lost to
  // this run; its owner gets it back to deliver some other way.
  if (!terminalYielded) {
    const dropped = input.takeOutstanding();
    if (dropped.length > 0) yield { type: 'input_dropped', uuids: dropped };
    if (heldTerminal) {
      // The run's own turn finished normally; only the follow-on never ran.
      terminalYielded = true;
      yield { type: 'done', sessionId: heldTerminal.sessionId, terminationReason: 'normal' };
    }
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  }
}

/**
 * The run's stdin, as a channel that stays open.
 *
 * Three facts measured against the real CLI shape everything here:
 *  - a user line written while a turn is running is taken in at the agent's
 *    next loop boundary (folded into the same turn), or — if the turn is past
 *    that point — run as a further turn in the same process;
 *  - EOF is "no more input", never "stop": a message already written is still
 *    processed, and the process exits by itself once nothing is left;
 *  - with `--replay-user-messages` the CLI echoes each user line, uuid intact,
 *    at the moment it is incorporated. That echo is the receipt.
 *
 * So a message is *outstanding* from `send` until its echo. `close()` ends
 * admission and sends EOF; whatever is outstanding at that point is either run
 * by the CLI as its last turn, or comes back as dropped when the stream ends.
 */
class StdinInput {
  private accepting = true;
  private initialUuid: string | undefined;
  /** uuid → text, for messages written but not yet echoed. */
  private readonly outstanding = new Map<string, string>();
  /** Messages whose write failed after `send` had already returned ok. */
  private readonly failed = new Set<string>();

  constructor(private readonly stdin: Writable) {}

  writeInitial(prompt: string): void {
    const uuid = randomUUID();
    this.initialUuid = uuid;
    this.write(uuid, prompt, (err) => {
      if (err) log.warn('agent', 'prompt-write-failed', { message: err.message });
    });
  }

  send(text: string): SendResult {
    if (!this.accepting) return { ok: false, reason: 'closed' };
    const uuid = randomUUID();
    this.outstanding.set(uuid, text);
    try {
      // `write()`'s return value is backpressure, not failure — the bytes are
      // admitted either way — so it is deliberately not consulted. A failure
      // surfaces through the callback, after `send` has already returned.
      this.write(uuid, text, (err) => {
        if (!err) return;
        log.warn('agent', 'steer-write-failed', { uuid, message: err.message });
        if (this.outstanding.delete(uuid)) this.failed.add(uuid);
      });
    } catch (err) {
      this.outstanding.delete(uuid);
      log.warn('agent', 'steer-write-threw', { uuid, message: String(err) });
      return { ok: false, reason: 'write-failed' };
    }
    return { ok: true, uuid };
  }

  /** Stop admitting and send EOF. Idempotent; safe to call mid-turn. */
  close(): void {
    if (!this.accepting) return;
    this.accepting = false;
    try {
      this.stdin.end();
    } catch {
      // Pipe already gone — the desired state.
    }
  }

  /** Stop admitting without touching a pipe that has already failed or closed. */
  markClosed(): void {
    this.accepting = false;
  }

  /** What a replayed uuid was: the prompt, a handed-over message, or neither. */
  acknowledge(uuid: string): 'initial' | 'steer' | 'unknown' {
    if (uuid === this.initialUuid) return 'initial';
    return this.outstanding.delete(uuid) ? 'steer' : 'unknown';
  }

  hasOutstanding(): boolean {
    return this.outstanding.size > 0;
  }

  takeFailed(): string[] {
    const out = [...this.failed];
    this.failed.clear();
    return out;
  }

  /** Everything never incorporated, failed writes included. Clears both. */
  takeOutstanding(): string[] {
    const out = [...this.outstanding.keys(), ...this.failed];
    this.outstanding.clear();
    this.failed.clear();
    return out;
  }

  private write(uuid: string, text: string, cb: (err?: Error | null) => void): void {
    const line = `${JSON.stringify({
      type: 'user',
      uuid,
      message: { role: 'user', content: [{ type: 'text', text }] },
    })}\n`;
    this.stdin.write(line, 'utf8', cb);
  }
}

/**
 * Persist the appended system prompt to a throwaway temp file so it can be
 * passed via `--append-system-prompt-file` instead of argv. Returns the path
 * plus an idempotent, best-effort cleanup that removes the temp directory.
 */
function writeSystemPromptFile(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lark-claude-'));
  const path = join(dir, 'append-system-prompt.md');
  writeFileSync(path, content, 'utf8');
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS will reclaim the temp dir eventually
      }
    },
  };
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
