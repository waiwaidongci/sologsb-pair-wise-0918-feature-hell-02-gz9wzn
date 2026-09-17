import { useMemo, useReducer, useState } from "react";
import "./styles.css";
import {
  GAS_LABELS,
  HE_TOLERANCE,
  O2_TOLERANCE,
  daysToExpiry,
  isExpired,
  mixHint,
  type SignOffStatus,
} from "./domain/gas";
import {
  buildInitialState,
  fillReducer,
  selectAverageO2,
  selectReviewCount,
  selectSignedCount,
  type FillOrder,
  type MeasuredInput,
} from "./domain/store";

const STATUS_LABELS: Record<SignOffStatus, string> = {
  signed: "已签收",
  pending_review: "待复核",
  rejected: "不可签收",
};

type QueueFilter = "all" | "air" | "nitrox" | "trimix" | "expired";

const FILTER_LABELS: Record<QueueFilter, string> = {
  all: "全部",
  air: "空气",
  nitrox: "高氧",
  trimix: "Trimix",
  expired: "待检验",
};

function formatNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function todayIso(): string {
  return formatNow().slice(0, 10);
}

function StatusBadge({ status }: { status: SignOffStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>;
}

function App() {
  const [state, dispatch] = useReducer(fillReducer, undefined, () =>
    buildInitialState(todayIso())
  );

  const [filter, setFilter] = useState<QueueFilter>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [measured, setMeasured] = useState<Record<string, { o2: string; he: string }>>({});
  const [operator, setOperator] = useState("");
  const [historyTankId, setHistoryTankId] = useState("TANK-204");
  const [notice, setNotice] = useState<string | null>(null);

  const selectedOrder: FillOrder | undefined = state.queue.find(
    (o) => o.orderId === selectedOrderId
  );

  const filteredQueue = useMemo(
    () =>
      state.queue.filter((o) => {
        if (filter === "all") return true;
        if (filter === "expired")
          return o.tankIds.some((id) => isExpired(state.tanks[id], state.today));
        return o.gasType === filter;
      }),
    [state, filter]
  );

  const expiringTanks = useMemo(
    () =>
      Object.values(state.tanks)
        .map((t) => ({ tank: t, days: daysToExpiry(t, state.today) }))
        .filter(({ days }) => days <= 30)
        .sort((a, b) => a.days - b.days),
    [state]
  );

  const pendingReviews = state.records.filter((r) => r.status === "pending_review");
  const avgO2 = selectAverageO2(state);
  const tankHistory = [...(state.history[historyTankId] ?? [])].reverse();

  const selectOrder = (orderId: string) => {
    setSelectedOrderId(orderId);
    setNotice(null);
    const order = state.queue.find((o) => o.orderId === orderId);
    if (order) {
      setOperator(order.operator);
      setMeasured(
        Object.fromEntries(order.tankIds.map((id) => [id, { o2: "", he: "" }]))
      );
    }
  };

  const submit = () => {
    if (!selectedOrder) return;
    const inputs: MeasuredInput[] = [];
    for (const tankId of selectedOrder.tankIds) {
      const m = measured[tankId];
      const o2 = Number.parseFloat(m?.o2 ?? "");
      if (!Number.isFinite(o2) || o2 <= 0 || o2 > 100) {
        setNotice(`请填写 ${tankId} 有效的实测氧含量（0–100%）`);
        return;
      }
      let he: number | undefined;
      if (selectedOrder.gasType === "trimix") {
        const parsed = Number.parseFloat(m?.he ?? "");
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
          setNotice(`请填写 ${tankId} 有效的实测氦含量（0–100%）`);
          return;
        }
        he = parsed;
      }
      inputs.push({ tankId, measuredO2: o2, measuredHe: he });
    }
    if (!operator.trim()) {
      setNotice("请填写操作员");
      return;
    }
    // 幂等键与订单绑定：重复点击 / 重复提交同一单只会保留首次结果
    dispatch({
      type: "submitSignOff",
      submissionId: `SUB-${selectedOrder.orderId}`,
      orderId: selectedOrder.orderId,
      measured: inputs,
      operator: operator.trim(),
      submittedAt: formatNow(),
    });
    setSelectedOrderId("");
    setMeasured({});
    setNotice(null);
  };

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62010 · 潜水气瓶充填 · 混气签收台</p>
        <h1>潜水气瓶充填记录</h1>
        <span>
          空气、高氧、Trimix 按目标氧含量核对，氧含量偏差超过 {O2_TOLERANCE}{" "}
          个百分点即保留实测值并转入待复核；Trimix 氦含量偏差超过 {HE_TOLERANCE}{" "}
          个百分点同样不可签收。双瓶组按最差单瓶状态放行，任一瓶检验过期则全组不可签收；重复提交只保留首次结果。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>待充填</small>
          <strong>{state.queue.length}</strong>
        </article>
        <article>
          <small>待复核</small>
          <strong>{selectReviewCount(state)}</strong>
        </article>
        <article>
          <small>平均氧含量</small>
          <strong>{avgO2 === null ? "—" : `${avgO2}%`}</strong>
        </article>
        <article>
          <small>签收单</small>
          <strong>{selectSignedCount(state)}</strong>
        </article>
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>待充填队列</h2>
          <div className="chips">
            {(Object.keys(FILTER_LABELS) as QueueFilter[]).map((key) => (
              <button
                key={key}
                className={filter === key ? "chip-active" : ""}
                onClick={() => setFilter(key)}
              >
                {FILTER_LABELS[key]}
              </button>
            ))}
          </div>

          {expiringTanks.length > 0 && (
            <div className="expiry-alerts">
              {expiringTanks.map(({ tank, days }) => (
                <p key={tank.id} className={days < 0 ? "alert-expired" : "alert-soon"}>
                  {days < 0
                    ? `⚠ ${tank.id} 检验已过期 ${-days} 天，不可签收`
                    : `⏳ ${tank.id} 检验期剩余 ${days} 天`}
                </p>
              ))}
            </div>
          )}

          <div className="queue">
            {filteredQueue.length === 0 && <p className="empty">当前筛选下没有待充填订单</p>}
            {filteredQueue.map((order) => {
              const expired = order.tankIds.some((id) =>
                isExpired(state.tanks[id], state.today)
              );
              return (
                <button
                  key={order.orderId}
                  className={`queue-item ${selectedOrderId === order.orderId ? "queue-active" : ""}`}
                  onClick={() => selectOrder(order.orderId)}
                >
                  <div className="queue-head">
                    <b>{order.orderId}</b>
                    <span className={`gas gas-${order.gasType}`}>
                      {GAS_LABELS[order.gasType]}
                    </span>
                    {order.tankIds.length > 1 && <span className="gas gas-twin">双瓶组</span>}
                    {expired && <span className="gas gas-expired">含过期瓶</span>}
                  </div>
                  <p>{mixHint(order)}</p>
                  <p>
                    {order.tankIds.join(" + ")} · 残压 {order.residualPressure}bar → 目标{" "}
                    {order.targetPressure}bar · {order.operator}
                  </p>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>充填完成签收</p>
              <h2>混气签收录入</h2>
            </div>
            <button className="primary" onClick={submit} disabled={!selectedOrder}>
              提交签收
            </button>
          </div>

          {!selectedOrder && <p className="empty">从左侧队列选择一单，录入实测气体含量后提交签收。</p>}

          {selectedOrder && (
            <>
              <p className="order-summary">
                {selectedOrder.orderId} · {mixHint(selectedOrder)} · 残压{" "}
                {selectedOrder.residualPressure}bar → 目标 {selectedOrder.targetPressure}bar
              </p>
              <div className="field-grid">
                {selectedOrder.tankIds.map((tankId) => {
                  const tank = state.tanks[tankId];
                  const expired = isExpired(tank, state.today);
                  return (
                    <fieldset key={tankId} className="tank-fields">
                      <legend>
                        {tankId} · {tank.label}
                        {expired && <span className="legend-expired">（已过期，全组不可签收）</span>}
                      </legend>
                      <label>
                        <span>实测氧含量 %（目标 {selectedOrder.targetO2}%）</span>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          placeholder="如 32.4"
                          value={measured[tankId]?.o2 ?? ""}
                          onChange={(e) =>
                            setMeasured((prev) => ({
                              ...prev,
                              [tankId]: { o2: e.target.value, he: prev[tankId]?.he ?? "" },
                            }))
                          }
                        />
                      </label>
                      {selectedOrder.gasType === "trimix" && (
                        <label>
                          <span>实测氦含量 %（目标 {selectedOrder.targetHe}%）</span>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            placeholder="如 34.8"
                            value={measured[tankId]?.he ?? ""}
                            onChange={(e) =>
                              setMeasured((prev) => ({
                                ...prev,
                                [tankId]: { o2: prev[tankId]?.o2 ?? "", he: e.target.value },
                              }))
                            }
                          />
                        </label>
                      )}
                    </fieldset>
                  );
                })}
                <label>
                  <span>操作员</span>
                  <input
                    placeholder="填写操作员"
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                  />
                </label>
              </div>
              <p className="hint">
                提交即按目标值逐瓶核对：氧含量偏差 &gt; {O2_TOLERANCE}%、氦含量偏差 &gt;{" "}
                {HE_TOLERANCE}%（仅 Trimix）或气瓶过期均不可直接签收；同一订单重复提交只保留首次结果。
              </p>
            </>
          )}

          {notice && <p className="notice">{notice}</p>}
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>氧 / 氦含量超限，保留实测值</p>
            <h2>待复核（{pendingReviews.length}）</h2>
          </div>
        </div>
        <div className="records">
          {pendingReviews.length === 0 && <p className="empty">暂无待复核记录</p>}
          {pendingReviews.map((record) => (
            <article key={record.recordId}>
              <b>复核</b>
              <div>
                <h3>
                  {record.orderId} · {GAS_LABELS[record.gasType]}{" "}
                  <StatusBadge status={record.status} />
                </h3>
                {record.results.map((r) => (
                  <p key={r.tankId}>
                    {r.tankId}：实测 O₂ {r.measuredO2}%
                    {r.measuredHe !== undefined && ` · 实测 He ${r.measuredHe}%`}
                    {r.evaluation.reasons.map((reason) => (
                      <em key={reason}>　⚠ {reason}</em>
                    ))}
                  </p>
                ))}
                <p>
                  {record.operator} · {record.submittedAt}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="two-col">
        <section className="panel">
          <div className="heading">
            <div>
              <p>全部签收提交</p>
              <h2>签收记录（{state.records.length}）</h2>
            </div>
          </div>
          <div className="records">
            {state.records.map((record, index) => (
              <article key={record.recordId}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <div>
                  <h3>
                    {record.orderId} · {GAS_LABELS[record.gasType]}{" "}
                    <StatusBadge status={record.status} />
                  </h3>
                  {record.results.map((r) => (
                    <p key={r.tankId}>
                      {r.tankId}：O₂ {r.measuredO2}%（偏差 {r.evaluation.o2Deviation}）
                      {r.evaluation.heDeviation !== null &&
                        ` · He ${r.measuredHe}%（偏差 ${r.evaluation.heDeviation}）`}{" "}
                      <StatusBadge status={r.evaluation.status} />
                    </p>
                  ))}
                  <p>
                    {record.operator} · {record.submittedAt} · 单号 {record.submissionId}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="heading">
            <div>
              <p>单瓶历史</p>
              <h2>气瓶档案</h2>
            </div>
            <select value={historyTankId} onChange={(e) => setHistoryTankId(e.target.value)}>
              {Object.values(state.tanks).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id} · {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="records">
            {tankHistory.length === 0 && <p className="empty">该瓶暂无充填签收记录</p>}
            {tankHistory.map((entry) => (
              <article key={`${entry.recordId}-${entry.submittedAt}`}>
                <b>{entry.submittedAt.slice(5, 10)}</b>
                <div>
                  <h3>
                    {GAS_LABELS[entry.gasType]} <StatusBadge status={entry.status} />
                  </h3>
                  <p>
                    目标 O₂ {entry.targetO2}% → 实测 {entry.measuredO2}%
                    {entry.targetHe !== undefined &&
                      ` · 目标 He ${entry.targetHe}% → 实测 ${entry.measuredHe ?? "—"}%`}
                  </p>
                  {entry.reasons.map((reason) => (
                    <p key={reason}>
                      <em>⚠ {reason}</em>
                    </p>
                  ))}
                  <p>{entry.submittedAt} · {entry.recordId}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
