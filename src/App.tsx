import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import "./styles.css";
import { SEED_GROUPS } from "./data";
import {
  GAS_DEFAULTS,
  GAS_LABELS,
  HE_TOLERANCE,
  O2_TOLERANCE,
  STATUS_LABELS,
  mixHint,
  selectAverageO2,
  selectExpiredTanks,
  selectQueue,
  selectReviews,
  selectTankHistory,
  submitFill,
} from "./signoff";
import type {
  FillDraft,
  FillState,
  GasType,
  SignoffStatus,
  Submission,
} from "./signoff";

const GAS_TYPES: GasType[] = ["air", "nitrox", "trimix"];

const STATUS_CLASS: Record<SignoffStatus, string> = {
  signed: "ok",
  review: "warn",
  rejected: "bad",
};

type Message = { kind: "success" | "warn" | "error" | "info"; text: string };

/** 检验有效期的人性化描述 */
function dueLabel(due: string, today: Date): { text: string; expired: boolean; soon: boolean } {
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dueDay = new Date(`${due}T00:00:00`);
  const days = Math.round((dueDay.getTime() - dayStart.getTime()) / 86400000);
  if (days < 0) return { text: `已过期 ${-days} 天`, expired: true, soon: false };
  if (days <= 30) return { text: `剩余 ${days} 天`, expired: false, soon: true };
  return { text: `检验至 ${due}`, expired: false, soon: false };
}

function App() {
  const [state, setState] = useState<FillState>({
    groups: SEED_GROUPS,
    submissions: [],
  });
  const [selectedGroupId, setSelectedGroupId] = useState(SEED_GROUPS[0].id);
  const [gasType, setGasType] = useState<GasType>("nitrox");
  const [targetO2, setTargetO2] = useState(String(GAS_DEFAULTS.nitrox.o2));
  const [targetHe, setTargetHe] = useState(String(GAS_DEFAULTS.nitrox.he ?? ""));
  const [residual, setResidual] = useState("55");
  const [targetPressure, setTargetPressure] = useState("200");
  const [operator, setOperator] = useState("");
  const [measured, setMeasured] = useState<Record<string, { o2: string; he: string }>>({});
  const [message, setMessage] = useState<Message | null>(null);
  const [historyTankId, setHistoryTankId] = useState(SEED_GROUPS[0].tanks[0].id);
  const [recordFilter, setRecordFilter] = useState<"all" | GasType | "review">("all");

  const today = useMemo(() => new Date(), []);
  const queue = selectQueue(state);
  const group = queue.find((g) => g.id === selectedGroupId) ?? queue[0];

  // 切换充填任务时重置实测输入
  useEffect(() => {
    if (!group) return;
    setMeasured(
      Object.fromEntries(group.tanks.map((t) => [t.id, { o2: "", he: "" }]))
    );
  }, [group?.id]);

  // 切换气体时带出默认目标配比
  useEffect(() => {
    const d = GAS_DEFAULTS[gasType];
    setTargetO2(String(d.o2));
    setTargetHe(d.he == null ? "" : String(d.he));
  }, [gasType]);

  const reviews = selectReviews(state);
  const expiredTanks = selectExpiredTanks(state, today);
  const avgO2 = selectAverageO2(state);
  const signedCount = state.submissions.filter((s) => s.status === "signed").length;
  const history = selectTankHistory(state, historyTankId);
  const records = state.submissions.filter((s) =>
    recordFilter === "all"
      ? true
      : recordFilter === "review"
        ? s.status === "review"
        : s.gasType === recordFilter
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!group) return;

    const o2 = parseFloat(targetO2);
    if (Number.isNaN(o2)) {
      return setMessage({ kind: "error", text: "请填写有效的目标氧含量" });
    }
    let he: number | null = null;
    if (gasType === "trimix") {
      he = parseFloat(targetHe);
      if (targetHe.trim() === "" || Number.isNaN(he)) {
        return setMessage({ kind: "error", text: "Trimix 请填写目标氦含量" });
      }
    }
    if (!operator.trim()) {
      return setMessage({ kind: "error", text: "请填写操作员" });
    }
    const measurements = [];
    for (const tank of group.tanks) {
      const m = measured[tank.id];
      const measuredO2 = parseFloat(m?.o2 ?? "");
      if (!m || Number.isNaN(measuredO2)) {
        return setMessage({ kind: "error", text: `请填写 ${tank.id} 的实测氧含量` });
      }
      let measuredHe: number | null = null;
      if (gasType === "trimix") {
        measuredHe = parseFloat(m.he);
        if (m.he.trim() === "" || Number.isNaN(measuredHe)) {
          return setMessage({ kind: "error", text: `请填写 ${tank.id} 的实测氦含量` });
        }
      }
      measurements.push({ tankId: tank.id, measuredO2, measuredHe });
    }

    const draft: FillDraft = {
      groupId: group.id,
      gasType,
      targetO2: o2,
      targetHe: he,
      residualPressure: residual.trim() === "" ? null : parseFloat(residual),
      targetPressure: targetPressure.trim() === "" ? null : parseFloat(targetPressure),
      operator: operator.trim(),
      measurements,
    };

    const outcome = submitFill(state, draft, new Date());
    if (outcome.kind === "duplicate") {
      setMessage({
        kind: "info",
        text: `重复提交已忽略，保留首次结果 ${outcome.kept.id}（${STATUS_LABELS[outcome.kept.status]}）`,
      });
      return;
    }
    if (outcome.kind === "unknown-group") {
      setMessage({ kind: "error", text: "充填任务不存在" });
      return;
    }
    setState(outcome.state);
    const s: Submission = outcome.submission;
    const reasons = s.results.flatMap((r) => r.reasons).join("；");
    if (s.status === "signed") {
      setMessage({ kind: "success", text: `✓ ${s.groupLabel} 签收完成，签收单 ${s.id}` });
    } else if (s.status === "review") {
      setMessage({
        kind: "warn",
        text: `⚠ ${s.groupLabel} 保留实测值进入待复核（${s.id}）：${reasons}`,
      });
    } else {
      setMessage({ kind: "error", text: `✕ ${s.groupLabel} 不可签收（${s.id}）：${reasons}` });
    }
  }

  const metrics: { label: string; value: string }[] = [
    { label: "待充填", value: String(queue.length) },
    { label: "待复核", value: String(reviews.length) },
    { label: "过期提醒", value: String(expiredTanks.length) },
    { label: "平均氧含量", value: avgO2 == null ? "—" : `${avgO2}%` },
    { label: "签收单", value: String(signedCount) },
  ];

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62010 · 充填台混气签收</p>
        <h1>潜水气瓶充填记录</h1>
        <span>
          空气 / 高氧 / Trimix 按目标氧含量核对，氧偏差超过 {O2_TOLERANCE}{" "}
          个百分点或 Trimix 氦偏差超过 {HE_TOLERANCE}{" "}
          个百分点即保留实测值进入待复核；双瓶组按最差单瓶状态放行，任一瓶检验过期全组不可签收；重复提交只保留首次结果。
        </span>
      </section>

      <section className="metrics">
        {metrics.map((m) => (
          <article key={m.label}>
            <small>{m.label}</small>
            <strong>{m.value}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>待充填队列</h2>
          <div className="queue">
            {queue.length === 0 && <p className="empty">队列已清空</p>}
            {queue.map((g) => (
              <article
                key={g.id}
                className={group?.id === g.id ? "queue-item selected" : "queue-item"}
              >
                <div className="queue-head">
                  <h3>{g.label}</h3>
                  <button type="button" onClick={() => setSelectedGroupId(g.id)}>
                    充填
                  </button>
                </div>
                {g.tanks.map((t) => {
                  const due = dueLabel(t.inspectionDue, today);
                  return (
                    <p key={t.id} className="tank-line">
                      <button
                        type="button"
                        className="link"
                        onClick={() => setHistoryTankId(t.id)}
                      >
                        {t.id}
                      </button>
                      <span>
                        {t.volume} ·{" "}
                        <em className={due.expired ? "bad" : due.soon ? "warn" : ""}>
                          {due.text}
                        </em>
                      </span>
                    </p>
                  );
                })}
              </article>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>混气签收</p>
              <h2>{group ? `充填 ${group.label}` : "队列已清空"}</h2>
            </div>
            <button className="primary" form="fill-form" type="submit" disabled={!group}>
              提交签收
            </button>
          </div>

          {group && (
            <form id="fill-form" onSubmit={handleSubmit}>
              <div className="field-grid">
                <label>
                  <span>充填方式</span>
                  <select
                    value={gasType}
                    onChange={(e) => setGasType(e.target.value as GasType)}
                  >
                    {GAS_TYPES.map((g) => (
                      <option key={g} value={g}>
                        {GAS_LABELS[g]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>目标氧含量 %</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={targetO2}
                    onChange={(e) => setTargetO2(e.target.value)}
                  />
                </label>
                {gasType === "trimix" && (
                  <label>
                    <span>目标氦含量 %</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={targetHe}
                      onChange={(e) => setTargetHe(e.target.value)}
                    />
                  </label>
                )}
                <label>
                  <span>残压 bar</span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={residual}
                    onChange={(e) => setResidual(e.target.value)}
                  />
                </label>
                <label>
                  <span>目标压力 bar</span>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={targetPressure}
                    onChange={(e) => setTargetPressure(e.target.value)}
                  />
                </label>
                <label>
                  <span>操作员</span>
                  <input
                    placeholder="填写操作员"
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                  />
                </label>
              </div>

              <p className="mix-hint">
                {mixHint(gasType, parseFloat(targetO2) || 0, gasType === "trimix" ? parseFloat(targetHe) || 0 : null)}
                {"　"}允差：氧 ±{O2_TOLERANCE}pp{gasType === "trimix" && `，氦 ±${HE_TOLERANCE}pp`}
              </p>

              {group.tanks.map((t) => {
                const due = dueLabel(t.inspectionDue, today);
                return (
                  <fieldset key={t.id} className="tank-fieldset">
                    <legend>
                      {t.id} · {t.volume} ·{" "}
                      <em className={due.expired ? "bad" : due.soon ? "warn" : ""}>
                        {due.text}
                      </em>
                      {due.expired && "（任一瓶过期全组不可签收）"}
                    </legend>
                    <div className="field-grid">
                      <label>
                        <span>实测氧含量 %</span>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={measured[t.id]?.o2 ?? ""}
                          onChange={(e) =>
                            setMeasured((prev) => ({
                              ...prev,
                              [t.id]: { o2: e.target.value, he: prev[t.id]?.he ?? "" },
                            }))
                          }
                        />
                      </label>
                      {gasType === "trimix" && (
                        <label>
                          <span>实测氦含量 %</span>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            value={measured[t.id]?.he ?? ""}
                            onChange={(e) =>
                              setMeasured((prev) => ({
                                ...prev,
                                [t.id]: { o2: prev[t.id]?.o2 ?? "", he: e.target.value },
                              }))
                            }
                          />
                        </label>
                      )}
                    </div>
                  </fieldset>
                );
              })}
            </form>
          )}

          {message && <p className={`msg ${message.kind}`}>{message.text}</p>}
        </section>
      </section>

      <section className="workspace">
        <section className="panel">
          <div className="heading">
            <div>
              <p>待复核</p>
              <h2>保留实测值 · {reviews.length} 瓶次</h2>
            </div>
          </div>
          <div className="records">
            {reviews.length === 0 && <p className="empty">暂无待复核气瓶</p>}
            {reviews.map(({ submission, result }) => (
              <article key={`${submission.id}-${result.tankId}`}>
                <b className="warn-bg">{result.tankId.slice(-3)}</b>
                <div>
                  <h3>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setHistoryTankId(result.tankId)}
                    >
                      {result.tankId}
                    </button>{" "}
                    · {submission.groupLabel}
                  </h3>
                  <p>
                    实测氧 {result.measuredO2}%（目标 {submission.targetO2}%，偏差{" "}
                    {result.o2Deviation}pp）
                    {result.heDeviation != null &&
                      ` · 实测氦 ${result.measuredHe}%（目标 ${submission.targetHe}%，偏差 ${result.heDeviation}pp）`}
                  </p>
                  <p>{result.reasons.join("；")}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="heading">
            <div>
              <p>单瓶历史</p>
              <h2>{historyTankId}</h2>
            </div>
          </div>
          <div className="records">
            {history.length === 0 && <p className="empty">该瓶暂无充填记录</p>}
            {history.map(({ submission, result }) => (
              <article key={`${submission.id}-${result.tankId}`}>
                <b className={`${STATUS_CLASS[result.status]}-bg`}>
                  {STATUS_LABELS[result.status]}
                </b>
                <div>
                  <h3>
                    {submission.id} · {GAS_LABELS[submission.gasType]} ·{" "}
                    {submission.operator}
                  </h3>
                  <p>
                    实测氧 {result.measuredO2}% / 目标 {submission.targetO2}%
                    {result.measuredHe != null &&
                      ` · 实测氦 ${result.measuredHe}% / 目标 ${submission.targetHe}%`}
                    {" · "}
                    {new Date(submission.submittedAt).toLocaleString("zh-CN")}
                  </p>
                  {result.reasons.length > 0 && <p>{result.reasons.join("；")}</p>}
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>签收记录</p>
            <h2>全部签收单 · {state.submissions.length}</h2>
          </div>
          <div className="chips">
            {(["all", "air", "nitrox", "trimix", "review"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={recordFilter === f ? "chip-active" : ""}
                onClick={() => setRecordFilter(f)}
              >
                {f === "all" ? "全部" : f === "review" ? "待复核" : GAS_LABELS[f]}
              </button>
            ))}
          </div>
        </div>
        <div className="records">
          {records.length === 0 && <p className="empty">暂无签收记录</p>}
          {records.map((s) => (
            <article key={s.id}>
              <b className={`${STATUS_CLASS[s.status]}-bg`}>{STATUS_LABELS[s.status]}</b>
              <div>
                <h3>
                  {s.id} · {s.groupLabel} · {GAS_LABELS[s.gasType]} · 目标氧{" "}
                  {s.targetO2}%
                  {s.targetHe != null && ` / 目标氦 ${s.targetHe}%`} · {s.operator}
                </h3>
                <p>
                  {s.results
                    .map(
                      (r) =>
                        `${r.tankId}：实测氧 ${r.measuredO2}%` +
                        (r.measuredHe != null ? ` / 实测氦 ${r.measuredHe}%` : "") +
                        `（${STATUS_LABELS[r.status]}）`
                    )
                    .join("　")}
                </p>
                <p>
                  {s.residualPressure != null && `残压 ${s.residualPressure}bar · `}
                  {s.targetPressure != null && `目标压力 ${s.targetPressure}bar · `}
                  {new Date(s.submittedAt).toLocaleString("zh-CN")}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
