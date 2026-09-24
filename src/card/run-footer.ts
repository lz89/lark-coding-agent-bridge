import type { RunMeta } from './run-state';
import { formatModelName } from '../agent/models';

/**
 * The per-reply footer: `🧠 403K · Fable 5 · max`.
 *
 * Shared by the card and text renderers so the two can't drift apart, and
 * kept deliberately dumb — it formats whatever it is handed and returns
 * `undefined` when there is nothing worth showing.
 */

const MODEL_CAP = 32;

/**
 * Model id → display name, derived from the id itself (see
 * {@link formatModelName}) so a model shipped after this code was written is
 * still named properly on the footer.
 */
export function prettyModel(id: string | undefined): string | undefined {
  if (typeof id !== 'string') return undefined;
  const trimmed = id.trim();
  if (!trimmed || trimmed === '<synthetic>') return undefined;
  return formatModelName(trimmed).slice(0, MODEL_CAP) || undefined;
}

/** `403K`, or `1.2M` past a million. Below 1K is shown exactly. */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/**
 * Sanity ceiling. A corrupt or misread token count should drop the segment
 * rather than render a confident-looking wrong number — real windows are ≤1M,
 * so 100M is 100× headroom and only nonsense clears it.
 */
const MAX_PLAUSIBLE_TOKENS = 100_000_000;

function contextSegment(meta: RunMeta): string | undefined {
  const { contextTokens, contextWindow } = meta;
  if (
    typeof contextTokens !== 'number' ||
    !Number.isFinite(contextTokens) ||
    contextTokens < 0 ||
    contextTokens > MAX_PLAUSIBLE_TOKENS
  ) {
    return undefined;
  }
  const size = formatTokens(contextTokens);
  // The percentage is additive: a window we can't trust costs the reader the
  // percentage, never the token count.
  if (
    typeof contextWindow === 'number' &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    contextWindow <= MAX_PLAUSIBLE_TOKENS &&
    contextTokens <= contextWindow
  ) {
    return `${size} / ${Math.round((contextTokens / contextWindow) * 100)}%`;
  }
  return size;
}

/**
 * Strip anything that would break out of a single markdown line: control
 * characters and newlines (which would split the footer into extra lines) and
 * lone surrogates (which make the payload unencodable).
 */
function sanitize(value: string, cap: number): string | undefined {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\p{Cs}/gu, '')
    .trim();
  return cleaned ? cleaned.slice(0, cap) : undefined;
}

/**
 * Render the footer text, or `undefined` when no field survived. Callers
 * decide how to attach it (a note element on a card, a trailing line in text).
 */
export function renderFooterMeta(meta: RunMeta | undefined): string | undefined {
  if (!meta) return undefined;
  const segments: string[] = [];
  const context = contextSegment(meta);
  if (context) segments.push(context);
  const model = prettyModel(meta.model);
  if (model) {
    const safe = sanitize(model, MODEL_CAP);
    if (safe) segments.push(safe);
  }
  if (meta.effort) {
    const safe = sanitize(meta.effort, 16);
    if (safe) segments.push(safe);
  }
  const loop = goalSegment(meta);
  if (loop) segments.push(loop);
  if (segments.length === 0) return undefined;
  return `🧠 ${segments.join(' · ')}`;
}

/**
 * `🔁 7/20` while a continuation loop is running this scope. Each round posts
 * its own reply, so this is what tells the reader that a new message is round
 * seven of the same task rather than an answer to something they just asked.
 */
function goalSegment(meta: RunMeta): string | undefined {
  const { goalRound, goalMaxRounds } = meta;
  if (typeof goalRound !== 'number' || !Number.isInteger(goalRound) || goalRound < 1) {
    return undefined;
  }
  if (typeof goalMaxRounds === 'number' && Number.isInteger(goalMaxRounds) && goalMaxRounds >= goalRound) {
    return `🔁 ${goalRound}/${goalMaxRounds}`;
  }
  return `🔁 ${goalRound}`;
}
