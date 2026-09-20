import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api.js";
import StorePicker from "../components/StorePicker.jsx";
import ProductPicker from "../components/ProductPicker.jsx";

/**
 * One campaign: the store x SKU grid, and the call round.
 *
 * The grid is the record. The call round is the same data turned into a work
 * queue — one store at a time, contact and number already on screen, with the
 * outcome written back the moment she rings off. That is the difference
 * between a spreadsheet you maintain and a screen that does the job.
 */
export default function CampaignView({ toast }) {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [mode, setMode] = useState("grid");
  const [store, setStore] = useState(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setData(await api.campaign(id));
  }, [id]);

  useEffect(() => {
    load().catch(() => toast("Could not load the campaign", null, "error"));
  }, [load, toast]);

  async function addLine(picked) {
    if (!store) { toast("Pick a store first", null, "error"); return; }
    setAdding(true);
    try {
      await api.addCampaignLine(id, {
        store_id: store.store_id,
        product_id: picked?.product_id || null,
        qty_requested: null,
      });
      await load();
    } catch (err) {
      toast(`Could not add — ${err.message}`, null, "error");
    } finally {
      setAdding(false);
    }
  }

  async function patch(lineId, body) {
    try {
      await api.updateCampaignLine(id, lineId, body);
      await load();
    } catch (err) {
      toast(`Could not save — ${err.message}`, null, "error");
    }
  }

  async function close() {
    try {
      await api.updateCampaign(id, { status: data.campaign.status === "open" ? "closed" : "open" });
      await load();
    } catch (err) {
      toast(`Could not change it — ${err.message}`, null, "error");
    }
  }

  if (!data) return <div><div className="empty">Loading…</div></div>;

  const { campaign, lines, totals } = data;

  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>{campaign.name}</h1>
          <span className="sub">
            {campaign.brand ? `${campaign.brand} · ` : ""}
            {campaign.status === "open" ? "open" : `closed ${String(campaign.closed_on || "").slice(0, 10)}`}
            {" · "}
            <Link to="/allocations">all allocations</Link>
          </span>
        </div>
        <div className="tabs">
          <button type="button" className={`tab${mode === "grid" ? " on" : ""}`} onClick={() => setMode("grid")}>
            Grid
          </button>
          <button type="button" className={`tab${mode === "call" ? " on" : ""}`} onClick={() => setMode("call")}>
            Call round
          </button>
          <button type="button" className="btn" onClick={close}>
            {campaign.status === "open" ? "Close campaign" : "Reopen"}
          </button>
        </div>
      </div>

      <div className="counters">
        <Counter n={totals.stores} label="stores" />
        <Counter n={totals.units_requested} label="units asked for" />
        <Counter n={totals.units_fulfilled} label="units shipped" />
        <Counter n={totals.booker_outstanding} label="not on Booker" warn={totals.booker_outstanding > 0} />
        <Counter n={totals.invoice_outstanding} label="no invoice" warn={totals.invoice_outstanding > 0} />
      </div>

      {mode === "grid" ? (
        <>
          <div className="card addline">
            <div className="al-store">
              <StorePicker value={store} onChange={setStore} />
            </div>
            <div className="al-product">
              <ProductPicker onPick={addLine} placeholder={adding ? "Adding…" : "Add a SKU for this store"} />
            </div>
          </div>

          {lines.length === 0 ? (
            <div className="empty">
              Nothing on this campaign yet. Pick a store above, then the SKU they want.
            </div>
          ) : (
            <div className="card">
              <div className="grid">
                <div className="gh">
                  <span>Store</span><span>SKU</span><span>Asked</span><span>Shipped</span>
                  <span>Status</span><span>Order</span><span>Booker</span><span>Invoice</span>
                </div>
                {lines.map((l) => (
                  <div className="gr" key={l.line_id}>
                    <span className="mono">
                      {l.store_id ? <Link to={`/stores/${l.store_id}`}>{l.store_code}</Link> : "—"}
                    </span>
                    <span className="nm">{l.product || <em>any</em>}</span>
                    <input
                      className="qty mono"
                      type="number"
                      min="0"
                      value={l.qty_requested ?? ""}
                      onChange={(e) => patch(l.line_id, { qty_requested: e.target.value })}
                      aria-label="Units asked for"
                    />
                    <input
                      className="qty mono"
                      type="number"
                      min="0"
                      value={l.qty_fulfilled ?? ""}
                      onChange={(e) => patch(l.line_id, { qty_fulfilled: e.target.value })}
                      aria-label="Units shipped"
                    />
                    <select
                      value={l.fulfilment}
                      onChange={(e) => patch(l.line_id, { fulfilment: e.target.value })}
                      aria-label="Fulfilment"
                    >
                      {data.fulfilment_options.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                    <input
                      className="mono ordernum"
                      defaultValue={l.order_number || ""}
                      placeholder="11043984"
                      onBlur={(e) => {
                        if ((e.target.value || "") !== (l.order_number || "")) {
                          patch(l.line_id, { order_number: e.target.value });
                        }
                      }}
                      aria-label="Order number"
                    />
                    <Flag on={l.uploaded_to_booker} onClick={() => patch(l.line_id, { uploaded_to_booker: !l.uploaded_to_booker })} />
                    <Flag on={l.invoice_uploaded} onClick={() => patch(l.line_id, { invoice_uploaded: !l.invoice_uploaded })} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <CallRound id={id} toast={toast} onChanged={load} />
      )}
    </div>
  );
}

function Counter({ n, label, warn }) {
  return (
    <div className={`counter${warn ? " warn" : ""}`}>
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  );
}

function Flag({ on, onClick }) {
  return (
    <button type="button" className={`flag${on ? " on" : ""}`} onClick={onClick} aria-pressed={on}>
      {on ? "✓" : "—"}
    </button>
  );
}

function CallRound({ id, toast, onChanged }) {
  const [data, setData] = useState(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => { setData(await api.callRound(id)); }, [id]);
  useEffect(() => { load().catch(() => toast("Could not load the call list", null, "error")); }, [load, toast]);

  async function record(line, outcome, qty) {
    try {
      await api.updateCampaignLine(id, line.line_id, {
        contact_outcome: outcome,
        ...(qty != null ? { qty_requested: qty } : {}),
      });
      setNote("");
      await load();
      onChanged?.();
    } catch (err) {
      toast(`Could not save — ${err.message}`, null, "error");
    }
  }

  if (!data) return <div className="empty">Loading the call list…</div>;

  const next = data.queue[0];

  return (
    <>
      <div className="card callprogress">
        <strong>{data.progress.called}</strong> of {data.progress.total} called
        <div className="c-bar">
          <span style={{ width: `${data.progress.total ? (data.progress.called / data.progress.total) * 100 : 0}%` }} />
        </div>
      </div>

      {!next ? (
        <div className="empty">Everyone on this campaign has been called.</div>
      ) : (
        <div className="card nextcall">
          <div className="nc-store">
            <Link to={`/stores/${next.store_id}`} className="code big">{next.store_code}</Link>
            <div className="nc-who">
              {next.contact_name || "no contact on file"}
              {next.phone && <a className="tel mono" href={`tel:${next.phone}`}>{next.phone}</a>}
            </div>
          </div>
          <input
            className="field"
            placeholder="What did they say? (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Call outcome"
          />
          <div className="nc-acts">
            <button type="button" className="btn primary" onClick={() => record(next, note || "wants stock")}>
              Wants stock
            </button>
            <button type="button" className="btn" onClick={() => record(next, note || "not interested", 0)}>
              Not interested
            </button>
            <button type="button" className="btn" onClick={() => record(next, note || "no answer")}>
              No answer
            </button>
          </div>
          <div className="nc-rest">{data.queue.length - 1} still to call</div>
        </div>
      )}

      {data.done.length > 0 && (
        <div className="card">
          <h2>Called</h2>
          <div className="body">
            {data.done.map((d) => (
              <div className="line" key={d.line_id}>
                <span className="code mono">{d.store_code}</span>
                <span className="nm">{d.contact_outcome}</span>
                <span className="push mono">{String(d.occurred_on || "").slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
