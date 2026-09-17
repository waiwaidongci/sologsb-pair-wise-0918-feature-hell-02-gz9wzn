/**
 * 混气签收核对规则（纯函数，无副作用）。
 *
 * 规则：
 * - 空气 / 高氧 / Trimix 均按目标氧含量核对，氧含量偏差 > 1 个百分点 → 保留实测，进入待复核。
 * - Trimix 额外核对氦含量，偏差 > 2 个百分点 → 同样不能签收，进入待复核。
 * - 气瓶检验过期 → 不可签收（直接拒收）。
 * - 双瓶组按最差单瓶状态放行；任一瓶过期则全组不可签收。
 */

export type GasType = "air" | "nitrox" | "trimix";

export const GAS_LABELS: Record<GasType, string> = {
  air: "空气",
  nitrox: "高氧",
  trimix: "Trimix",
};

/** 氧含量允许偏差（百分点） */
export const O2_TOLERANCE = 1;
/** 氦含量允许偏差（百分点），仅 Trimix */
export const HE_TOLERANCE = 2;
/** 空气标准氧含量 */
export const AIR_TARGET_O2 = 20.9;

export interface Tank {
  id: string;
  label: string;
  /** 检验有效期，ISO 日期（YYYY-MM-DD） */
  inspectionExpiry: string;
}

export interface GasReading {
  gasType: GasType;
  targetO2: number;
  measuredO2: number;
  /** 仅 Trimix 需要 */
  targetHe?: number;
  measuredHe?: number;
}

export type SignOffStatus = "signed" | "pending_review" | "rejected";

export interface TankEvaluation {
  tankId: string;
  status: SignOffStatus;
  /** 氧含量偏差（百分点，保留 1 位小数） */
  o2Deviation: number;
  /** 氦含量偏差，非 Trimix 为 null */
  heDeviation: number | null;
  /** 进入待复核 / 拒收的原因 */
  reasons: string[];
}

export function isExpired(tank: Tank, today: string): boolean {
  return tank.inspectionExpiry < today;
}

export function daysToExpiry(tank: Tank, today: string): number {
  const ms = Date.parse(tank.inspectionExpiry) - Date.parse(today);
  return Math.ceil(ms / 86_400_000);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 评估单瓶：过期 → 拒收；氧/氦偏差超限 → 待复核（保留实测值）；否则签收。 */
export function evaluateTank(
  tank: Tank,
  reading: GasReading,
  today: string
): TankEvaluation {
  const o2Deviation = round1(Math.abs(reading.measuredO2 - reading.targetO2));
  const isTrimix = reading.gasType === "trimix";
  const heDeviation =
    isTrimix && reading.targetHe !== undefined && reading.measuredHe !== undefined
      ? round1(Math.abs(reading.measuredHe - reading.targetHe))
      : null;

  if (isExpired(tank, today)) {
    return {
      tankId: tank.id,
      status: "rejected",
      o2Deviation,
      heDeviation,
      reasons: [`检验有效期 ${tank.inspectionExpiry} 已过，不可签收`],
    };
  }

  const reasons: string[] = [];
  if (o2Deviation > O2_TOLERANCE) {
    reasons.push(
      `氧含量偏差 ${o2Deviation} 个百分点，超过 ${O2_TOLERANCE} 个百分点（目标 ${reading.targetO2}%，实测 ${reading.measuredO2}%）`
    );
  }
  if (heDeviation !== null && heDeviation > HE_TOLERANCE) {
    reasons.push(
      `氦含量偏差 ${heDeviation} 个百分点，超过 ${HE_TOLERANCE} 个百分点（目标 ${reading.targetHe}%，实测 ${reading.measuredHe}%）`
    );
  }

  return {
    tankId: tank.id,
    status: reasons.length > 0 ? "pending_review" : "signed",
    o2Deviation,
    heDeviation,
    reasons,
  };
}

const STATUS_RANK: Record<SignOffStatus, number> = {
  signed: 0,
  pending_review: 1,
  rejected: 2,
};

/** 双瓶组 / 整单放行状态：取所有单瓶中的最差状态。 */
export function worstStatus(evaluations: TankEvaluation[]): SignOffStatus {
  return evaluations.reduce<SignOffStatus>(
    (worst, e) => (STATUS_RANK[e.status] > STATUS_RANK[worst] ? e.status : worst),
    "signed"
  );
}

/** 混合气比例提示文案，如 "EAN32"、"Tx 21/35"、"空气 20.9% O₂" */
export function mixHint(reading: Pick<GasReading, "gasType" | "targetO2" | "targetHe">): string {
  switch (reading.gasType) {
    case "air":
      return `空气（目标 O₂ ${reading.targetO2}%）`;
    case "nitrox":
      return `EAN${Math.round(reading.targetO2)}（目标 O₂ ${reading.targetO2}%）`;
    case "trimix":
      return `Tx ${reading.targetO2}/${reading.targetHe ?? "?"}（目标 O₂ ${reading.targetO2}% · He ${reading.targetHe ?? "?"}%）`;
  }
}
