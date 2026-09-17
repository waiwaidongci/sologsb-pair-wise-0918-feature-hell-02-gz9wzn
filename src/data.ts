import type { FillGroup } from "./signoff";

const fmt = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

/** 相对今天偏移天数生成检验有效期，保证演示数据状态稳定 */
const offsetDate = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmt(d);
};

/**
 * 初始待充填队列：
 * - G-03 双瓶组两瓶均在检验期内 → 可验证“按最差单瓶状态放行”
 * - G-04 单瓶已过期 → 不可签收
 * - G-05 双瓶组中 TANK-256 已过期 → 任一瓶过期全组不可签收
 */
export const SEED_GROUPS: FillGroup[] = [
  {
    id: "G-01",
    label: "TANK-204",
    tanks: [{ id: "TANK-204", volume: "12L铝瓶", inspectionDue: offsetDate(400) }],
  },
  {
    id: "G-02",
    label: "TANK-219",
    tanks: [{ id: "TANK-219", volume: "11L钢瓶", inspectionDue: offsetDate(15) }],
  },
  {
    id: "G-03",
    label: "双瓶组 TANK-231 + TANK-232",
    tanks: [
      { id: "TANK-231", volume: "12L钢瓶", inspectionDue: offsetDate(12) },
      { id: "TANK-232", volume: "12L钢瓶", inspectionDue: offsetDate(120) },
    ],
  },
  {
    id: "G-04",
    label: "TANK-240",
    tanks: [{ id: "TANK-240", volume: "10L钢瓶", inspectionDue: offsetDate(-18) }],
  },
  {
    id: "G-05",
    label: "双瓶组 TANK-255 + TANK-256",
    tanks: [
      { id: "TANK-255", volume: "12L钢瓶", inspectionDue: offsetDate(150) },
      { id: "TANK-256", volume: "12L钢瓶", inspectionDue: offsetDate(-7) },
    ],
  },
];
