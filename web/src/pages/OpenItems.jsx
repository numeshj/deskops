import { useCallback, useEffect, useState } from "react";
import ActivityRow from "../components/ActivityRow.jsx";
import { api } from "../lib/api.js";

/**
 * T17 — the queue that replaces scanning 1,500 spreadsheet rows for the
 * word "Wait". Grouped by age so the oldest surfaces first.
 */
export default function OpenItems({ toast }) {
  const [data, setData] = useState({ items: [], buckets: {}, total: 0 });

  const load = useCallback(() => {
    api.open().then(setData).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function resolve(a) {
    await api.resolve(a.activity_id);
    toast("Closed", a.store_code || a.work_type_label);
    load();
  }

  const groups = [
    ["Older than a week", data.items.filter((i) => i.age_days > 7)],
    ["This week", data.items.filter((i) => i.age_days > 0 && i.age_days <= 7)],
    ["Today", data.items.filter((i) => i.age_days === 0)],
  ];

  return (
    <>
      <div className="counters" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
        <div className="ct flag"><div className="v tnum">{data.buckets.older || 0}</div><div className="k">Older than a week</div></div>
        <div className="ct"><div className="v tnum">{data.buckets.week || 0}</div><div className="k">This week</div></div>
        <div className="ct"><div className="v tnum">{data.buckets.today || 0}</div><div className="k">Today</div></div>
      </div>

      {data.total === 0 && (
        <div className="card"><div className="empty">Nothing open. Everything she started is finished.</div></div>
      )}

      {groups.map(([title, items]) =>
        items.length ? (
          <div className="card" key={title} style={{ marginBottom: 14 }}>
            <h2>{title} <span className="cnt">{items.length}</span><span className="push">oldest first</span></h2>
            <div>
              {items.map((a) => (
                <ActivityRow key={a.activity_id} a={a} showDate onResolve={resolve} />
              ))}
            </div>
          </div>
        ) : null
      )}
    </>
  );
}
