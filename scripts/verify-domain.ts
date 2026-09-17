/**
 * 混气签收规则验证（临时脚本，编译后用 node 运行）。
 * 覆盖：氧偏差 1pp、氦偏差 2pp、双瓶组最差放行、过期拒收、重复提交幂等。
 */
import { evaluateTank, worstStatus, type Tank } from "../src/domain/gas";
import { applySignOff, buildInitialState, selectReviewCount } from "../src/domain/store";

const TODAY = "2026-09-17";
const okTank: Tank = { id: "T-1", label: "12L", inspectionExpiry: "2027-01-01" };
const expiredTank: Tank = { id: "T-2", label: "12L", inspectionExpiry: "2026-09-01" };

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures++;
    console.error(`✗ ${name}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// 1. 氧含量偏差：≤1pp 签收，>1pp 待复核且保留实测
check(
  "空气 O2 偏差 0.9pp → 签收",
  evaluateTank(okTank, { gasType: "air", targetO2: 20.9, measuredO2: 21.8 }, TODAY).status === "signed"
);
check(
  "高氧 O2 偏差恰好 1.0pp → 签收（不超过容差）",
  evaluateTank(okTank, { gasType: "nitrox", targetO2: 32, measuredO2: 33 }, TODAY).status === "signed"
);
const o2Over = evaluateTank(okTank, { gasType: "nitrox", targetO2: 32, measuredO2: 33.1 }, TODAY);
check("高氧 O2 偏差 1.1pp → 待复核", o2Over.status === "pending_review");
check("待复核保留实测偏差值", o2Over.o2Deviation === 1.1);

// 2. Trimix 氦含量：≤2pp 通过，>2pp 待复核
check(
  "Trimix He 偏差恰好 2.0pp → 签收",
  evaluateTank(okTank, { gasType: "trimix", targetO2: 21, measuredO2: 21.4, targetHe: 35, measuredHe: 37 }, TODAY).status === "signed"
);
check(
  "Trimix He 偏差 2.1pp → 待复核",
  evaluateTank(okTank, { gasType: "trimix", targetO2: 21, measuredO2: 21, targetHe: 35, measuredHe: 37.1 }, TODAY).status === "pending_review"
);
check(
  "Trimix O2 超限同样 → 待复核",
  evaluateTank(okTank, { gasType: "trimix", targetO2: 21, measuredO2: 22.2, targetHe: 35, measuredHe: 35 }, TODAY).status === "pending_review"
);

// 3. 过期瓶：直接拒收，不看气体
check(
  "过期瓶 → 不可签收",
  evaluateTank(expiredTank, { gasType: "air", targetO2: 20.9, measuredO2: 20.9 }, TODAY).status === "rejected"
);

// 4. 双瓶组按最差单瓶状态放行
const e = (o2: number, tank: Tank = okTank) =>
  evaluateTank(tank, { gasType: "nitrox", targetO2: 32, measuredO2: o2 }, TODAY);
check("双瓶均合格 → 整组签收", worstStatus([e(32.2), e(31.5)]) === "signed");
check("一瓶待复核 → 整组待复核", worstStatus([e(32), e(34)]) === "pending_review");
check("一瓶过期 → 整组不可签收", worstStatus([e(32), e(32, expiredTank)]) === "rejected");
check(
  "过期优先级高于待复核",
  worstStatus([e(34), e(32, expiredTank)]) === "rejected"
);

// 5. 重复提交幂等：队列、复核数、单瓶历史保持一致
let s = buildInitialState(TODAY);
const queueBefore = s.queue.length;
s = applySignOff(s, {
  type: "submitSignOff",
  submissionId: "SUB-X",
  orderId: "O-1002",
  measured: [{ tankId: "TANK-219", measuredO2: 34.5 }], // 偏差 2.5pp → 待复核
  operator: "小琳",
  submittedAt: "2026-09-17 10:00",
});
check("首次提交后出队", s.queue.length === queueBefore - 1);
check("首次提交后复核数 +1", selectReviewCount(s) === 1);
check("首次提交后单瓶历史 +1", s.history["TANK-219"].length === 1);
check("实测值保留在记录中", s.records.at(-1)!.results[0].measuredO2 === 34.5);

const dup = applySignOff(s, {
  type: "submitSignOff",
  submissionId: "SUB-X", // 同一幂等键重复提交
  orderId: "O-1002",
  measured: [{ tankId: "TANK-219", measuredO2: 32.0 }],
  operator: "小琳",
  submittedAt: "2026-09-17 10:05",
});
check("重复提交：状态对象不变", dup === s);
check("重复提交：队列不变", dup.queue.length === s.queue.length);
check("重复提交：复核数不变", selectReviewCount(dup) === 1);
check("重复提交：单瓶历史不变", dup.history["TANK-219"].length === 1);
check("重复提交：保留首次实测值", dup.records.at(-1)!.results[0].measuredO2 === 34.5);

// 6. 双瓶组含过期瓶：整组不可签收，两瓶历史均入账
const s2 = applySignOff(s, {
  type: "submitSignOff",
  submissionId: "SUB-TWIN",
  orderId: "O-1003",
  measured: [
    { tankId: "TANK-231", measuredO2: 21, measuredHe: 35 },
    { tankId: "TANK-232", measuredO2: 21, measuredHe: 35 },
  ],
  operator: "阿豪",
  submittedAt: "2026-09-17 11:00",
});
const twin = s2.records.at(-1)!;
check("双瓶组 B 瓶过期 → 整组不可签收", twin.status === "rejected");
check("双瓶组 A 瓶合格但受连坐", twin.results[0].evaluation.status === "signed");
check("双瓶组两瓶历史均入账", s2.history["TANK-231"].length === 1 && s2.history["TANK-232"].length === 1);
check("拒收不计入待复核数", selectReviewCount(s2) === 1);

if (failures > 0) {
  throw new Error(`${failures} 项验证失败`);
}
console.log("\n全部验证通过");
