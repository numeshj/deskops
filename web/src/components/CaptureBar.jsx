import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import StorePicker from "./StorePicker.jsx";
import { api } from "../lib/api.js";
import { enqueue } from "../lib/queue.js";

/**
 * The capture bar — tickets T7 through T14.
 *
 * The benchmark is a spreadsheet row: type, tab, tab, Enter. Anything slower
 * gets abandoned, so the rules here are strict:
 *   - a normal record is three interactions (store, chip, Enter)
 *   - defaults are applied server-side, so nothing has to be chosen
 *   - the store stays held for 60s, because one call often makes three records
 *   - "Other" is always one tap away and always saves a valid record
 */

const STICKY_MS = 60_000;

const FIELD_SPECS = {
  order: { key: "order_number", label: "Order number", ph: "11043984", mono: true },
  related_order: { key: "related_order_number", label: "2p order", ph: "11124766", mono: true },
  carrier: { key: "carrier", label: "Carrier", options: ["DPD", "DX", "Evri"] },
  qty: { key: "units", label: "Units", ph: "5", mono: true },
  amount: { key: "amount", label: "Credit £", ph: "21.38", mono: true },
  product: { key: "product", label: "Product", ph: "SKE Bar 600 Prefilled Pods", wide: true },
};

// which extra fields each work type shows — never more than three
const TYPE_FIELDS = {
  call: [],
  order: ["order"],
  issue: ["order", "carrier"],
  two_p: ["order", "related_order"],
  replacement: ["product", "qty", "order"],
  credit: ["amount"],
  stand: ["order"],
  request: ["order"],
  other: [],
};

export default function CaptureBar({ workTypes, onSaved, onCluster }) {
  const [store, setStore] = useState(null);
  const [typeId, setTypeId] = useState(null);
  const [reasonId, setReasonId] = useState(null);
  const [otherText, setOtherText] = useState("");
  const [extra, setExtra] = useState({});
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [held, setHeld] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [addingType, setAddingType] = useState(false);
  const [newTypeLabel, setNewTypeLabel] = useState("");
  const [addingTypeBusy, setAddingTypeBusy] = useState(false);
  const newTypeInput = useRef(null);

  const started = useRef(0);
  const holdUntil = useRef(0);
  const last = useRef(null);
  const storeInput = useRef(null);
  const otherInput = useRef(null);

  const type = useMemo(
    () => workTypes.find((t) => t.work_type_id === typeId) || null,
    [workTypes, typeId]
  );

  /* ----------------------------------------------------------- the timer */

  const touch = useCallback(() => {
    if (!started.current) started.current = performance.now();
  }, []);

  useEffect(() => {
    if (!started.current) return undefined;
    const id = setInterval(() => setElapsed((performance.now() - started.current) / 1000), 100);
    return () => clearInterval(id);
  }, [elapsed === 0 ? started.current : 1]);

  useEffect(() => {
    if (!started.current) setElapsed(0);
  }, [typeId, reasonId]);

  /* ------------------------------------------------------- sticky store */

  useEffect(() => {
    if (!held) return undefined;
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((holdUntil.current - Date.now()) / 1000));
      setHeld(left);
      if (left <= 0) {
        setStore(null);
        holdUntil.current = 0;
      }
    }, 250);
    return () => clearInterval(id);
  }, [held]);

  function holdStore() {
    holdUntil.current = Date.now() + STICKY_MS;
    setHeld(Math.round(STICKY_MS / 1000));
  }

  function releaseStore() {
    holdUntil.current = 0;
    setHeld(0);
    setStore(null);
    storeInput.current?.focus();
  }

  /* -------------------------------------------------------------- reset */

  const reset = useCallback((keepStore) => {
    setTypeId(null);
    setReasonId(null);
    setOtherText("");
    setExtra({});
    setNote("");
    setFollowUp(false);
    started.current = 0;
    setElapsed(0);
    if (!keepStore) setStore(null);
  }, []);

  /* --------------------------------------------------------------- save */

  const canSave = !!typeId && !saving;

  const save = useCallback(async () => {
    if (!typeId || saving) return;
    setSaving(true);
    const seconds = started.current ? (performance.now() - started.current) / 1000 : null;

    const detail = {};
    for (const spec of TYPE_FIELDS[typeId] || []) {
      const f = FIELD_SPECS[spec];
      if (!f) continue;
      const v = extra[f.key];
      if (v == null || v === "") continue;
      if (f.key === "order_number" || f.key === "related_order_number") continue;
      detail[f.key] = f.key === "amount" ? Math.round(Number(v) * 100) : v;
    }

    const payload = {
        work_type_id: typeId,
        store_id: store?.store_id || null,
        reason_id: reasonId === "__other__" ? null : reasonId,
        reason_freetext: reasonId === "__other__" ? otherText.trim() : null,
        order_number: extra.order_number || null,
        related_order_number: extra.related_order_number || null,
        note: note.trim() || null,
        detail: Object.keys(detail).length ? detail : null,
        follow_up: followUp,
        capture_seconds: seconds ? Math.max(0.5, Number(seconds.toFixed(2))) : null,
        // no allow_missing_store: a record with no store deliberately lands in
        // the drafts tray. That is how the 68% store-coverage gap gets closed —
        // not by blocking her mid-call, but by asking when she has ten seconds.
    };

    try {
      const res = await api.save(payload);

      const keep = store;
      reset(true);
      if (keep) holdStore();
      last.current = { typeId, reasonId, store: keep, otherText };

      onSaved?.(res.activity, seconds);
      if (res.cluster) onCluster?.(res.cluster);
    } catch (err) {
      // The server refusing the data (4xx) is a real error she should see.
      // Anything else — offline, a cold start, a 502 from a waking container —
      // must never lose the record or slow her down. Queue it and move on.
      const isRejection = err?.status >= 400 && err?.status < 500 && err.status !== 408 && err.status !== 429;
      if (isRejection) {
        onSaved?.(null, null, err);
      } else {
        enqueue(payload);
        const keep = store;
        reset(true);
        if (keep) holdStore();
        last.current = { typeId, reasonId, store: keep, otherText };
        onSaved?.(null, seconds, null, "Saved on this device — will sync");
      }
    } finally {
      setSaving(false);
    }
  }, [typeId, saving, store, reasonId, otherText, extra, note, followUp, reset, onSaved, onCluster]);

  /* ------------------------------------------------------- new task type */

  /**
   * A whole new chip in "What happened", not another reason under an
   * existing one. Open to her the same way adding a reason already is (spec
   * 6.7) — the desk's work growing a new category is exactly the kind of
   * thing she notices before anyone else does.
   */
  async function addWorkType() {
    const label = newTypeLabel.trim();
    if (!label || addingTypeBusy) return;
    setAddingTypeBusy(true);
    try {
      const res = await api.addWorkType(label);
      window.dispatchEvent(new Event("deskops:vocab-changed"));
      setTypeId(res.work_type_id);
      setReasonId(null);
      setNewTypeLabel("");
      setAddingType(false);
      onSaved?.(null, null, null, `"${label}" added — pick it above`);
    } catch (err) {
      onSaved?.(null, null, null, err?.data?.error === "already_exists" ? "That already exists" : `Could not add it — ${err.message}`);
    } finally {
      setAddingTypeBusy(false);
    }
  }

  /* --------------------------------------------------------- same again */

  const sameAgain = useCallback(() => {
    if (!last.current) return;
    touch();
    setTypeId(last.current.typeId);
    setReasonId(last.current.reasonId);
    setOtherText(last.current.otherText || "");
    if (last.current.store) {
      setStore(last.current.store);
      holdStore();
    }
  }, [touch]);

  /* ---------------------------------------------------------- shortcuts */

  useEffect(() => {
    function onKey(e) {
      const el = document.activeElement;
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(el?.tagName || "");

      if (e.key === "/" && !inField) {
        e.preventDefault();
        storeInput.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        reset(false);
        return;
      }
      if (e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        sameAgain();
        return;
      }
      if (e.key === "Enter" && canSave) {
        // the store picker stops propagation while its list is open
        e.preventDefault();
        save();
        return;
      }
      if (!inField && /^[1-9]$/.test(e.key)) {
        const t = workTypes[Number(e.key) - 1];
        if (!t) return;
        touch();
        setTypeId((cur) => (cur === t.work_type_id ? null : t.work_type_id));
        setReasonId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canSave, save, sameAgain, reset, workTypes, touch]);

  /* -------------------------------------------------------------- paste */

  async function onPaste(e) {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    if (!text.trim()) return;
    touch();
    try {
      const found = await api.parsePaste(text);
      const bits = [];
      if (found.orderNumber) {
        setExtra((x) => ({ ...x, order_number: x.order_number || found.orderNumber }));
        bits.push(`order ${found.orderNumber}`);
      }
      if (found.store) {
        setStore(found.store);
        bits.push(found.store.code_display);
      }
      if (found.trackingNo) {
        setExtra((x) => ({ ...x, tracking: found.trackingNo }));
        bits.push("tracking");
      }
      if (bits.length) onSaved?.(null, null, null, `Detected ${bits.join(" · ")}`);
    } catch {
      /* paste detection is a convenience, never a blocker */
    }
  }

  /* --------------------------------------------------------------- view */

  const reasons = type?.reasons || [];
  const fields = (TYPE_FIELDS[typeId] || []).map((k) => FIELD_SPECS[k]).filter(Boolean);

  return (
    <div className="capture">
      <div className="cap-head">
        <span className="lbl">Capture</span>
        {store && held > 0 && (
          <span className="sticky-pill">
            <span className="mono">{store.code_display}</span> held
            <span className="cd mono">{held}s</span>
            <button type="button" className="x" onClick={releaseStore} aria-label="Release store">
              ×
            </button>
          </span>
        )}
        <span className={`timer ${started.current ? "live" : ""}`}>
          <span className="dot" />
          {started.current ? `${elapsed.toFixed(1)}s on this record` : "idle"}
        </span>
      </div>

      <div className="cap-body">
        <div className="row1">
          <StorePicker
            value={store}
            inputRef={storeInput}
            onChange={(s) => {
              touch();
              setStore(s);
              if (s) holdStore();
            }}
            onPicked={() => {
              document.getElementById("type-chip-0")?.focus();
            }}
          />
          <div className="grow" style={{ minWidth: 200 }}>
            <input
              className="field"
              placeholder="Note (optional) — or paste anything here"
              value={note}
              autoComplete="off"
              onChange={(e) => {
                touch();
                setNote(e.target.value);
              }}
              onPaste={onPaste}
              aria-label="Note"
            />
          </div>
        </div>

        <div className="chiplabel">What happened</div>
        <div className="chipset">
          {workTypes.map((t, i) => (
            <button
              key={t.work_type_id}
              id={`type-chip-${i}`}
              type="button"
              className="chip"
              aria-pressed={typeId === t.work_type_id}
              onClick={() => {
                touch();
                setTypeId((c) => (c === t.work_type_id ? null : t.work_type_id));
                setReasonId(null);
              }}
            >
              {t.label}
              <span className="n">{i + 1}</span>
            </button>
          ))}
          <button
            type="button"
            className="chip addnew"
            onClick={() => {
              setAddingType((v) => !v);
              setTimeout(() => newTypeInput.current?.focus(), 0);
            }}
          >
            + New task
          </button>
        </div>

        {addingType && (
          <div className="otherrow">
            <input
              ref={newTypeInput}
              className="field"
              placeholder="Name the new task, e.g. Pallet check"
              value={newTypeLabel}
              autoComplete="off"
              disabled={addingTypeBusy}
              onChange={(e) => setNewTypeLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); addWorkType(); }
                if (e.key === "Escape") { e.preventDefault(); setAddingType(false); setNewTypeLabel(""); }
              }}
              aria-label="New task type name"
            />
            <button type="button" className="btn primary sm" disabled={!newTypeLabel.trim() || addingTypeBusy} onClick={addWorkType}>
              {addingTypeBusy ? "Adding…" : "Add"}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => { setAddingType(false); setNewTypeLabel(""); }}>
              Cancel
            </button>
            <div className="hint">
              Becomes a chip here immediately, for everyone — captures with just a store and a note.
            </div>
          </div>
        )}

        <div className="chiplabel">
          {type ? `Detail — ${type.label.toLowerCase()}` : "Detail"}
        </div>
        <div className="chipset">
          {!type && (
            <button type="button" className="chip ghost" disabled>
              Pick what happened first
            </button>
          )}
          {type &&
            reasons.map((r) => (
              <button
                key={r.reason_id}
                type="button"
                className="chip"
                aria-pressed={reasonId === r.reason_id}
                onClick={() => {
                  touch();
                  setReasonId((c) => (c === r.reason_id ? null : r.reason_id));
                  setOtherText("");
                }}
              >
                {r.label}
              </button>
            ))}
          {type && (
            <button
              type="button"
              className="chip other"
              aria-pressed={reasonId === "__other__"}
              onClick={() => {
                touch();
                setReasonId((c) => (c === "__other__" ? null : "__other__"));
                setTimeout(() => otherInput.current?.focus(), 0);
              }}
            >
              Other
            </button>
          )}
        </div>

        {reasonId === "__other__" && (
          <div className="otherrow">
            <input
              ref={otherInput}
              className="field"
              placeholder="What was it? A few words is enough"
              value={otherText}
              autoComplete="off"
              onChange={(e) => {
                touch();
                setOtherText(e.target.value);
              }}
              aria-label="Describe the work"
            />
            <div className="hint">
              Saves as a normal record. Log the same thing three times and it turns up in
              Unlisted work, ready to become its own chip.
            </div>
          </div>
        )}

        {fields.length > 0 && (
          <div className="row2">
            {fields.map((f) => (
              <div key={f.key} className={`f${f.wide ? " wide" : ""}`}>
                <label className="lbl" htmlFor={`f-${f.key}`}>
                  {f.label}
                </label>
                {f.options ? (
                  <select
                    id={`f-${f.key}`}
                    className="field"
                    value={extra[f.key] || ""}
                    onChange={(e) => {
                      touch();
                      setExtra((x) => ({ ...x, [f.key]: e.target.value }));
                    }}
                  >
                    <option value="">—</option>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`f-${f.key}`}
                    className={`field${f.mono ? " mono" : ""}`}
                    placeholder={f.ph}
                    autoComplete="off"
                    value={extra[f.key] || ""}
                    onChange={(e) => {
                      touch();
                      setExtra((x) => ({ ...x, [f.key]: e.target.value }));
                    }}
                    onPaste={onPaste}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="cap-foot">
        <label className="toggle">
          <input
            type="checkbox"
            checked={followUp}
            onChange={(e) => {
              touch();
              setFollowUp(e.target.checked);
            }}
          />
          <span className="box" />
          Needs follow-up
        </label>
        <button type="button" className="btn" onClick={sameAgain} disabled={!last.current}>
          Same again
        </button>
        <button type="button" className="btn primary push" onClick={save} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
          <span className="kbd">⏎</span>
        </button>
      </div>
    </div>
  );
}
