import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { content?: ContentBlock[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, { contextWindow?: number }>;
  total_cost_usd?: number;
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      const u = evt.usage;
      // Claude's `input_tokens` counts only the uncached remainder, so the
      // whole prompt is the three buckets added together.
      const contextTokens =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.output_tokens ?? 0);
      yield {
        type: 'usage',
        contextTokens: contextTokens > 0 ? contextTokens : undefined,
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        cacheCreationInputTokens: evt.usage.cache_creation_input_tokens,
        // The CLI reports the window per model it used. Keyed by model id, so
        // read the largest — a turn that touched only one model has one entry,
        // and a turn that spilled to a fallback should be sized by the roomier
        // window rather than whichever key happened to enumerate first.
        contextWindow: largestContextWindow(evt.modelUsage),
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}

/**
 * Largest `contextWindow` across the models the CLI reports for a turn, or
 * `undefined` when it reports none. Tolerant of shape drift: `modelUsage` is a
 * newer field than the rest of `usage`, so anything unexpected yields
 * `undefined` and the footer simply drops the percentage.
 */
function largestContextWindow(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  let largest: number | undefined;
  for (const entry of Object.values(modelUsage)) {
    const w = entry?.contextWindow;
    if (typeof w === 'number' && Number.isFinite(w) && w > 0 && (largest === undefined || w > largest)) {
      largest = w;
    }
  }
  return largest;
}
