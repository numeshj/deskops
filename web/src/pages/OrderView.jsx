import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api.js";

/**
 * T19 — one order, one timeline.
 *
 * This is the payoff for making order_ref its own table. The same order
 * number used to be typed by hand into Order record, Order Issues, 2p orders
 * and Calls with nothing connecting them. Here the placement, every delivery
 * problem raised against it, and the replacement order that fixed it all
 * resolve to one history.
 */
export default function OrderView() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.order(id).then(setData).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="card"><div className="empty">No order with that number.</div></div>;
  if (!data) return <div className="muted">Loading…</div>;

  const { order, timeline, replacements, sheets_merged } = data;

  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <h2 className="mono" style={{ fontSize: 22 }}>{order.number}</h2>
        <span className="tag">{order.number_generation === "legacy7" ? "old platform" : "current platform"}</span>
        <span className="tag">{order.order_type}</span>
        {order.store_code && <Link className="mono" to={`/stores/${order.store_id}`}>{order.store_code}</Link>}
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 14 }}>
        {timeline.length} record{timeline.length === 1 ? "" : "s"} across {sheets_merged.length} kind
        {sheets_merged.length === 1 ? "" : "s"} of work — {sheets_merged.join(", ")}.
      </p>

      <div className="card">
        <h2>Timeline <span className="push">oldest first</span></h2>
        <div>
          {timeline.length === 0 && <div className="empty">Nothing recorded against this order.</div>}
          {timeline.map((t) => (
            <div className="entry" key={t.activity_id}>
              <div className="t mono">{String(t.occurred_at).slice(0, 10)}</div>
              <div className="stripe" style={{ background: t.work_type_colour || "var(--line-2)" }} />
              <div className="main">
                <div className="l1">
                  <span className="what">{t.work_type_label}</span>
                  {t.reason && <span className="tag">{t.reason}</span>}
                  {t.link_role === "replacement_for" && <span className="tag follow">raised to replace this</span>}
                  {t.follow_up && <span className="tag follow">open</span>}
                </div>
                {(t.note || t.detail?.carrier) && (
                  <div className="l2">
                    {[t.detail?.carrier, t.note].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {replacements.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Replacement orders raised</h2>
          {replacements.map((r) => (
            <div className="unl" key={r.order_id}>
              <Link className="lab mono" to={`/orders/${r.replacement_number}`}>{r.replacement_number}</Link>
              <div className="meta mono">{String(r.occurred_at).slice(0, 10)} · {r.raised_as}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
