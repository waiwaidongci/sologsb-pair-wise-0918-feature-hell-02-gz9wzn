import {
  evaluateTank,
  worstStatus,
  type GasReading,
  type GasType,
  type SignOffStatus,
  type Tank,
  type TankEvaluation,
} from "./gas";

/** 待充填队列中的一单 */
export interface FillOrder {
  orderId: string;
  /** 1 个为单瓶，2 个为双瓶组 */
  tankIds: string[];
  gasType: GasType;
  targetO2: number;
  targetHe?: number;
  residualPressure: number;
  targetPressure: number;
  operator: string;
}

export interface TankSignOff {
  tankId: string;
  measuredO2: number;
  measuredHe?: number;
  evaluation: TankEvaluation;
}

export interface SignOffRecord {
  recordId: string;
  /** 幂等键：重复提交只保留首次结果 */
  submissionId: string;
  orderId: string;
  gasType: GasType;
  targetO2: number;
  targetHe?: number;
  results: TankSignOff[];
  /** 整单状态 = 所有单瓶最差状态 */
  status: SignOffStatus;
  operator: string;
  submittedAt: string;
}

export interface TankHistoryEntry {
  recordId: string;
  submittedAt: string;
  gasType: GasType;
  targetO2: number;
  measuredO2: number;
  targetHe?: number;
  measuredHe?: number;
  status: SignOffStatus;
  reasons: string[];
}

export interface FillState {
  today: string;
  tanks: Record<string, Tank>;
  queue: FillOrder[];
  records: SignOffRecord[];
  /** submissionId -> recordId，用于重复提交去重 */
  submissions: Record<string, string>;
  history: Record<string, TankHistoryEntry[]>;
}

export interface MeasuredInput {
  tankId: string;
  measuredO2: number;
  measuredHe?: number;
}

export interface SubmitSignOffAction {
  type: "submitSignOff";
  submissionId: string;
  orderId: string;
  measured: MeasuredInput[];
  operator: string;
  submittedAt: string;
}

export type FillAction = SubmitSignOffAction;

/**
 * 签收提交（幂等）：
 * - 同一 submissionId 重复提交 → 原样返回，队列、复核数、单瓶历史均不变；
 * - 首次提交 → 逐瓶评估，整单取最差状态，出队、入账、写单瓶历史，一次完成。
 */
export function applySignOff(state: FillState, action: SubmitSignOffAction): FillState {
  if (state.submissions[action.submissionId] !== undefined) {
    return state;
  }
  const order = state.queue.find((o) => o.orderId === action.orderId);
  if (!order) {
    return state;
  }

  const results: TankSignOff[] = action.measured.map((m) => {
    const tank = state.tanks[m.tankId];
    const reading: GasReading = {
      gasType: order.gasType,
      targetO2: order.targetO2,
      measuredO2: m.measuredO2,
      targetHe: order.targetHe,
      measuredHe: m.measuredHe,
    };
    return {
      tankId: m.tankId,
      measuredO2: m.measuredO2,
      measuredHe: m.measuredHe,
      evaluation: evaluateTank(tank, reading, state.today),
    };
  });

  const record: SignOffRecord = {
    recordId: `R-${action.submissionId}`,
    submissionId: action.submissionId,
    orderId: order.orderId,
    gasType: order.gasType,
    targetO2: order.targetO2,
    targetHe: order.targetHe,
    results,
    status: worstStatus(results.map((r) => r.evaluation)),
    operator: action.operator,
    submittedAt: action.submittedAt,
  };

  const history = { ...state.history };
  for (const r of results) {
    const entry: TankHistoryEntry = {
      recordId: record.recordId,
      submittedAt: record.submittedAt,
      gasType: record.gasType,
      targetO2: record.targetO2,
      measuredO2: r.measuredO2,
      targetHe: record.targetHe,
      measuredHe: r.measuredHe,
      status: r.evaluation.status,
      reasons: r.evaluation.reasons,
    };
    history[r.tankId] = [...(history[r.tankId] ?? []), entry];
  }

  return {
    ...state,
    queue: state.queue.filter((o) => o.orderId !== order.orderId),
    records: [...state.records, record],
    submissions: { ...state.submissions, [action.submissionId]: record.recordId },
    history,
  };
}

export function fillReducer(state: FillState, action: FillAction): FillState {
  switch (action.type) {
    case "submitSignOff":
      return applySignOff(state, action);
  }
}

/* ---------- 选择器：全部从同一份 records 派生，保证口径一致 ---------- */

export const selectReviewCount = (s: FillState) =>
  s.records.filter((r) => r.status === "pending_review").length;

export const selectSignedCount = (s: FillState) =>
  s.records.filter((r) => r.status === "signed").length;

export const selectAverageO2 = (s: FillState): number | null => {
  const all = s.records.flatMap((r) => r.results.map((t) => t.measuredO2));
  if (all.length === 0) return null;
  return Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10;
};

/* ---------- 初始数据 ---------- */

const SEED_TANKS: Tank[] = [
  { id: "TANK-204", label: "12L 铝瓶", inspectionExpiry: "2027-03-15" },
  { id: "TANK-219", label: "11L 钢瓶", inspectionExpiry: "2026-10-02" },
  { id: "TANK-231", label: "双瓶组 A 瓶 · 12L 钢瓶", inspectionExpiry: "2026-09-25" },
  { id: "TANK-232", label: "双瓶组 B 瓶 · 12L 钢瓶", inspectionExpiry: "2026-08-30" },
  { id: "TANK-240", label: "11L 钢瓶", inspectionExpiry: "2027-01-10" },
];

const SEED_QUEUE: FillOrder[] = [
  {
    orderId: "O-1001",
    tankIds: ["TANK-204"],
    gasType: "air",
    targetO2: 20.9,
    residualPressure: 55,
    targetPressure: 200,
    operator: "阿豪",
  },
  {
    orderId: "O-1002",
    tankIds: ["TANK-219"],
    gasType: "nitrox",
    targetO2: 32,
    residualPressure: 30,
    targetPressure: 200,
    operator: "小琳",
  },
  {
    orderId: "O-1003",
    tankIds: ["TANK-231", "TANK-232"],
    gasType: "trimix",
    targetO2: 21,
    targetHe: 35,
    residualPressure: 40,
    targetPressure: 200,
    operator: "阿豪",
  },
  {
    orderId: "O-1004",
    tankIds: ["TANK-240"],
    gasType: "nitrox",
    targetO2: 36,
    residualPressure: 20,
    targetPressure: 207,
    operator: "老周",
  },
];

export function buildInitialState(today: string): FillState {
  const base: FillState = {
    today,
    tanks: Object.fromEntries(SEED_TANKS.map((t) => [t.id, t])),
    queue: SEED_QUEUE,
    records: [],
    submissions: {},
    history: {},
  };
  // 预置一笔昨日已签收记录，走与实时提交完全相同的入口，保证口径一致
  return applySignOff(
    {
      ...base,
      queue: [
        ...SEED_QUEUE,
        {
          orderId: "O-0999",
          tankIds: ["TANK-204"],
          gasType: "nitrox",
          targetO2: 32,
          residualPressure: 60,
          targetPressure: 200,
          operator: "小琳",
        },
      ],
    },
    {
      type: "submitSignOff",
      submissionId: "SEED-0999",
      orderId: "O-0999",
      measured: [{ tankId: "TANK-204", measuredO2: 32.3 }],
      operator: "小琳",
      submittedAt: "2026-09-16 15:40",
    }
  );
}
