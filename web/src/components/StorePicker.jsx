import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import DropdownPortal from "./DropdownPortal.jsx";

/**
 * T6 — store picker.
 *
 * Matches code OR contact name: "335" and "Kugan" both find Fs335. Arrow keys
 * move, Enter selects. Shows her most-used stores when empty, which is what
 * makes the blank state useful.
 *
 * The 68% of historical calls with no store code came from this field being
 * slower than the call was moving. Everything here is in service of that.
 */
export default function StorePicker({ value, onChange, onPicked, inputRef, disabled }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [rowsFor, setRowsFor] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const box = useRef(null);
  const portal = useRef(null);
  const timer = useRef(null);
  const localRef = useRef(null);
  const ref = inputRef || localRef;
  const latest = useRef("");

  /**
   * Responses can arrive out of order — she types faster than the network.
   * Without this guard a slow response for "3" can land after the response
   * for "335" and leave the wrong store highlighted under her Enter key.
   */
  const load = useCallback(async (term) => {
    latest.current = term;
    try {
      const { stores } = await api.searchStores(term, 8);
      if (latest.current !== term) return;
      setRows(stores);
      setRowsFor(term);
      setCursor(stores.length === 1 ? 0 : -1);
    } catch {
      if (latest.current === term) { setRows([]); setRowsFor(term); }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
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

  // when the parent clears the selection, clear the text too
  useEffect(() => {
    if (!value) setQ("");
  }, [value]);

  function pick(store) {
    onChange(store);
    setQ("");
    setOpen(false);
    setCursor(-1);
    onPicked?.(store);
  }

  // True while the visible list belongs to an earlier query than what is in
  // the box — the 110ms debounce plus the round trip. Selecting from a stale
  // list is how the wrong store ends up on a record: type "3350" (one match,
  // so the cursor sits on it), add a digit, press Enter inside the gap, and
  // the old match is what gets saved. The response-ordering guard above cannot
  // catch this, because no response is out of order — the list is simply old.
  const stale = rowsFor !== q;

  function keyDown(e) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || !rows.length) return;

    // Swallow Enter rather than selecting the wrong store, and rather than
    // letting it bubble up and save a record with no store at all.
    if (stale && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      // Enter inside an open list selects; it must not bubble up and save
      const target = cursor >= 0 ? rows[cursor] : rows.length === 1 ? rows[0] : null;
      if (target) {
        e.preventDefault();
        e.stopPropagation();
        pick(target);
      }
    }
  }

  return (
    <div className="storebox" ref={box}>
      <input
        id="store-input"
        ref={ref}
        className="field mono"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={value ? "" : "Store — type 335 or a name"}
        value={value ? `${value.code_display}  ·  ${value.contact_name || value.name || ""}`.trim() : q}
        onChange={(e) => {
          if (value) onChange(null);
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          if (!rows.length) load(q);
        }}
        onKeyDown={keyDown}
        aria-label="Store"
        aria-expanded={open}
        aria-autocomplete="list"
      />

      <DropdownPortal
        anchorRef={box}
        portalRef={portal}
        open={open && (rows.length > 0 || (!!q.trim() && !stale))}
      >
        {rows.length > 0 ? (
          <div className={`sugg${stale ? " stale" : ""}`} role="listbox" aria-busy={stale}>
            {!q && <div className="sugghead">Recent</div>}
            {rows.map((s, i) => (
              <button
                key={s.store_id}
                type="button"
                role="option"
                aria-selected={!stale && i === cursor}
                className={!stale && i === cursor ? "on" : ""}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(s)}
              >
                <span className="code">{s.code_display}</span>
                <span className="nm">{s.contact_name || s.name || "—"}</span>
                <span className="hits">{s.mention_count}×</span>
              </button>
            ))}
          </div>
        ) : (
          // Not a dead end: a search that comes up empty is the one moment
          // someone is guaranteed to be thinking about the exact Fs number
          // they need — so hand them straight to adding it rather than
          // leaving nothing to do but clear the field.
          <div className="sugg">
            <div className="sugghead">No matches</div>
            <Link className="sugg-addnew" to="/stores/new">+ Add “{q.trim()}” as a new store</Link>
          </div>
        )}
      </DropdownPortal>
    </div>
  );
}
