/**
 * 潜水店充填台 · 混气签收核心逻辑
 *
 * 规则：
 * 1. 空气 / 高氧 / Trimix 均按目标氧含量核对，|实测氧 − 目标氧| > 1 个百分点
 *    → 保留实测值，进入待复核，不能签收。
 * 2. Trimix 额外核对氦含量，|实测氦 − 目标氦| > 2 个百分点 → 同样不能签收（待复核）。
 * 3. 双瓶组按最差单瓶状态放行；任一瓶检验过期 → 全组不可签收。
 * 4. 重复提交只保留首次结果；队列、复核数、单瓶历史均由同一份提交记录派生，保证一致。
 */

export type GasType = "air" | "nitrox" | "trimix";

export const GAS_LABELS: Record<GasType, string> = {
  air: "空气",
  nitrox: "高氧",
  trimix: "Trimix",
};

/** 各气体的默认目标配比（%） */
export const GAS_DEFAULTS: Record<GasType, { o2: number; he: number | null }> = {
  air: { o2: 20.9, he: null },
  nitrox: { o2: 32, he: null },
  trimix: { o2: 18, he: 45 },
};

/** 允差（百分点）：偏差“超过”该值才判定不通过，等于仍放行 */
export const O2_TOLERANCE = 1;
export const HE_TOLERANCE = 2;

/** signed=已签收 review=待复核 rejected=不可签收（检验过期） */
export type SignoffStatus = "signed" | "review" | "rejected";

export const STATUS_LABELS: Record<SignoffStatus, string> = {
  signed: "已签收",
  review: "待复核",
  rejected: "不可签收",
};

/** 状态严重度：双瓶组取最差单瓶 */
const STATUS_SEVERITY: Record<SignoffStatus, number> = {
  signed: 0,
  review: 1,
  rejected: 2,
};

export function worstStatus(statuses: SignoffStatus[]): SignoffStatus {
  return statuses.reduce<SignoffStatus>(
    (worst, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst),
    "signed"
  );
}

export interface TankSpec {
  id: string; // 气瓶编号
  volume: string; // 容积，如 "12L铝瓶"
  inspectionDue: string; // 检验有效期，YYYY-MM-DD
}

/** 一个充填任务：单瓶或双瓶组 */
export interface FillGroup {
  id: string;
  label: string;
  tanks: TankSpec[];
}

/** 检验是否过期（有效期当天仍有效，次日零时起过期） */
export function isExpired(tank: TankSpec, today: Date): boolean {
  const due = new Date(`${tank.inspectionDue}T00:00:00`);
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return due.getTime() < day.getTime();
}

/** 百分点偏差，保留两位小数以消除浮点误差（如 |32.1−31| = 1.0999…） */
export function deviation(measured: number, target: number): number {
  return Math.round(Math.abs(measured - target) * 100) / 100;
}

export interface TankMeasurement {
  tankId: string;
  measuredO2: number; // 实测氧含量 %
  measuredHe: number | null; // 实测氦含量 %（仅 Trimix）
}

export interface FillDraft {
  groupId: string;
  gasType: GasType;
  targetO2: number; // 目标氧含量 %
  targetHe: number | null; // 目标氦含量 %（仅 Trimix）
  residualPressure: number | null; // 残压 bar（记录用）
  targetPressure: number | null; // 目标压力 bar（记录用）
  operator: string; // 操作员
  measurements: TankMeasurement[];
}

export interface TankResult {
  tankId: string;
  measuredO2: number;
  measuredHe: number | null;
  o2Deviation: number;
  heDeviation: number | null;
  expired: boolean;
  status: SignoffStatus;
  reasons: string[];
}

export interface Submission {
  id: string; // 签收单号
  groupId: string;
  groupLabel: string;
  gasType: GasType;
  targetO2: number;
  targetHe: number | null;
  residualPressure: number | null;
  targetPressure: number | null;
  operator: string;
  submittedAt: string; // ISO
  results: TankResult[];
  status: SignoffStatus; // 组内最差单瓶状态
}

/** 核对单瓶：过期 → 不可签收；氧/氦偏差超差 → 待复核（保留实测值） */
export function evaluateTank(
  tank: TankSpec,
  draft: FillDraft,
  measurement: TankMeasurement,
  today: Date
): TankResult {
  const reasons: string[] = [];
  const o2Deviation = deviation(measurement.measuredO2, draft.targetO2);
  const expired = isExpired(tank, today);

  let heDeviation: number | null = null;
  let heFailed = false;
  if (draft.gasType === "trimix") {
    if (draft.targetHe == null || measurement.measuredHe == null) {
      heFailed = true;
      reasons.push("Trimix 缺少氦含量目标值或实测值，无法核对");
    } else {
      heDeviation = deviation(measurement.measuredHe, draft.targetHe);
      if (heDeviation > HE_TOLERANCE) {
        heFailed = true;
        reasons.push(
          `氦含量偏差 ${heDeviation} 个百分点，超过 ${HE_TOLERANCE} 个百分点限值`
        );
      }
    }
  }

  const o2Failed = o2Deviation > O2_TOLERANCE;
  if (o2Failed) {
    reasons.push(
      `氧含量偏差 ${o2Deviation} 个百分点，超过 ${O2_TOLERANCE} 个百分点限值`
    );
  }

  let status: SignoffStatus = "signed";
  if (expired) {
    status = "rejected";
    reasons.unshift(`检验有效期 ${tank.inspectionDue} 已过，不可签收`);
  } else if (o2Failed || heFailed) {
    status = "review";
    reasons.push("保留实测值，进入待复核");
  }

  return {
    tankId: tank.id,
    measuredO2: measurement.measuredO2,
    measuredHe: measurement.measuredHe,
    o2Deviation,
    heDeviation,
    expired,
    status,
    reasons,
  };
}

/** 核对整个充填任务（单瓶或双瓶组），组状态 = 最差单瓶状态 */
export function evaluateGroup(
  group: FillGroup,
  draft: FillDraft,
  today: Date,
  sequence: number
): Submission {
  const results = group.tanks.map((tank) => {
    const measurement = draft.measurements.find((m) => m.tankId === tank.id);
    if (!measurement) {
      throw new Error(`缺少气瓶 ${tank.id} 的实测数据`);
    }
    return evaluateTank(tank, draft, measurement, today);
  });

  return {
    id: `SUB-${String(sequence).padStart(4, "0")}`,
    groupId: group.id,
    groupLabel: group.label,
    gasType: draft.gasType,
    targetO2: draft.targetO2,
    targetHe: draft.targetHe,
    residualPressure: draft.residualPressure,
    targetPressure: draft.targetPressure,
    operator: draft.operator,
    submittedAt: today.toISOString(),
    results,
    status: worstStatus(results.map((r) => r.status)),
  };
}

export interface FillState {
  groups: FillGroup[];
  submissions: Submission[]; // 首次提交的结果，按提交顺序
}

export type SubmitOutcome =
  | { kind: "accepted"; state: FillState; submission: Submission }
  | { kind: "duplicate"; state: FillState; kept: Submission }
  | { kind: "unknown-group"; state: FillState };

/**
 * 提交充填结果。同一任务重复提交时只保留首次结果，
 * 状态原样返回，队列 / 复核数 / 单瓶历史均不受影响。
 */
export function submitFill(
  state: FillState,
  draft: FillDraft,
  today: Date
): SubmitOutcome {
  const existing = state.submissions.find((s) => s.groupId === draft.groupId);
  if (existing) {
    return { kind: "duplicate", state, kept: existing };
  }
  const group = state.groups.find((g) => g.id === draft.groupId);
  if (!group) {
    return { kind: "unknown-group", state };
  }
  const submission = evaluateGroup(
    group,
    draft,
    today,
    state.submissions.length + 1
  );
  return {
    kind: "accepted",
    state: { ...state, submissions: [...state.submissions, submission] },
    submission,
  };
}

/* ---------- 派生视图：全部由 submissions 计算，保证三者一致 ---------- */

/** 待充填队列：尚未提交（或提交被去重忽略）的任务 */
export function selectQueue(state: FillState): FillGroup[] {
  const done = new Set(state.submissions.map((s) => s.groupId));
  return state.groups.filter((g) => !done.has(g.id));
}

/** 待复核单瓶结果（含所属签收单信息） */
export interface ReviewItem {
  submission: Submission;
  result: TankResult;
}

export function selectReviews(state: FillState): ReviewItem[] {
  return state.submissions.flatMap((submission) =>
    submission.results
      .filter((r) => r.status === "review")
      .map((result) => ({ submission, result }))
  );
}

/** 复核数：与待复核列表同源同长 */
export function selectReviewCount(state: FillState): number {
  return selectReviews(state).length;
}

export interface HistoryEntry {
  submission: Submission;
  result: TankResult;
}

/** 单瓶历史：按提交时间排列；重复提交已被去重，不会重复入账 */
export function selectTankHistory(state: FillState, tankId: string): HistoryEntry[] {
  return state.submissions.flatMap((submission) =>
    submission.results
      .filter((r) => r.tankId === tankId)
      .map((result) => ({ submission, result }))
  );
}

/** 队列中检验已过期的气瓶 */
export function selectExpiredTanks(state: FillState, today: Date): TankSpec[] {
  return selectQueue(state)
    .flatMap((g) => g.tanks)
    .filter((t) => isExpired(t, today));
}

/** 平均氧含量：全部已提交单瓶实测氧含量的均值（保留实测，含待复核） */
export function selectAverageO2(state: FillState): number | null {
  const results = state.submissions.flatMap((s) => s.results);
  if (results.length === 0) return null;
  const sum = results.reduce((acc, r) => acc + r.measuredO2, 0);
  return Math.round((sum / results.length) * 10) / 10;
}

/** 混合气比例提示，如 “Trimix 18/45：氧 18% · 氦 45% · 氮 37%” */
export function mixHint(gasType: GasType, targetO2: number, targetHe: number | null): string {
  const round = (n: number) => Math.round(n * 10) / 10;
  if (gasType === "trimix") {
    const he = targetHe ?? 0;
    const n2 = round(100 - targetO2 - he);
    return `Trimix ${round(targetO2)}/${round(he)}：氧 ${round(targetO2)}% · 氦 ${round(he)}% · 氮 ${n2}%`;
  }
  const n2 = round(100 - targetO2);
  if (gasType === "nitrox") {
    return `高氧 EAN${round(targetO2)}：氧 ${round(targetO2)}% · 氮 ${n2}%`;
  }
  return `空气：氧 ${round(targetO2)}% · 氮 ${n2}%`;
}
