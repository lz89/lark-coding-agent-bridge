import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';

type Child = SpawnedProcessByStdio<Writable, Readable, Readable>;
type RecordValue = Record<string, unknown>;

/**
 * A short-lived stdio app-server resumes the exact exec thread and compacts it.
 * The RPC acknowledgement is NOT completion: wait for the compaction item and
 * its successful turn/completed notification before reporting success.
 * Protocol: https://developers.openai.com/codex/app-server#trigger-thread-compaction
 */
export function startCodexCompaction(input: {
  binary: string;
  opts: AgentRunOptions;
  env: NodeJS.ProcessEnv;
  stopGraceMs: number;
  timeoutMs?: number;
}): AgentRun {
  const { opts } = input;
  if (!opts.cwd || !opts.threadId) throw new Error('compact requires cwd and threadId');
  const sandbox = opts.sandbox ?? 'read-only';
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
    throw new Error('invalid compact sandbox mode');
  }

  const child = spawnProcess(input.binary, ['app-server'], {
    cwd: opts.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as Child;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let closed = false;
  const exit = new Promise<void>((resolve) => {
    child.once('close', () => { closed = true; resolve(); });
  });
  let settled = false;
  let shutdownPromise: Promise<void> | undefined;
  let stage: 1 | 2 | 3 = 1;
  let acknowledged = false;
  let turnId: string | undefined;
  let compacted = false;
  let completed = false;
  let stderr = '';
  let resolveResult!: (event: AgentEvent) => void;
  const result = new Promise<AgentEvent>((resolve) => { resolveResult = resolve; });

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exit.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const shutdown = (normal: boolean): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      lines.close();
      child.stdout.resume();
      if (!closed) {
        if (normal) child.stdin.end();
        else child.kill('SIGTERM');
        if (!await waitForExit(input.stopGraceMs)) {
          child.kill('SIGKILL');
          // Descendants may hold the pipes open even after the server exits.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          await waitForExit(1000);
        }
      }
    })();
    return shutdownPromise;
  };
  const finish = (event: AgentEvent): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    void shutdown(event.type === 'done' && event.terminationReason === 'normal')
      .then(() => resolveResult(event), () => resolveResult(event));
  };
  const fail = (message: string): void => finish({ type: 'error', message, terminationReason: 'failed' });
  const timeout = setTimeout(() => finish({
    type: 'error', message: 'Codex compaction timed out', terminationReason: 'timeout',
  }), input.timeoutMs ?? 300_000);

  const send = (message: RecordValue): void => {
    if (settled) return;
    child.stdin.write(`${JSON.stringify(message)}\n`, (err) => {
      if (err) fail(`Codex app-server input failed: ${err.message}`);
    });
  };
  const maybeComplete = (): void => {
    if (acknowledged && compacted && completed) {
      finish({ type: 'done', threadId: opts.threadId, terminationReason: 'normal' });
    }
  };

  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
  child.stdin.on('error', (err) => fail(`Codex app-server input failed: ${err.message}`));
  child.stdout.on('error', (err) => fail(`Codex app-server output failed: ${err.message}`));
  child.on('error', (err) => fail(`Codex app-server failed: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (!settled) fail(`Codex app-server exited before compaction completed (${code ?? signal}): ${stderr}`);
  });
  lines.on('close', () => {
    if (!settled) fail(`Codex app-server closed output before compaction completed: ${stderr}`);
  });
  lines.on('line', (line) => {
    if (settled || !line.trim()) return;
    let message: RecordValue | undefined;
    try { message = record(JSON.parse(line)); } catch { /* handled below */ }
    if (!message) { fail('Invalid JSON from Codex app-server'); return; }

    // Compaction must never fall back to an ordinary tool-enabled user turn.
    // Reject server requests (including approvals) instead of granting them.
    if (typeof message.method === 'string' && message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'Unsupported during compaction' } });
      fail('Codex requested an interactive action during compaction');
      return;
    }
    if (message.id !== undefined) {
      if (message.id !== stage) return;
      const error = record(message.error);
      if (error) {
        fail(`Codex compaction RPC failed: ${String(error.message ?? error.code)}`);
        return;
      }
      const response = record(message.result);
      if (!response) { fail('Invalid Codex compaction RPC response'); return; }
      if (stage === 1) {
        send({ method: 'initialized', params: {} });
        stage = 2;
        send({ id: 2, method: 'thread/resume', params: {
          threadId: opts.threadId,
          cwd: opts.cwd,
          approvalPolicy: 'never',
          sandbox,
          ...(opts.model ? { model: opts.model } : {}),
        } });
      } else if (stage === 2) {
        if (record(response.thread)?.id !== opts.threadId) {
          fail('Codex resumed a different thread');
          return;
        }
        stage = 3;
        send({ id: 3, method: 'thread/compact/start', params: { threadId: opts.threadId } });
      } else {
        acknowledged = true;
        maybeComplete();
      }
      return;
    }

    const params = record(message.params);
    if (stage !== 3 || !params || params.threadId !== opts.threadId) return;
    const turn = record(params.turn);
    if (message.method === 'turn/started' && typeof turn?.id === 'string' && !turnId) {
      turnId = turn.id;
    }
    if (message.method === 'error' && params.willRetry !== true) {
      fail(`Codex compaction failed: ${String(record(params.error)?.message ?? 'unknown error')}`);
    }
    if (message.method === 'item/completed' && turnId && params.turnId === turnId &&
        record(params.item)?.type === 'contextCompaction') {
      compacted = true;
      maybeComplete();
    }
    if (message.method === 'turn/completed' && turnId && turn?.id === turnId) {
      if (turn.status !== 'completed') {
        finish({
          type: 'error',
          message: `Codex compaction ${String(turn.status)}: ${String(record(turn.error)?.message ?? '')}`,
          terminationReason: turn.status === 'interrupted' ? 'interrupted' : 'failed',
        });
      } else {
        completed = true;
        maybeComplete();
      }
    }
  });
  send({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'lark_channel_bridge', version: '0.7.0' },
  } });

  return {
    runId: opts.runId,
    events: { async *[Symbol.asyncIterator]() { yield await result; } },
    async stop() {
      finish({ type: 'done', threadId: opts.threadId, terminationReason: 'interrupted' });
      await shutdown(false);
    },
    waitForExit,
    destroy() {
      child.kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ type: 'error', message: 'Codex compaction terminated', terminationReason: 'interrupted' });
    },
  };
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}
