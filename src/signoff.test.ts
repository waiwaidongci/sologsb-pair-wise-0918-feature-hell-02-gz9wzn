import { describe, expect, it } from "vitest";
import {
  HE_TOLERANCE,
  O2_TOLERANCE,
  deviation,
  isExpired,
  selectQueue,
  selectReviewCount,
  selectReviews,
  selectTankHistory,
  submitFill,
} from "./signoff";
import type { FillDraft, FillGroup, FillState, TankSpec } from "./signoff";

const TODAY = new Date(2026, 8, 17); // 2026-09-17

const tank = (id: string, inspectionDue = "2027-01-01"): TankSpec => ({
  id,
  volume: "12L钢瓶",
  inspectionDue,
});

const groupOf = (id: string, ...tanks: TankSpec[]): FillGroup => ({
  id,
  label: tanks.map((t) => t.id).join(" + "),
  tanks,
});

const draftOf = (groupId: string, over: Partial<FillDraft> = {}): FillDraft => ({
  groupId,
  gasType: "nitrox",
  targetO2: 32,
  targetHe: null,
  residualPressure: 55,
  targetPressure: 200,
  operator: "阿海",
  measurements: [],
  ...over,
});

const emptyState = (groups: FillGroup[]): FillState => ({ groups, submissions: [] });

describe("单瓶氧含量核对（空气 / 高氧 / Trimix 同一规则）", () => {
  it.each([
    ["空气", "air", 20.9],
    ["高氧", "nitrox", 32],
    ["Trimix", "trimix", 18],
  ] as const)("%s：氧偏差恰好 1 个百分点仍签收，超过即待复核", (_label, gasType, targetO2) => {
    const g = groupOf("G-1", tank("T-1"));
    const trimix = gasType === "trimix";
    const buildDraft = (measuredO2: number): FillDraft =>
      draftOf("G-1", {
        gasType,
        targetO2,
        ...(trimix ? { targetHe: 45 } : {}),
        measurements: [
          { tankId: "T-1", measuredO2, measuredHe: trimix ? 45 : null },
        ],
      });

    const atLimit = submitFill(
      emptyState([g]),
      buildDraft(targetO2 + O2_TOLERANCE),
      TODAY
    );
    expect(atLimit.kind).toBe("accepted");
    if (atLimit.kind !== "accepted") return;
    expect(atLimit.submission.results[0].status).toBe("signed");
    expect(atLimit.submission.results[0].o2Deviation).toBe(1);

    const over = submitFill(
      emptyState([g]),
      buildDraft(targetO2 + O2_TOLERANCE + 0.1),
      TODAY
    );
    expect(over.kind).toBe("accepted");
    if (over.kind !== "accepted") return;
    const result = over.submission.results[0];
    expect(result.status).toBe("review");
    expect(result.o2Deviation).toBe(1.1);
    // 保留实测值
    expect(result.measuredO2).toBe(targetO2 + 1.1);
    expect(result.reasons.join()).toContain("氧含量偏差 1.1 个百分点");
  });

  it("浮点安全：32.1 对 31 的偏差按 1.1 判定", () => {
    expect(deviation(32.1, 31)).toBe(1.1);
    expect(deviation(20.9, 21.9)).toBe(1);
  });
});

describe("Trimix 氦含量核对", () => {
  const g = groupOf("G-He", tank("T-He"));
  const base = draftOf("G-He", {
    gasType: "trimix",
    targetO2: 18,
    targetHe: 45,
  });

  it("氦偏差恰好 2 个百分点仍签收", () => {
    const out = submitFill(
      emptyState([g]),
      { ...base, measurements: [{ tankId: "T-He", measuredO2: 18, measuredHe: 45 + HE_TOLERANCE }] },
      TODAY
    );
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    expect(out.submission.results[0].status).toBe("signed");
    expect(out.submission.results[0].heDeviation).toBe(2);
  });

  it("氦偏差超过 2 个百分点不能签收，进入待复核并保留实测", () => {
    const out = submitFill(
      emptyState([g]),
      { ...base, measurements: [{ tankId: "T-He", measuredO2: 18, measuredHe: 47.1 }] },
      TODAY
    );
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    const r = out.submission.results[0];
    expect(r.status).toBe("review");
    expect(r.heDeviation).toBe(2.1);
    expect(r.measuredHe).toBe(47.1);
    expect(r.reasons.join()).toContain("氦含量偏差 2.1 个百分点");
  });

  it("氧、氦同时超差时两条原因都记录", () => {
    const out = submitFill(
      emptyState([g]),
      { ...base, measurements: [{ tankId: "T-He", measuredO2: 19.5, measuredHe: 48 }] },
      TODAY
    );
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    const r = out.submission.results[0];
    expect(r.status).toBe("review");
    expect(r.reasons.join()).toContain("氧含量偏差 1.5 个百分点");
    expect(r.reasons.join()).toContain("氦含量偏差 3 个百分点");
  });
});

describe("双瓶组放行规则", () => {
  const pair = groupOf("G-P", tank("T-A"), tank("T-B"));

  it("按最差单瓶状态放行：一瓶合格一瓶待复核 → 全组待复核", () => {
    const out = submitFill(
      emptyState([pair]),
      draftOf("G-P", {
        measurements: [
          { tankId: "T-A", measuredO2: 32, measuredHe: null },
          { tankId: "T-B", measuredO2: 33.5, measuredHe: null },
        ],
      }),
      TODAY
    );
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    expect(out.submission.results[0].status).toBe("signed");
    expect(out.submission.results[1].status).toBe("review");
    expect(out.submission.status).toBe("review");
  });

  it("任一瓶检验过期 → 全组不可签收，即使另一瓶合格", () => {
    const expiredPair = groupOf(
      "G-X",
      tank("T-OK", "2027-01-01"),
      tank("T-EXP", "2026-09-01")
    );
    const out = submitFill(
      emptyState([expiredPair]),
      draftOf("G-X", {
        measurements: [
          { tankId: "T-OK", measuredO2: 32, measuredHe: null },
          { tankId: "T-EXP", measuredO2: 32, measuredHe: null },
        ],
      }),
      TODAY
    );
    expect(out.kind).toBe("accepted");
    if (out.kind !== "accepted") return;
    expect(out.submission.results[0].status).toBe("signed");
    expect(out.submission.results[1].status).toBe("rejected");
    expect(out.submission.results[1].reasons.join()).toContain("不可签收");
    expect(out.submission.status).toBe("rejected");
    // 过期瓶不计入待复核
    expect(selectReviews(out.state)).toHaveLength(0);
  });
});

describe("检验有效期边界", () => {
  it("有效期当天仍有效，次日零时起过期", () => {
    const t = tank("T-D", "2026-09-17");
    expect(isExpired(t, TODAY)).toBe(false);
    expect(isExpired(tank("T-D", "2026-09-16"), TODAY)).toBe(true);
  });
});

describe("重复提交与派生视图一致性", () => {
  const groups = [
    groupOf("G-1", tank("T-1")),
    groupOf("G-2", tank("T-2"), tank("T-3")),
  ];
  const firstDraft = draftOf("G-1", {
    measurements: [{ tankId: "T-1", measuredO2: 33.5, measuredHe: null }],
  });

  it("同一任务重复提交只保留首次结果", () => {
    const first = submitFill(emptyState(groups), firstDraft, TODAY);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;

    const again = submitFill(
      first.state,
      draftOf("G-1", {
        operator: "别人",
        measurements: [{ tankId: "T-1", measuredO2: 32, measuredHe: null }],
      }),
      TODAY
    );
    expect(again.kind).toBe("duplicate");
    expect(again.state).toBe(first.state); // 状态原样返回
    if (again.kind !== "duplicate") return;
    expect(again.kept.id).toBe(first.submission.id);
    expect(again.kept.operator).toBe("阿海");
    expect(again.kept.results[0].measuredO2).toBe(33.5); // 保留首次实测
    expect(again.state.submissions).toHaveLength(1);
  });

  it("队列、复核数、单瓶历史在重复提交后保持一致", () => {
    let state = emptyState(groups);

    const first = submitFill(state, firstDraft, TODAY);
    if (first.kind !== "accepted") throw new Error("should accept");
    state = first.state;

    // 重复提交被忽略
    const dup = submitFill(
      state,
      draftOf("G-1", {
        measurements: [{ tankId: "T-1", measuredO2: 32, measuredHe: null }],
      }),
      TODAY
    );
    expect(dup.kind).toBe("duplicate");
    state = dup.state;

    // 队列：G-1 已提交，只剩 G-2
    expect(selectQueue(state).map((g) => g.id)).toEqual(["G-2"]);
    // 复核数 = 待复核列表长度 = 1（T-1 氧偏差 1.5）
    expect(selectReviews(state)).toHaveLength(1);
    expect(selectReviewCount(state)).toBe(selectReviews(state).length);
    // 单瓶历史：T-1 恰有一条（首次），未被重复提交污染
    const history = selectTankHistory(state, "T-1");
    expect(history).toHaveLength(1);
    expect(history[0].result.measuredO2).toBe(33.5);
    expect(history[0].submission.id).toBe("SUB-0001");
    // 未提交的瓶没有历史
    expect(selectTankHistory(state, "T-2")).toHaveLength(0);
  });

  it("双瓶组历史按瓶分别入账", () => {
    const out = submitFill(
      emptyState(groups),
      draftOf("G-2", {
        measurements: [
          { tankId: "T-2", measuredO2: 32, measuredHe: null },
          { tankId: "T-3", measuredO2: 32.5, measuredHe: null },
        ],
      }),
      TODAY
    );
    if (out.kind !== "accepted") throw new Error("should accept");
    expect(selectTankHistory(out.state, "T-2")).toHaveLength(1);
    expect(selectTankHistory(out.state, "T-3")).toHaveLength(1);
    expect(selectQueue(out.state).map((g) => g.id)).toEqual(["G-1"]);
  });
});
