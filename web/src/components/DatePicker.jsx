import { useEffect, useRef, useState } from "react";
import DropdownPortal from "./DropdownPortal.jsx";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * A 6-week grid of ISO dates for the given year/month (1-12), Monday-first —
 * the desk works Monday to Friday, same convention as windowFor() on the
 * server. Includes the leading/trailing days from neighbouring months
 * needed to fill full weeks, marked with inMonth: false.
 */
function buildGrid(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0
  const start = new Date(Date.UTC(year, month - 1, 1 - mondayOffset));
  const days = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i));
    days.push({
      iso: iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() + 1 === month && d.getUTCFullYear() === year,
    });
  }
  return days;
}

/**
 * A month-grid date picker, opened from a button rather than a native
 * <input type="date"> — a native picker cannot mark which days actually
 * hold data, and that is the point of this one. The desk works weekdays, so
 * most weekends (and plenty of other gaps) are genuinely empty; without a
 * marker, every date looks equally worth trying and an empty one reads as
 * broken rather than as a quiet day.
 */
export default function DatePicker({ value, today, onSelect, activeDays, min, max }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const [y, m] = (value || today).split("-").map(Number);
    return { y, m };
  });
  const box = useRef(null);
  const portal = useRef(null);

  // Jump the visible month back to whatever is selected each time it opens,
  // rather than staying wherever browsing last left it.
  useEffect(() => {
    if (!open) return;
    const [y, m] = (value || today).split("-").map(Number);
    setView({ y, m });
  }, [open, value, today]);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      const inBox = box.current && box.current.contains(e.target);
      const inPortal = portal.current && portal.current.contains(e.target);
      if (!inBox && !inPortal) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function changeMonth(dir) {
    setView(({ y, m }) => {
      let nm = m + dir;
      let ny = y;
      if (nm < 1) { nm = 12; ny -= 1; }
      if (nm > 12) { nm = 1; ny += 1; }
      return { y: ny, m: nm };
    });
  }

  const days = buildGrid(view.y, view.m);

  return (
    <div className="datepick" ref={box}>
      <button type="button" className="btn sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span aria-hidden="true">📅 </span>Pick a date
      </button>

      <DropdownPortal anchorRef={box} portalRef={portal} open={open}>
        <div className="datepop" role="dialog" aria-label="Choose a date">
          <div className="datepop-head">
            <button type="button" className="nav" onClick={() => changeMonth(-1)} aria-label="Previous month">‹</button>
            <span>{MONTHS[view.m - 1]} {view.y}</span>
            <button type="button" className="nav" onClick={() => changeMonth(1)} aria-label="Next month">›</button>
          </div>

          <div className="datepop-grid dow" aria-hidden="true">
            {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
          </div>

          <div className="datepop-grid">
            {days.map((d) => {
              const hasData = activeDays?.has(d.iso);
              const disabled = (min && d.iso < min) || (max && d.iso > max);
              const cls = [
                !d.inMonth && "out",
                d.iso === today && "today",
                d.iso === value && "sel",
                hasData && "hasdata",
              ].filter(Boolean).join(" ");
              return (
                <button
                  key={d.iso}
                  type="button"
                  disabled={disabled}
                  className={cls}
                  onClick={() => { onSelect(d.iso); setOpen(false); }}
                  title={disabled ? "Outside the recorded range" : hasData ? "Has records" : "No records this day"}
                >
                  {d.day}
                </button>
              );
            })}
          </div>

          <div className="datepop-legend">
            <span className="dot" aria-hidden="true" /> has records
          </div>
        </div>
      </DropdownPortal>
    </div>
  );
}
