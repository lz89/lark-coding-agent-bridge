import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GoalController,
  goalSignalPath,
  goalStopText,
  prepareGoalSignal,
  readGoalSignal,
  type GoalState,
} from '../../../src/bot/goal.js';

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

let dir: string;
let controller: GoalController;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'goal-test-'));
  controller = new GoalController(join(dir, 'goals.json'));
});

afterEach(async () => {
  await controller.flush();
  await rm(dir, { recursive: true, force: true });
});

function start(overrides: Partial<Parameters<GoalController['start']>[0]> = {}): GoalState {
  return controller.start({
    scope: 'oc_1',
    goal: '部署并跑出基线数字',
    chatId: 'oc_1',
    maxRounds: 5,
    maxHours: 4,
    now: T0,
    ...overrides,
  });
}

describe('GoalController', () => {
  it('runs another round when the agent asks for one', () => {
    start();
    const advance = controller.advance('oc_1', '等 make 收尾', T0 + 60_000);
    expect(advance).toEqual({ ok: true, state: expect.objectContaining({ round: 1 }) });
    expect(controller.get('oc_1')?.lastReason).toBe('等 make 收尾');
  });

  it('stops at the round ceiling', () => {
    start({ maxRounds: 2 });
    expect(controller.advance('oc_1', 'a', T0)).toMatchObject({ ok: true });
    expect(controller.advance('oc_1', 'b', T0)).toMatchObject({ ok: false, stop: 'max-rounds' });
    // And the loop is gone, so a late signal can't revive it.
    expect(controller.get('oc_1')).toBeUndefined();
    expect(controller.advance('oc_1', 'c', T0)).toBeUndefined();
  });

  it('stops once the deadline passes', () => {
    start({ maxHours: 2 });
    expect(controller.advance('oc_1', 'a', T0 + HOUR)).toMatchObject({ ok: true });
    expect(controller.advance('oc_1', 'b', T0 + 2 * HOUR + 1)).toMatchObject({
      ok: false,
      stop: 'deadline',
    });
  });

  it('stops an agent that keeps repeating the same blocker', () => {
    // Distinct from making slow progress: three rounds that all say the same
    // thing are three rounds that produced nothing new to say.
    start();
    expect(controller.advance('oc_1', '在等编译', T0)).toMatchObject({ ok: true });
    expect(controller.advance('oc_1', '在等编译', T0)).toMatchObject({ ok: true });
    expect(controller.advance('oc_1', '在等编译', T0)).toMatchObject({ ok: false, stop: 'stuck' });
  });

  it('treats a changed reason as progress', () => {
    start();
    controller.advance('oc_1', '在等编译', T0);
    controller.advance('oc_1', '在等编译', T0);
    expect(controller.advance('oc_1', '编译完了,开始换二进制', T0)).toMatchObject({ ok: true });
    // The streak resets, so the next repeat starts counting from scratch.
    expect(controller.advance('oc_1', '换完了,重启链路', T0)).toMatchObject({ ok: true });
  });

  it('clamps absurd limits instead of trusting them', () => {
    const state = start({ maxRounds: 10_000, maxHours: 10_000 });
    expect(state.maxRounds).toBe(200);
    expect(state.deadlineAt - state.startedAt).toBe(72 * HOUR);
  });

  it('survives a restart as an interrupted loop the user can resume', async () => {
    start();
    controller.advance('oc_1', '等 make 收尾', T0);
    await controller.flush();

    const reloaded = new GoalController(join(dir, 'goals.json'));
    await reloaded.load();
    // Still active on disk — nothing has told it the process died yet.
    expect(reloaded.get('oc_1')?.round).toBe(1);

    const cut = reloaded.markInterrupted();
    expect(cut).toHaveLength(1);
    // Not active any more: a restart must never silently fire agent runs.
    expect(reloaded.get('oc_1')).toBeUndefined();
    expect(reloaded.getAny('oc_1')?.status).toBe('interrupted');

    const resumed = reloaded.resume('oc_1', T0 + HOUR, 4);
    expect(resumed).toMatchObject({ round: 1, goal: '部署并跑出基线数字', status: 'active' });
    expect(reloaded.get('oc_1')).toBeDefined();
    await reloaded.flush();
  });

  it('only resumes a loop that was actually interrupted', () => {
    start();
    expect(controller.resume('oc_1', T0, 4)).toBeUndefined();
    expect(controller.resume('unknown-scope', T0, 4)).toBeUndefined();
  });

  it('keeps goals in different scopes independent', () => {
    start({ scope: 'oc_1' });
    start({ scope: 'oc_2:th_1', goal: '另一个目标' });
    controller.end('oc_1', 'cancelled');
    expect(controller.get('oc_1')).toBeUndefined();
    expect(controller.get('oc_2:th_1')?.goal).toBe('另一个目标');
  });

  it('persists to disk with owner-only permissions', async () => {
    start();
    await controller.flush();
    const text = await readFile(join(dir, 'goals.json'), 'utf8');
    expect(JSON.parse(text).entries.oc_1.goal).toBe('部署并跑出基线数字');
  });
});

describe('loop signal file', () => {
  it('reads the reason once and then forgets it', async () => {
    const path = goalSignalPath('oc_1', 1);
    await prepareGoalSignal(path);
    await writeFile(path, '  等 make 收尾\n');
    expect(await readGoalSignal(path)).toBe('等 make 收尾');
    // Consumed: a second read must not extend the loop again.
    expect(await readGoalSignal(path)).toBeUndefined();
  });

  it('reports no signal when the agent wrote nothing', async () => {
    const path = goalSignalPath('oc_1', 2);
    await prepareGoalSignal(path);
    expect(await readGoalSignal(path)).toBeUndefined();
  });

  it('treats an empty write as "done", not as a reason to continue', async () => {
    const path = goalSignalPath('oc_1', 3);
    await prepareGoalSignal(path);
    await writeFile(path, '   \n\n');
    expect(await readGoalSignal(path)).toBeUndefined();
  });

  it('gives every round its own path so a stale file cannot re-trigger', async () => {
    const first = goalSignalPath('oc_1', 1);
    expect(goalSignalPath('oc_1', 2)).not.toBe(first);
    expect(goalSignalPath('oc_2', 1)).not.toBe(first);
    // Topic scopes carry a `:` that must not reach the filesystem.
    expect(goalSignalPath('oc_1:th_9', 1)).not.toContain(':');
  });

  it('clears a leftover file before the round starts', async () => {
    const path = goalSignalPath('oc_1', 4);
    await prepareGoalSignal(path);
    await writeFile(path, 'stale');
    await prepareGoalSignal(path);
    expect(await readGoalSignal(path)).toBeUndefined();
  });
});

describe('goalStopText', () => {
  const state: GoalState = {
    scope: 'oc_1',
    goal: 'g',
    round: 7,
    startedAt: T0,
    deadlineAt: T0 + HOUR,
    maxRounds: 20,
    chatId: 'oc_1',
    lastReason: '在等编译',
    sameReasonStreak: 2,
    status: 'active',
  };

  it('says why it stopped, and whether the goal was reached', () => {
    expect(goalStopText('done', state)).toContain('目标已达成');
    expect(goalStopText('max-rounds', state)).toContain('20');
    expect(goalStopText('max-rounds', state)).toContain('目标未确认完成');
    expect(goalStopText('deadline', state)).toContain('时间上限');
    expect(goalStopText('stuck', state)).toContain('在等编译');
    expect(goalStopText('cancelled', state)).toContain('取消');
  });

  it('always reports how many rounds were spent', () => {
    for (const stop of ['done', 'cancelled', 'max-rounds', 'deadline', 'stuck'] as const) {
      expect(goalStopText(stop, state)).toContain('共 7 轮');
    }
  });
});
