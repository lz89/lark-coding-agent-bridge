import { maskEmails } from './mask-email';
import { renderFooterMeta } from './run-footer';
import type { Block, RunState, StallNotice, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';
import { quoteUserInput } from './user-input';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];

  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'stall_timeout') {
    parts.push(`_⏱ ${stallText(state.stalled)},已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running') {
    if (state.stalled) parts.push(`_⏳ ${stallText(state.stalled)}_`);
    if (state.footer) parts.push(footerLine(state.footer));
  }

  if (state.terminal !== 'running') {
    const footer = renderFooterMeta(state.meta);
    if (footer) parts.push(`---\n${footer}`);
  }

  // Strip raw emails so the Feishu tenant audit doesn't reject the message
  // (see mask-email.ts). Never removes content, so emptiness checks upstream
  // still behave.
  return maskEmails(parts.join('\n\n'));
}

/** Mirrors `run-renderer`'s stall wording so both reply modes read alike. */
function stallText(stalled: StallNotice | undefined): string {
  const mins = stalled?.minutes ?? 0;
  return stalled?.tool ? `工具 ${stalled.tool} 已 ${mins} 分钟无输出` : `已 ${mins} 分钟无输出`;
}

function renderBlock(block: Block): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  if (block.kind === 'user') {
    return quoteUserInput(block.content.trim());
  }
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}

/**
 * Does this state have anything to say beyond the run footer?
 *
 * The footer is a decoration appended to every terminal state, so it makes
 * `renderText` non-empty even when the agent produced nothing. Emptiness
 * checks — "skip the reply", "recall the empty card" — must ignore it, or a
 * turn with no answer goes out as a message containing only `🧠 …`.
 */
export function hasDeliverableContent(state: RunState): boolean {
  return renderText(withoutUserInput({ ...state, meta: undefined })).trim() !== '';
}

/**
 * The state with the user's own mid-run messages removed.
 *
 * They are rendered so the reply reads in order, but they are not the agent
 * answering: a turn that took in a correction and then said nothing has still
 * said nothing, and must be treated that way by every emptiness check and by
 * `/goal`'s "did the agent produce anything" test.
 */
export function withoutUserInput(state: RunState): RunState {
  if (!state.blocks.some((b) => b.kind === 'user')) return state;
  return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'user') };
}
