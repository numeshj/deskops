import { Link } from "react-router-dom";

const COLOURS = {
  call: "var(--s1)",
  order: "var(--s2)",
  issue: "var(--s3)",
  two_p: "var(--s4)",
  replacement: "var(--s5)",
  credit: "var(--ink-3)",
  stand: "var(--ink-3)",
  request: "var(--accent)",
  other: "var(--line-2)",
};

function timeOf(value) {
  if (!value) return "";
  const s = String(value);
  return s.includes(" ") ? s.split(" ")[1].slice(0, 5) : s.slice(11, 16);
}

export default function ActivityRow({ a, showDate, onResolve, isNew }) {
  const bits = [];
  if (a.contact_name || a.contact_freetext) bits.push(a.contact_name || a.contact_freetext);
  if (a.order_number) bits.push(`order ${a.order_number}`);
  if (a.related_order_number) bits.push(`2p ${a.related_order_number}`);
  if (a.detail?.carrier) bits.push(a.detail.carrier);
  if (a.detail?.units) bits.push(`${a.detail.units} units`);
  if (a.detail?.amount != null) bits.push(`£${(a.detail.amount / 100).toFixed(2)}`);
  if (a.detail?.product) bits.push(a.detail.product);
  if (a.detail?.advised_by) bits.push(`advised by ${a.detail.advised_by}`);
  if (a.note) bits.push(a.note);

  return (
    <div className={`entry${isNew ? " isnew" : ""}`}>
      <div className="t mono">
        {showDate ? String(a.occurred_at).slice(5, 10).replace("-", "/") : timeOf(a.occurred_at)}
      </div>
      <div className="stripe" style={{ background: COLOURS[a.work_type_id] || "var(--line-2)" }} />
      <div className="main">
        <div className="l1">
          {a.store_code ? (
            <Link className="code" to={`/stores/${a.store_id || ""}`}>
              {a.store_code}
            </Link>
          ) : null}
          <span className="what">{a.work_type_label}</span>
          {a.reason && <span className="tag">{a.reason}</span>}
          {a.unlisted && <span className="tag unlisted">unlisted</span>}
          {a.is_draft && <span className="tag draft">draft</span>}
          {a.follow_up && <span className="tag follow">follow up</span>}
          {a.age_days != null && a.age_days >= 8 && <span className="tag draft">{a.age_days}d</span>}
        </div>
        {bits.length > 0 && <div className="l2">{bits.join(" · ")}</div>}
      </div>
      {onResolve ? (
        <button type="button" className="btn sm ghost" onClick={() => onResolve(a)}>
          Done
        </button>
      ) : (
        <div className="secs mono">{a.capture_seconds ? `${Number(a.capture_seconds).toFixed(1)}s` : ""}</div>
      )}
    </div>
  );
}
