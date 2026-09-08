import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '../types';

/** Exec totals span multiple requests. Only the rollout's last request is context. */
export async function readCodexTelemetry(
  codexHome: string,
  threadId: string | undefined,
  startedAt: number,
): Promise<AgentEvent[]> {
  if (!threadId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) return [];
  try {
    const path = await findRollout(join(codexHome, 'sessions'), threadId, 3);
    if (!path) return [];
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let model: string | undefined;
    let effort: string | undefined;
    let contextTokens: number | undefined;
    let contextWindow: number | undefined;
    let turnId: string | undefined;
    for await (const line of lines) {
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }
      if (!raw || Date.parse(raw.timestamp) < startedAt || !Number.isFinite(Date.parse(raw.timestamp))) continue;
      const payload = raw.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (raw.type === 'turn_context') {
        if (payload.turn_id !== turnId) {
          turnId = payload.turn_id;
          contextTokens = contextWindow = undefined;
        }
        model = typeof payload.model === 'string' ? payload.model : undefined;
        effort = typeof payload.effort === 'string' ? payload.effort : undefined;
      }
      if (raw.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
        // input_tokens already includes cached tokens. total_token_usage is
        // cumulative and must never be substituted for last_token_usage.
        contextTokens = tokenCount(payload.info.last_token_usage?.total_tokens);
        contextWindow = tokenCount(payload.info.model_context_window);
      }
    }
    const events: AgentEvent[] = [];
    if (model || effort) events.push({ type: 'system', model, effort });
    if (contextTokens !== undefined) events.push({ type: 'usage', contextTokens, contextWindow });
    return events;
  } catch {
    // Optional footer data must never break delivery or fall back to another thread.
    return [];
  }
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000
    ? value : undefined;
}

async function findRollout(dir: string, threadId: string, depth: number): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) {
      return join(dir, entry.name);
    }
  }
  if (depth === 0) return undefined;
  for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
    if (!entry.isDirectory() || !/^\d{2,4}$/.test(entry.name)) continue;
    const found = await findRollout(join(dir, entry.name), threadId, depth - 1);
    if (found) return found;
  }
  return undefined;
}
