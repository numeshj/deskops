import { useCallback, useEffect, useState } from "react";
import ActivityRow from "../components/ActivityRow.jsx";
import StorePicker from "../components/StorePicker.jsx";
import { api } from "../lib/api.js";

/**
 * T16 — the drafts tray.
 *
 * She already pre-numbers blank spreadsheet rows to fill in later, so this is
 * that habit built properly. It is also how the missing store codes finally
 * get captured: not by forcing her mid-call, but by asking when she has ten
 * free seconds.
 */
export default function Drafts({ toast }) {
  const [drafts, setDrafts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [store, setStore] = useState(null);

  const load = useCallback(() => {
    api.drafts().then((d) => setDrafts(d.drafts)).catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function complete(a) {
    if (!store) return;
    await api.update(a.activity_id, { store_id: store.store_id, is_draft: false });
    toast("Completed", store.code_display);
    setEditing(null);
    setStore(null);
    load();
  }

  return (
    <div className="card">
      <h2>
        Drafts <span className="cnt">{drafts.length} waiting</span>
        <span className="push">records saved without a store</span>
      </h2>
      {drafts.length === 0 && <div className="empty">No drafts. Everything logged is complete.</div>}
      {drafts.map((a) => (
        <div key={a.activity_id}>
          <div
            role="button"
            tabIndex={0}
            onClick={() => { setEditing(editing === a.activity_id ? null : a.activity_id); setStore(null); }}
            onKeyDown={(e) => e.key === "Enter" && setEditing(a.activity_id)}
            style={{ cursor: "pointer" }}
          >
            <ActivityRow a={a} showDate />
          </div>
          {editing === a.activity_id && (
            <div className="row" style={{ padding: "0 14px 14px", gap: 10 }}>
              <div style={{ flex: "0 0 240px" }}>
                <StorePicker value={store} onChange={setStore} />
              </div>
              <button className="btn primary" disabled={!store} onClick={() => complete(a)}>
                Attach store
              </button>
              <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
