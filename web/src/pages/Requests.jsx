import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import ProductPicker from "../components/ProductPicker.jsx";

/**
 * Section 4.7 — customer requests.
 *
 * Two lists per request, because the store is usually doing both at once:
 * items going back and items wanted. Then a four-stage workflow so a request
 * that is waiting on stock does not look the same as one that is finished.
 *
 * Any stage can be set, including backwards. She is the one who knows what
 * actually happened, and a workflow that refuses to be corrected just gets
 * worked around in the notes field.
 */

const STAGE_LABEL = {
  logged: "Logged",
  items_received: "Items received",
  order_placed: "Order placed",
  restocked: "Restocked",
};

export default function Requests({ toast }) {
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [filter, setFilter] = useState("open");

  const load = useCallback(async () => {
    const d = await api.requests(filter === "open" ? { open: "1" } : filter === "all" ? {} : { stage: filter });
    setData(d);
  }, [filter]);

  useEffect(() => {
    load().catch(() => toast("Could not load requests", null, "error"));
  }, [load, toast]);

  async function setStage(id, stage) {
    try {
      await api.setStage(id, stage);
      toast(`Moved to ${STAGE_LABEL[stage]}`);
      await load();
    } catch (err) {
      toast(`Could not update — ${err.message}`, null, "error");
    }
  }

  if (!data) return <div><div className="empty">Loading requests…</div></div>;

  return (
    <div>
      <div className="pagehead">
        <h1>Customer requests</h1>
        <div className="tabs">
          {[["open", "Open"], ...Object.entries(STAGE_LABEL), ["all", "All"]].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`tab${filter === key ? " on" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
              {data.counts[key] != null && <span className="badge">{data.counts[key]}</span>}
            </button>
          ))}
        </div>
      </div>

      {data.requests.length === 0 && (
        <div className="empty">
          Nothing here. Requests are created from the capture screen — pick a store, choose
          “Customer request”, and save. Then add the items to it here.
        </div>
      )}

      {data.requests.map((rq) => (
        <RequestCard
          key={rq.activity_id}
          rq={rq}
          expanded={openId === rq.activity_id}
          onToggle={() => setOpenId(openId === rq.activity_id ? null : rq.activity_id)}
          onStage={setStage}
          onChanged={load}
          toast={toast}
        />
      ))}
    </div>
  );
}

function RequestCard({ rq, expanded, onToggle, onStage, onChanged, toast }) {
  const [lines, setLines] = useState(rq.lines);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setLines(rq.lines); }, [rq.lines]);

  async function addLine(direction, picked) {
    if (!picked?.description) return;
    setBusy(true);
    try {
      await api.addLine(rq.activity_id, { direction, ...picked, qty: 1 });
      const fresh = await api.requestOne(rq.activity_id);
      setLines(fresh.request.lines);
      onChanged?.();
    } catch (err) {
      toast(`Could not add the item — ${err.message}`, null, "error");
    } finally {
      setBusy(false);
    }
  }

  async function setQty(line, qty) {
    try {
      await api.updateLine(rq.activity_id, line.line_id, { qty });
      setLines((cur) => cur.map((l) => (l.line_id === line.line_id ? { ...l, qty } : l)));
    } catch (err) {
      toast(`Could not update — ${err.message}`, null, "error");
    }
  }

  async function remove(line) {
    try {
      await api.removeLine(rq.activity_id, line.line_id);
      setLines((cur) => cur.filter((l) => l.line_id !== line.line_id));
      onChanged?.();
    } catch (err) {
      toast(`Could not remove — ${err.message}`, null, "error");
    }
  }

  const returned = lines.filter((l) => l.direction === "returned");
  const requested = lines.filter((l) => l.direction === "requested");

  return (
    <div className={`card request${expanded ? " open" : ""}`}>
      <h2>
        <button type="button" className="ghostbtn" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? "▾" : "▸"}{" "}
          {rq.store_code ? (
            <span className="code">{rq.store_code}</span>
          ) : (
            <span className="code muted">no store</span>
          )}
          {rq.contact_name && <span className="what">{rq.contact_name}</span>}
        </button>
        <span className="cnt">
          {returned.length} back · {requested.length} wanted
        </span>
        <span className="push mono">{String(rq.occurred_at).slice(0, 10)}</span>
      </h2>

      <div className="stages">
        {Object.entries(STAGE_LABEL).map(([key, label], i) => (
          <button
            key={key}
            type="button"
            className={`stage${rq.stage === key ? " on" : ""}${i < rq.stage_index ? " past" : ""}`}
            onClick={() => onStage(rq.activity_id, key)}
            title={`Mark as ${label}`}
          >
            {label}
          </button>
        ))}
      </div>

      {expanded && (
        <div className="body">
          {rq.note && <p className="note">{rq.note}</p>}
          {rq.order_number && (
            <p className="note">
              Order <Link to={`/orders/${rq.order_number}`} className="code">{rq.order_number}</Link>
            </p>
          )}

          <div className="twolists">
            <LineList
              title="Going back"
              hint="What the store is returning"
              lines={returned}
              onAdd={(p) => addLine("returned", p)}
              onQty={setQty}
              onRemove={remove}
              busy={busy}
            />
            <LineList
              title="Wanted"
              hint="What they have asked for"
              lines={requested}
              onAdd={(p) => addLine("requested", p)}
              onQty={setQty}
              onRemove={remove}
              busy={busy}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function LineList({ title, hint, lines, onAdd, onQty, onRemove, busy }) {
  return (
    <div className="linelist">
      <h3>
        {title} <span className="cnt">{lines.length}</span>
      </h3>
      <p className="hint">{hint}</p>

      {lines.map((l) => (
        <div className="line" key={l.line_id}>
          <input
            className="qty mono"
            type="number"
            min="0"
            value={l.qty ?? ""}
            onChange={(e) => onQty(l, e.target.value === "" ? null : Number(e.target.value))}
            aria-label={`Quantity for ${l.description}`}
          />
          <span className="nm">{l.description}</span>
          {!l.product_id && <span className="tag">free text</span>}
          <button type="button" className="x" onClick={() => onRemove(l)} aria-label={`Remove ${l.description}`}>
            ×
          </button>
        </div>
      ))}

      <ProductPicker onPick={onAdd} placeholder={busy ? "Adding…" : "Add an item"} />
    </div>
  );
}
