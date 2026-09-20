import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";

/**
 * Section 4.4 — the daily stock check.
 *
 * Thirty seconds is the budget. Everything here serves that:
 *
 *   - it opens with yesterday's out-of-stock list already ticked, because most
 *     days the answer is "same as yesterday" and she should be able to save
 *     without touching anything
 *   - the filter box takes focus on load, so typing "zyn" narrows 289 SKUs to
 *     a handful without reaching for the mouse
 *   - only the changes are shown in the save bar, so she can see at a glance
 *     that she has ticked what she meant to
 *   - "N days out" sits beside each SKU, which is how a persistent problem
 *     stops being invisible
 */
export default function Stock({ toast }) {
  const [data, setData] = useState(null);
  const [out, setOut] = useState(() => new Set());
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const filterRef = useRef(null);
  const initial = useRef(new Set());

  const load = useCallback(async () => {
    const d = await api.stockToday();
    setData(d);
    const set = new Set();
    for (const g of d.groups) for (const i of g.items) if (i.out) set.add(i.product_id);
    setOut(set);
    initial.current = new Set(set);
  }, []);

  useEffect(() => {
    load().catch(() => toast("Could not load the stock list", null, "error"));
  }, [load, toast]);

  useEffect(() => {
    filterRef.current?.focus();
  }, [data && 1]);

  const items = useMemo(() => {
    if (!data) return [];
    return data.groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.name })));
  }, [data]);

  const term = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!term) return items;
    const words = term.split(/\s+/);
    return items.filter((i) => {
      const hay = `${i.description} ${i.brand_group || ""} ${i.brand || ""} ${i.flavour || ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [items, term]);

  const grouped = useMemo(() => {
    const m = new Map();
    for (const i of visible) {
      if (!m.has(i.group)) m.set(i.group, []);
      m.get(i.group).push(i);
    }
    return [...m.entries()];
  }, [visible]);

  const added = [...out].filter((p) => !initial.current.has(p));
  const removed = [...initial.current].filter((p) => !out.has(p));
  const changed = added.length + removed.length;
  const byId = useMemo(() => new Map(items.map((i) => [i.product_id, i])), [items]);

  function toggle(id) {
    setOut((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const res = await api.saveStock([...out]);
      initial.current = new Set(out);
      toast(
        res.added || res.removed
          ? `Saved — ${res.added} newly out, ${res.removed} back in stock`
          : "Saved — nothing changed since the last check",
        `${res.out} of ${data.totals.skus} SKUs out`
      );
      await load();
    } catch (err) {
      toast(`Could not save — ${err.message}`, null, "error");
    } finally {
      setSaving(false);
    }
  }

  if (!data) return <div><div className="empty">Loading the stock list…</div></div>;

  return (
    <div className="stock">
      <div className="stockbar">
        <div className="sb-left">
          <h1>Daily stock check</h1>
          <span className="sub">
            {data.already_checked ? "checked today" : "not done today"}
            {data.previous_check ? ` · last check ${data.previous_check}` : ""}
          </span>
        </div>

        <input
          ref={filterRef}
          className="field"
          placeholder="Filter — type a brand or flavour"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter SKUs"
        />

        <div className="sb-count">
          <strong>{out.size}</strong> of {data.totals.skus} out
        </div>

        <button type="button" className="btn primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : changed ? `Save ${changed} change${changed === 1 ? "" : "s"}` : "Save"}
        </button>
      </div>

      {changed > 0 && (
        <div className="diffbar">
          {added.length > 0 && (
            <span className="d-out">
              <strong>{added.length}</strong> newly out:{" "}
              {added.slice(0, 4).map((p) => byId.get(p)?.description).filter(Boolean).join(", ")}
              {added.length > 4 ? ` +${added.length - 4}` : ""}
            </span>
          )}
          {removed.length > 0 && (
            <span className="d-in">
              <strong>{removed.length}</strong> back in:{" "}
              {removed.slice(0, 4).map((p) => byId.get(p)?.description).filter(Boolean).join(", ")}
              {removed.length > 4 ? ` +${removed.length - 4}` : ""}
            </span>
          )}
        </div>
      )}

      {grouped.length === 0 && <div className="empty">Nothing matches “{filter}”.</div>}

      {grouped.map(([name, list]) => {
        const shut = collapsed.has(name) && !term;
        const outHere = list.filter((i) => out.has(i.product_id)).length;
        return (
          <div className="card group" key={name}>
            <h2>
              <button
                type="button"
                className="ghostbtn"
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(name)) n.delete(name);
                    else n.add(name);
                    return n;
                  })
                }
                aria-expanded={!shut}
              >
                {shut ? "▸" : "▾"} {name}
              </button>
              <span className="cnt">
                {outHere > 0 ? `${outHere} out` : "all in stock"} · {list.length} SKUs
              </span>
            </h2>
            {!shut && (
              <div className="skus">
                {list.map((i) => {
                  const isOut = out.has(i.product_id);
                  return (
                    <label className={`sku${isOut ? " isout" : ""}`} key={i.product_id}>
                      <input
                        type="checkbox"
                        checked={isOut}
                        onChange={() => toggle(i.product_id)}
                      />
                      <span className="box" />
                      <span className="nm">{i.description}</span>
                      {i.strength && <span className="mt">{i.strength}</span>}
                      {isOut && i.days_out > 1 && (
                        <span className={`days${i.days_out >= 7 ? " bad" : ""}`}>
                          {i.days_out} days out
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
