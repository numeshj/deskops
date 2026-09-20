import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import DropdownPortal from "./DropdownPortal.jsx";

/**
 * Product lookup for request lines and the campaign grid.
 *
 * Built on the same rule as the store picker, including the stale-list guard:
 * the list is marked stale the moment the text changes, so Enter cannot select
 * a result belonging to an earlier query. That bug cost a wrong store code on a
 * record once already; it is not going to cost a wrong SKU here.
 *
 * A free-typed line with no product is valid and expected — the catalogue has
 * 289 SKUs and stores ask for things that are not in it.
 */
export default function ProductPicker({ onPick, placeholder = "Product or free text", autoFocus }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [rowsFor, setRowsFor] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const box = useRef(null);
  const portal = useRef(null);
  const timer = useRef(null);
  const latest = useRef("");
  const input = useRef(null);

  const load = useCallback(async (term) => {
    latest.current = term;
    try {
      const { products } = await api.products(term, 10);
      if (latest.current !== term) return;
      setRows(products);
      setRowsFor(term);
      setCursor(-1);
    } catch {
      if (latest.current === term) { setRows([]); setRowsFor(term); }
    }
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load(q), q ? 110 : 0);
    return () => clearTimeout(timer.current);
  }, [q, open, load]);

  useEffect(() => {
    const away = (e) => {
      const inBox = box.current && box.current.contains(e.target);
      const inPortal = portal.current && portal.current.contains(e.target);
      if (!inBox && !inPortal) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  const stale = rowsFor !== q;

  function choose(product) {
    onPick({ product_id: product?.product_id || null, description: product?.description || q.trim() });
    setQ("");
    setRows([]);
    setRowsFor("");
    setOpen(false);
    setCursor(-1);
    input.current?.focus();
  }

  function keyDown(e) {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      // A stale list must never be selected from; fall back to the free text,
      // which is always a valid line.
      if (!stale && cursor >= 0 && rows[cursor]) choose(rows[cursor]);
      else if (q.trim()) choose(null);
      return;
    }
    if (!open || !rows.length || stale) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % rows.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + rows.length) % rows.length); }
  }

  return (
    <div className="storebox" ref={box}>
      <input
        ref={input}
        className="field"
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={q}
        aria-label="Product"
        aria-expanded={open}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={keyDown}
      />
      <DropdownPortal anchorRef={box} portalRef={portal} open={open && rows.length > 0}>
        <div className={`sugg${stale ? " stale" : ""}`} role="listbox" aria-busy={stale}>
          {rows.map((p, i) => (
            <button
              key={p.product_id}
              type="button"
              role="option"
              aria-selected={!stale && i === cursor}
              className={!stale && i === cursor ? "on" : ""}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(p)}
            >
              <span className="nm">{p.description}</span>
              {p.brand_group && <span className="hits">{p.brand_group}</span>}
            </button>
          ))}
          {q.trim() && (
            <button type="button" role="option" aria-selected={false} className="freetext" onClick={() => choose(null)}>
              <span className="nm">Use “{q.trim()}” as typed</span>
            </button>
          )}
        </div>
      </DropdownPortal>
    </div>
  );
}
