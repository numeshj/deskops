import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { Figure, Bars, HBars, Stat, Table, fmt } from "../components/Charts.jsx";

/**
 * The impact page — the one Yashoda asked for, to show her company what the
 * order desk actually absorbs.
 *
 * It is built to survive a sceptic, which means three things it deliberately
 * does NOT do:
 *
 *   - It does not put a "full-time equivalent" percentage at the top. The
 *     obvious calculation lands around 13%, which is not what she works — it
 *     is what the old spreadsheet happened to record, on the 302 days out of
 *     600 that anything was written down. Leading with it would lose the
 *     argument in the first ten seconds.
 *   - It does not hide the gap. Roughly half the migrated history has no store
 *     code, and the page says so, in its own section, with the number. That
 *     omission is evidence FOR her: the record undercounts the work.
 *   - It does not ask anyone to trust an estimate. The only estimated figure is
 *     hours, the minutes behind it are on screen, and the reader can change
 *     them and watch the total move.
 *
 * Everything else is a count of rows someone can go and check.
 */
export default function Impact({ toast }) {
  const [data, setData] = useState(null);
  const [minutes, setMinutes] = useState(null);
  const [showAssumptions, setShowAssumptions] = useState(false);

  const load = useCallback(async (mins) => {
    try {
      setData(await api.impact(mins));
    } catch (err) {
      toast(`Could not load the impact page — ${err.message}`, null, "error");
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (data && !minutes) setMinutes(data.effort.assumptions.minutes);
  }, [data, minutes]);

  function changeMinutes(key, value) {
    const next = { ...minutes, [key]: Math.max(0, Math.min(240, Number(value) || 0)) };
    setMinutes(next);
    load(next);
  }

  if (!data) return <div><div className="empty">Loading…</div></div>;

  const { span, volume, effort, quality, charts, caveats } = data;
  const monthly = charts.monthly.map((m) => ({ ...m, label: m.ym.slice(2) }));

  return (
    <div className="impact">
      <div className="pagehead">
        <div>
          <h1>What the order desk handles</h1>
          <span className="sub">
            {span.first_day} to {span.last_day} · {span.active_days} days with activity ·{" "}
            <Link to="/dashboard">back to the dashboard</Link>
          </span>
        </div>
      </div>

      {/* The headline is volume, because volume is countable and arguable by
          nobody. Hours come later, clearly labelled as an estimate. */}
      <div className="herorow">
        <div className="hero">
          <strong>{volume.records.toLocaleString()}</strong>
          <span>pieces of work recorded</span>
        </div>
        <div className="herosub">
          <Stat value={volume.stores_touched} label="stores dealt with" />
          <Stat value={volume.orders_touched.toLocaleString()} label="orders touched" />
          <Stat value={volume.people_spoken_to} label="people on first-name terms" />
          <Stat value={volume.per_active_day} label="records a day" sub="on days with activity" />
        </div>
      </div>

      <Figure
        title="Every month since the record starts"
        note="records logged per month"
        table={<Table head={["Month", "Records", "Days active"]} rows={charts.monthly.map((m) => [m.ym, m.n, m.days])} />}
      >
        <Bars data={monthly} xKey="label" yKey="n" height={170} />
      </Figure>

      <div className="figrow">
        <Figure
          title="What the work is"
          note="records by type"
          table={<Table head={["Type", "Records", "Hours"]} rows={charts.by_type.map((t) => [t.label, t.count, t.hours])} />}
        >
          <HBars data={charts.by_type} labelKey="label" valueKey="count" />
        </Figure>

        <Figure
          title="Where it lands"
          note="the stores she deals with most"
          table={<Table head={["Store", "Records"]} rows={charts.top_stores.map((s) => [s.code_display, s.n])} />}
        >
          <HBars data={charts.top_stores} labelKey="code_display" valueKey="n" />
        </Figure>
      </div>

      {/* ------------------------------------------------------------ hours */}

      <div className="card hours">
        <h2>
          Time on the work
          <span className="cnt">the one estimated figure on this page</span>
        </h2>
        <div className="body">
          <div className="hoursrow">
            <div className="hero small">
              <strong>{effort.total_hours.toLocaleString()}</strong>
              <span>hours of work evidenced</span>
            </div>
            <div className="herosub">
              <Stat value={effort.hours_per_active_day} label="hours a day" sub={`across ${effort.active_days} active days`} />
              <Stat value={effort.working_weeks_spanned} label="weeks spanned" />
            </div>
          </div>

          <p className="basis">{effort.basis}</p>

          <button type="button" className="btn sm" onClick={() => setShowAssumptions((v) => !v)}>
            {showAssumptions ? "Hide the assumptions" : "Show and change the assumptions"}
          </button>

          {showAssumptions && minutes && (
            <div className="assumptions">
              <p className="hint">
                Minutes allowed per job. These are deliberately low. Change any of them and the
                total above moves — an assumption you can argue with is worth more than a number
                you have to take on trust.
              </p>
              <div className="mins">
                {effort.by_type.map((t) => (
                  <label key={t.work_type_id}>
                    <span className="nm">{t.label}</span>
                    <input
                      type="number"
                      min="0"
                      max="240"
                      className="qty mono"
                      value={minutes[t.work_type_id] ?? 0}
                      onChange={(e) => changeMinutes(t.work_type_id, e.target.value)}
                      aria-label={`Minutes per ${t.label}`}
                    />
                    <span className="mt mono">× {t.count.toLocaleString()} = {t.hours}h</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------- quality */}

      <div className="card">
        <h2>Not just volume<span className="cnt">what happened to the work</span></h2>
        <div className="body">
          <div className="stats tight">
            <Stat
              value={quality.resolution_rate == null ? "—" : `${quality.resolution_rate}%`}
              label="delivery issues resolved"
              sub={`${quality.issues_closed} of ${quality.issues_opened}`}
              tone="good"
            />
            <Stat value={quality.stock_days_checked} label="days of stock checked" />
            <Stat value={quality.stock_lines_logged.toLocaleString()} label="out-of-stock lines logged" />
            <Stat value={quality.stock_skus_affected} label="SKUs affected" />
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------- caveats */}

      <div className="card caveat">
        <h2>What this page does not show</h2>
        <div className="body">
          <p>{caveats.note}</p>
          <div className="stats tight">
            <Stat
              value={`${caveats.store_coverage_pct}%`}
              label="records with a store code"
              sub={`${caveats.records_without_store.toLocaleString()} without one`}
            />
            <Stat value={`${caveats.reason_coverage_pct}%`} label="records with a reason" />
          </div>
          <p>
            None of the following reached the old spreadsheet at all, so none of it is counted
            above: time on hold, calls that went unanswered, messages read and dealt with in
            passing, work picked up for colleagues, and anything done on a day too busy to
            write it down. The figures on this page are a floor.
          </p>
        </div>
      </div>
    </div>
  );
}
