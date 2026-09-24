import type { AgentKind } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
}

/**
 * Aliases Claude Code resolves itself to the newest model of that family
 * (`claude --model opus` → whatever Opus is current). Storing one of these in
 * `preferences.model` tracks new releases with no bridge change at all.
 */
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  fable: 'Fable（跟随最新）',
  opus: 'Opus（跟随最新）',
  sonnet: 'Sonnet（跟随最新）',
  haiku: 'Haiku（跟随最新）',
  opusplan: 'Opus Plan',
};

/**
 * Shape of a concrete Claude model id: `claude-<family>-<version…>`, optionally
 * with Claude Code's `[1m]` long-context suffix. Deliberately loose — the CLI
 * / API validates existence at run time and the run surfaces the error — but
 * strict enough that a typo like `claude-opus 5` or shell junk never reaches
 * `--model`.
 */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)+(?:\[1m\])?$/i;

/**
 * True when `value` is something Claude Code's `--model` accepts by shape: a
 * family alias or a concrete `claude-…` id. Catalog membership is not
 * required — that is what lets a model shipped after this file was written be
 * used by editing config alone.
 */
export function isClaudeModelId(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  return Object.hasOwn(CLAUDE_MODEL_ALIASES, v.toLowerCase()) || CLAUDE_MODEL_ID.test(v);
}

/**
 * Human name derived from a model id alone, so the footer and the picker can
 * name a model that is not in the catalog: `claude-opus-5-5` → `Opus 5.5`,
 * `claude-fable-5-1[1m]` → `Fable 5.1 [1M]`, `claude-haiku-4-5-20251001` →
 * `Haiku 4.5` (date-stamp segments are dropped), `opus` → `Opus（跟随最新）`.
 * Non-Claude ids (Codex models, unexpected strings) come back unchanged.
 */
export function formatModelName(id: string): string {
  const trimmed = id.trim();
  const alias = CLAUDE_MODEL_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  // Only Claude ids have a shape we can name from; anything else (a Codex
  // model, an unexpected string) is shown verbatim rather than guessed at.
  if (!/^claude-/i.test(trimmed)) return trimmed;
  const longContext = /\[1m\]$/i.test(trimmed);
  const bare = (longContext ? trimmed.slice(0, -4) : trimmed).replace(/^claude-/i, '');
  const segments = bare.split('-').filter(Boolean);
  if (segments.length === 0) return trimmed;
  const [family, ...rest] = segments;
  const version: string[] = [];
  const extra: string[] = [];
  for (const seg of rest) {
    if (/^\d{8}$/.test(seg)) continue; // release date stamp
    if (/^\d+$/.test(seg) && extra.length === 0) version.push(seg);
    else extra.push(seg[0]!.toUpperCase() + seg.slice(1));
  }
  const name = [family![0]!.toUpperCase() + family!.slice(1), ...extra, version.join('.')]
    .filter(Boolean)
    .join(' ');
  return longContext ? `${name} [1M]` : name;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-fable-5', label: 'Fable 5（最强）' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5（最新）' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/**
 * Sentinel meaning "don't pass `--effort`; let the CLI / model decide".
 * Same rationale as {@link DEFAULT_MODEL} — Feishu's `select_static` rejects
 * an empty `initial_option`.
 */
export const DEFAULT_EFFORT = 'default';

/**
 * Reasoning effort levels accepted by `claude --effort`. Higher levels think
 * longer and spend more tokens; `xhigh` is the recommended setting for coding
 * and agentic work, which is what runs through this bridge.
 *
 * Claude Code only — the Codex CLI has no equivalent flag, so the picker is
 * hidden and the value is never forwarded for codex profiles.
 */
const CLAUDE_EFFORTS: ModelOption[] = [
  { value: DEFAULT_EFFORT, label: '跟随默认（不指定）' },
  { value: 'low', label: 'low（最快最省）' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh（编码/agent 推荐）' },
  { value: 'max', label: 'max（最深，最慢最贵）' },
];

/** Effort picker options; empty for agents with no effort flag. */
export function supportedEfforts(agentKind: AgentKind): ModelOption[] {
  return agentKind === 'codex' ? [] : CLAUDE_EFFORTS;
}

/** True when the selection means "use the agent default" (no `--effort`). */
export function isDefaultEffort(value: string | undefined): boolean {
  return !value || value === DEFAULT_EFFORT;
}

/**
 * Resolve the effort string to hand the agent, or `undefined` to omit the
 * flag. Unknown values fall back to the default rather than being forwarded —
 * `claude` rejects an unrecognised level outright, which would fail the run.
 */
export function resolveEffortArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  if (isDefaultEffort(value)) return undefined;
  return supportedEfforts(agentKind).some((e) => e.value === value)
    ? (value as string)
    : undefined;
}

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into the value the bridge will actually use.
 * Catalog entries and (for Claude profiles) any well-formed model id / alias
 * are kept verbatim; malformed or cross-agent values (e.g. a Codex model left
 * over after switching a profile to Claude) fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  const v = (value as string).trim();
  if (supportedModels(agentKind).some((m) => m.value === v)) return v;
  // Claude ids are forwarded by shape, not by catalog membership, so a model
  // newer than this file needs no code change — just the id in config.
  if (agentKind === 'claude' && isClaudeModelId(v)) return v;
  return DEFAULT_MODEL;
}

/**
 * True when `value` would be stored as itself by {@link normalizeModelSelection}
 * — the check a picker / form submit uses to accept a selection.
 */
export function isSelectableModel(agentKind: AgentKind, value: string): boolean {
  return normalizeModelSelection(agentKind, value) === value.trim();
}

/**
 * Picker options for a profile: the catalog, plus the currently stored model
 * when it is a pass-through id outside the catalog. Feishu's `select_static`
 * requires `initial_option` to be one of the options, so the current value
 * must always be present.
 */
export function modelOptions(agentKind: AgentKind, current: string | undefined): ModelOption[] {
  const catalog = supportedModels(agentKind);
  const selected = normalizeModelSelection(agentKind, current);
  if (catalog.some((m) => m.value === selected)) return catalog;
  return [...catalog, { value: selected, label: `${formatModelName(selected)}（自定义）` }];
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return (
    supportedModels(agentKind).find((m) => m.value === normalized)?.label ??
    formatModelName(normalized)
  );
}
