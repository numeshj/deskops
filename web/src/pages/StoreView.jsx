import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import ActivityRow from "../components/ActivityRow.jsx";
import { api } from "../lib/api.js";

/**
 * T18 — one page per store, the full history across every work type.
 * In the spreadsheet this history was spread over four sheets with no link
 * between them. Here it is one list.
 */
export default function StoreView() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.store(id).then(setData).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <div className="card"><div className="empty">Store not found.</div></div>;
  if (!data) return <div className="muted">Loading…</div>;

  const { store, contacts, activities, orders, summary } = data;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 className="mono" style={{ fontSize: 22 }}>{store.code_display}</h2>
        <span className="muted">{store.name || "no trading name recorded"}</span>
        <span className={`tag ${store.status === "active" ? "ok" : ""}`}>{store.status}</span>
      </div>

      {store.delivery_note && (
        <div className="card" style={{ marginBottom: 14, borderColor: "var(--warn)" }}>
          <div className="body"><strong>Delivery note:</strong> {store.delivery_note}</div>
        </div>
      )}

      <div className="counters" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
        <div className="ct"><div className="v tnum">{summary.total}</div><div className="k">records</div></div>
        <div className={`ct${summary.open_items ? " flag" : ""}`}><div className="v tnum">{summary.open_items}</div><div className="k">open items</div></div>
        <div className="ct"><div className="v tnum">{orders.length}</div><div className="k">orders</div></div>
        <div className="ct"><div className="v tnum">{contacts.length}</div><div className="k">contacts</div></div>
      </div>

      <div className="cols">
        <div className="card">
          <h2>History <span className="cnt">{activities.length}</span><span className="push">newest first</span></h2>
          <div>
            {activities.length === 0 && <div className="empty">No records yet.</div>}
            {activities.map((a) => (
              <ActivityRow key={a.activity_id} a={{ ...a, store_code: null }} showDate />
            ))}
          </div>
        </div>

        <div className="rail">
          <div className="card">
            <h2>Contacts</h2>
            {contacts.length === 0 && <div className="empty">None recorded.</div>}
            {contacts.map((c) => (
              <div key={c.contact_id} className="unl">
                <div className="lab">{c.name}</div>
                <div className="meta mono">{[c.phone, c.whatsapp, c.role].filter(Boolean).join(" · ") || `${c.mention_count}×`}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Work mix</h2>
            {summary.by_type.map((t) => (
              <div key={t.work_type_id} className="unl">
                <div className="row"><span className="lab">{t.label}</span><b className="push mono">{t.n}</b></div>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Orders <span className="cnt">{orders.length}</span></h2>
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              {orders.map((o) => (
                <div key={o.order_id} className="unl">
                  <Link className="lab mono" to={`/orders/${o.number}`}>{o.number}</Link>
                  <div className="meta mono">{o.placed_on || "—"} · {o.order_type}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
