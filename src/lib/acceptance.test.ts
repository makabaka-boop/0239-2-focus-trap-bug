/**
 * 题面 0239-2 的自动化验收：不超过 4 节点、2 开关的小图。
 *
 * 四项一致性逐点比较：
 * A. 翻转后“出现”：激活翻转开关，目标只在翻转后可见——后继状态非空，搜索能到达；
 * B. 翻转后“消失”：翻转使目标隐藏——后继为 null（失效边），陷阱结论与 A 相反；
 * C. 需要保留翻转的安全候选：丢掉翻转候选即不安全，预览/确认/重开必须保留翻转；
 * D. 文本往返：应用重定向后 graphToJson → parseGraph 还原同一图，
 *    重开（重新导入）后的最短到达与陷阱与已确认版本一致。
 *
 * 另含回归：纯字符串激活边与 Tab / Shift+Tab 边语义不变。
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_ORDER,
  graphToJson,
  parseGraph,
  type ActionKind,
  type FocusGraph,
} from './model';
import {
  bitsOf,
  isDeadEdge,
  nextState,
  nodeOf,
  shortestToTarget,
  startState,
  stateOf,
  trapPrefix,
} from './search';
import { applyRedirect, previewRedirect } from './redirect';

function make(spec: unknown): FocusGraph {
  const r = parseGraph(spec);
  if (!r.ok) throw new Error(`测试图非法：${r.errors.join('；')}`);
  return r.graph;
}

/** 手工丢掉翻转的改图（模拟修复前 applyRedirect 的行为） */
function applyRedirectDropFlip(
  g: FocusGraph,
  c: { from: number; action: ActionKind; to: number },
): FocusGraph {
  return {
    ...g,
    edges: g.edges.map((ne, i) =>
      i === c.from ? { ...ne, [c.action]: { to: c.to, flip: null } } : ne,
    ),
  };
}

// ---------------------------------------------------------------------------
// A · 翻转后目标“出现”：激活翻转开关后目标才可见
// ---------------------------------------------------------------------------

describe('A · 翻转后出现（激活开关才能进入目标房间）', () => {
  // gate 激活 → vault 并打开 lamp；vault 仅在 lamp 开时可见。
  // 另有一条 gate 的 Tab 指向 vault（不翻转），翻转前 vault 隐藏 → 失效边。
  const g = make({
    nodes: ['gate', 'vault'],
    switches: ['lamp'],
    entry: 'gate',
    target: 'vault',
    conditions: { vault: [['lamp', true]] },
    edges: {
      gate: { tab: 'vault', activate: { to: 'vault', flip: 'lamp' } },
      vault: { shiftTab: 'gate' },
    },
  });

  it('后继状态：不翻转的 Tab 在 lamp 关时失效；翻转的激活落在 (vault, lamp=开)', () => {
    const s0 = startState(g); // gate, lamp=关
    // Tab 不翻转，目标仍隐藏 → null（失效边，不是可达边）
    expect(nextState(g, s0, 'tab')).toBeNull();
    expect(isDeadEdge(g, s0, 'tab')).toBe(true);
    // 激活翻转 lamp，翻转后 vault 可见 → 后继为 (vault, 1)
    const n = nextState(g, s0, 'activate');
    expect(n).not.toBeNull();
    expect(nodeOf(g, n!)).toBe(1);
    expect(bitsOf(g, n!)).toBe(1);
  });

  it('搜索：最短到达为单键激活（旧实现把这条可达边误判为失效边，返回不可达）', () => {
    const w = shortestToTarget(g);
    expect(w).not.toBeNull();
    expect(w!.actions).toEqual(['activate']);
  });

  it('陷阱：全部入口可达状态都能回到/到达目标，无陷阱（旧实现给空前缀）', () => {
    expect(trapPrefix(g)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B · 翻转后目标“消失”：翻转使已可见目标隐藏，结论与 A 相反
// ---------------------------------------------------------------------------

describe('B · 翻转后消失（翻转把目标隐藏，动作失效）', () => {
  // vault 仅在 lamp 关时可见；gate 激活 → vault 并打开 lamp，翻转后 vault 隐藏。
  // gate 的 Tab 指向 vault（不翻转）可直达，激活是失效边。
  const g = make({
    nodes: ['gate', 'vault'],
    switches: ['lamp'],
    entry: 'gate',
    target: 'vault',
    conditions: { vault: [['lamp', false]] },
    edges: {
      gate: { tab: 'vault', activate: { to: 'vault', flip: 'lamp' } },
      vault: { shiftTab: 'gate' },
    },
  });

  it('后继状态：激活翻转后 vault 隐藏 → null（旧实现误按翻转前判断，错误放行）', () => {
    const s0 = startState(g);
    expect(nextState(g, s0, 'activate')).toBeNull();
    expect(isDeadEdge(g, s0, 'activate')).toBe(true);
    // Tab 不翻转，vault 仍可见
    const n = nextState(g, s0, 'tab');
    expect(n).toBe(stateOf(g, 1, 0));
  });

  it('搜索：最短到达是 Tab，而不是被错误放行的激活', () => {
    expect(shortestToTarget(g)!.actions).toEqual(['tab']);
  });

  it('陷阱：无陷阱（旧实现放行激活到隐藏目标后，陷阱结论会颠倒）', () => {
    expect(trapPrefix(g)).toBeNull();
  });

  it('反向位集的语义也成立：lamp 开时激活翻回关，vault 重新可见', () => {
    // (gate, lamp=开) 虽入口不可达，但转移语义确定：翻转后关 → vault 可见
    expect(nextState(g, stateOf(g, 0, 1), 'activate')).toBe(stateOf(g, 1, 0));
  });
});

// ---------------------------------------------------------------------------
// B2 · 翻转后消失导致真陷阱：入口激活跳进开位区域后目标永不可达
// ---------------------------------------------------------------------------

describe('B2 · 翻转后消失与陷阱见证（≤4 节点 / 1 开关）', () => {
  // hall 激活 → cell 并打开 lamp；cell 仅 lamp 开可见，vault（目标）仅 lamp 关可见，
  // 且打开后没有任何边能关上 lamp → (cell, lamp=开) 是死局。
  const g = make({
    nodes: ['gate', 'hall', 'vault', 'cell'],
    switches: ['lamp'],
    entry: 'gate',
    target: 'vault',
    conditions: { vault: [['lamp', false]], cell: [['lamp', true]] },
    edges: {
      gate: { tab: 'hall' },
      hall: { tab: 'vault', activate: { to: 'cell', flip: 'lamp' } },
      cell: { tab: 'hall' },
    },
  });

  it('后继逐项：hall 激活翻转后 cell 出现，动作可走，落在 (cell, 开)', () => {
    const hall = stateOf(g, 1, 0);
    const n = nextState(g, hall, 'activate');
    expect(n).toBe(stateOf(g, 3, 1));
  });

  it('最短到达仍为 Tab,Tab（无需开开关）', () => {
    expect(shortestToTarget(g)!.actions).toEqual(['tab', 'tab']);
  });

  it('最短陷阱前缀为 Tab,激活（旧实现在翻转可见性上判断错误时结论会颠倒）', () => {
    const t = trapPrefix(g);
    expect(t).not.toBeNull();
    expect(t!.actions).toEqual(['tab', 'activate']);
    const end = t!.states[t!.states.length - 1];
    expect(nodeOf(g, end)).toBe(3);
    expect(bitsOf(g, end)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C · 安全候选必须保留翻转（3 节点 / 1 开关）
// ---------------------------------------------------------------------------

describe('C · 带翻转激活边的安全候选必须保留翻转', () => {
  // N1（目标）仅 s 开可见，N2 仅 s 关可见。
  // 原图 N0 的激活是 N0→N2 并翻转 s：s 关时翻转后 s 开、N2 隐藏 → 失效，
  // 而 N0 的 Tab 指向 N1 在 s 关时也隐藏 → 目标不可达，入口本身即陷阱。
  // 最小安全候选：把 N0 的激活重定向到 N0（自环，仍翻转 s），先开 s 再 Tab 到 N1。
  const spec = {
    nodes: ['N0', 'N1', 'N2'],
    switches: ['s'],
    entry: 'N0',
    target: 'N1',
    conditions: { N1: [['s', true]], N2: [['s', false]] },
    edges: {
      N0: { tab: 'N1', activate: { to: 'N2', flip: 's' } },
      N1: { tab: 'N2', shiftTab: 'N2', activate: { to: 'N0', flip: 's' } },
      N2: { shiftTab: 'N0' },
    },
  };
  const g = make(spec);
  const candidate = { from: 0, action: 'activate' as ActionKind, to: 0 };

  it('原图：目标不可达且空前缀即陷阱', () => {
    expect(shortestToTarget(g)).toBeNull();
    expect(trapPrefix(g)!.actions).toEqual([]);
  });

  it('预览选出该候选，after 为 激活,Tab，before 为 null', () => {
    const p = previewRedirect(g);
    expect(p.status).toBe('FOUND');
    if (p.status !== 'FOUND') return;
    expect(p.candidate).toEqual(candidate);
    expect(p.before).toBeNull();
    expect(p.after.actions).toEqual(['activate', 'tab']);
    expect(p.eliminatedTrap.actions).toEqual([]);
  });

  it('保留翻转（修复后 applyRedirect）：候选安全，陷阱消除', () => {
    const g2 = applyRedirect(g, candidate);
    expect(g2.edges[0].activate).toEqual({ to: 0, flip: 0 });
    expect(trapPrefix(g2)).toBeNull();
    expect(shortestToTarget(g2)!.actions).toEqual(['activate', 'tab']);
    // after 见证能在确认后的图上逐键重放
    const w = shortestToTarget(g2)!;
    let cur = startState(g2);
    w.actions.forEach((a, i) => {
      cur = nextState(g2, cur, a)!;
      expect(cur).toBe(w.states[i + 1]);
    });
    expect(nodeOf(g2, cur)).toBe(g2.target);
  });

  it('丢掉翻转（修复前行为）：候选并不安全，仍困在空陷阱——预览与确认必须基于同一迁移', () => {
    const gBad = applyRedirectDropFlip(g, candidate);
    expect(gBad.edges[0].activate).toEqual({ to: 0, flip: null });
    expect(trapPrefix(gBad)).not.toBeNull();
    expect(trapPrefix(gBad)!.actions).toEqual([]);
    expect(shortestToTarget(gBad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C2 · 2 开关下的保留翻转安全候选（2 节点 / 2 开关）
// ---------------------------------------------------------------------------

describe('C2 · 2 开关下保留翻转才安全', () => {
  // N1（目标）仅 s1 开可见；N0 的激活原为自环并翻转 s1。
  // 重定向激活目标 N0→N1（保留翻转 s1）后一键到达；丢掉翻转则 N1 永不出现。
  const spec = {
    nodes: ['N0', 'N1'],
    switches: ['s0', 's1'],
    entry: 'N0',
    target: 'N1',
    conditions: { N0: [['s1', false]], N1: [['s1', true]] },
    edges: {
      N0: { tab: 'N0', shiftTab: 'N0', activate: { to: 'N0', flip: 's1' } },
      N1: { tab: 'N0' },
    },
  };
  const g = make(spec);
  const candidate = { from: 0, action: 'activate' as ActionKind, to: 1 };

  it('原图不可达、空陷阱；预览候选的 after 为单键激活', () => {
    expect(shortestToTarget(g)).toBeNull();
    expect(trapPrefix(g)!.actions).toEqual([]);
    const p = previewRedirect(g);
    expect(p.status).toBe('FOUND');
    if (p.status !== 'FOUND') return;
    expect(p.candidate).toEqual(candidate);
    expect(p.after.actions).toEqual(['activate']);
  });

  it('保留翻转安全；丢掉翻转仍为空陷阱', () => {
    expect(trapPrefix(applyRedirect(g, candidate))).toBeNull();
    expect(
      shortestToTarget(applyRedirect(g, candidate))!.actions,
    ).toEqual(['activate']);
    const bad = applyRedirectDropFlip(g, candidate);
    expect(trapPrefix(bad)!.actions).toEqual([]);
    expect(shortestToTarget(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D · 文本往返：确认 → graphToJson → 重新导入，结论与已确认版本一致
// ---------------------------------------------------------------------------

describe('D · 确认后文本往返与重开一致性', () => {
  const spec = {
    nodes: ['N0', 'N1', 'N2'],
    switches: ['s'],
    entry: 'N0',
    target: 'N1',
    conditions: { N1: [['s', true]], N2: [['s', false]] },
    edges: {
      N0: { tab: 'N1', activate: { to: 'N2', flip: 's' } },
      N1: { activate: { to: 'N0', flip: 's' } },
      N2: { shiftTab: 'N0' },
    },
  };

  it('带翻转激活边序列化保留 flip（旧实现输出缺失 flip）', () => {
    const g = make(spec);
    const text = graphToJson(g);
    expect(text).toContain('"flip": "s"');
    const reopened = make(text);
    expect(reopened.edges[0].activate).toEqual({ to: 2, flip: 0 });
  });

  it('应用重定向后导出再重开：图、最短到达、陷阱与确认版本逐项一致', () => {
    const g = make(spec);
    const candidate = { from: 0, action: 'activate' as ActionKind, to: 0 };
    const confirmed = applyRedirect(g, candidate);

    // 已确认版本的结论
    const w = shortestToTarget(confirmed)!.actions;
    const t = trapPrefix(confirmed);

    // 模拟 UI：确认后用 graphToJson 同步导入框，再重新导入“重开”
    const text = graphToJson(confirmed);
    const parse = parseGraph(text);
    expect(parse.ok).toBe(true);
    if (!parse.ok) return;
    const reopened = parse.graph;

    // 图结构完全一致（含翻转下标）
    expect(reopened).toEqual(confirmed);
    // 重开的到达路径与已确认版本相同
    expect(shortestToTarget(reopened)!.actions).toEqual(w);
    expect(shortestToTarget(reopened)!.actions).toEqual(['activate', 'tab']);
    // 重开的陷阱结论与已确认版本相同（均无陷阱）
    expect(trapPrefix(reopened)).toBeNull();
    expect(t).toBeNull();
    // 重开后再次预览直接 ALREADY_SAFE，与确认版本一致
    expect(previewRedirect(reopened).status).toBe('ALREADY_SAFE');
    expect(previewRedirect(confirmed).status).toBe('ALREADY_SAFE');
  });

  it('修复前的缺失 flip 文本会让重开结论不同（对照：缺失 flip 的 JSON）', () => {
    const g = make(spec);
    const candidate = { from: 0, action: 'activate' as ActionKind, to: 0 };
    const confirmed = applyRedirect(g, candidate);
    const text = graphToJson(confirmed);
    // 手工删除 flip（模拟旧 graphToJson 的输出）
    const brokenText = text.replace(/,\s*"flip": "s"/g, '');
    expect(brokenText).not.toContain('"flip"');
    const broken = make(brokenText);
    // 翻转丢失：重开图回到空陷阱，与已确认版本矛盾
    expect(trapPrefix(broken)!.actions).toEqual([]);
    expect(shortestToTarget(broken)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 回归 · 纯字符串激活边与 Tab / Shift+Tab 语义不变
// ---------------------------------------------------------------------------

describe('回归 · 纯字符串激活边与 Tab / Shift+Tab 语义', () => {
  const g = make({
    nodes: ['A', 'B', 'C'],
    switches: ['s'],
    entry: 'A',
    target: 'C',
    conditions: { B: [['s', false]] },
    edges: {
      A: { tab: 'B', shiftTab: 'C', activate: 'B' }, // 纯字符串激活，无翻转
      B: { shiftTab: 'A', activate: 'C' },
      C: { tab: 'A' },
    },
  });

  it('纯字符串激活：flip 为 null，后继开关位不变', () => {
    expect(g.edges[0].activate).toEqual({ to: 1, flip: null });
    const s0 = startState(g);
    expect(nextState(g, s0, 'activate')).toBe(stateOf(g, 1, 0));
  });

  it('Tab / Shift+Tab 永不翻转，可见性按原位集检查', () => {
    const s0 = startState(g);
    expect(nextState(g, s0, 'tab')).toBe(stateOf(g, 1, 0));
    expect(nextState(g, s0, 'shiftTab')).toBe(stateOf(g, 2, 0));
    // B 在 s 开时隐藏：tab 边（无翻转）失效
    expect(nextState(g, stateOf(g, 0, 1), 'tab')).toBeNull();
    expect(isDeadEdge(g, stateOf(g, 0, 1), 'tab')).toBe(true);
  });

  it('最短到达裁决仍为单键 Tab 优先级路径：Shift+Tab 直达 C', () => {
    // A 的三条边：tab→B、shiftTab→C、activate→B；最短 1 键，Tab 先但到 B，
    // 同长度裁决取 Tab——tab 到的是 B 不是目标；shiftTab 才直达目标。
    expect(shortestToTarget(g)!.actions).toEqual(['shiftTab']);
  });

  it('纯字符串激活边往返仍输出字符串而非对象', () => {
    const text = graphToJson(g);
    const parsed = JSON.parse(text);
    expect(parsed.edges.A.activate).toBe('B');
    expect(parseGraph(text).ok).toBe(true);
  });
});
