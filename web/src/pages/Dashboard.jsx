import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { Figure, Bars, HBars, GroupedBars, Lines, Stat, Table, fmt } from "../components/Charts.jsx";
import DatePicker from "../components/DatePicker.jsx";

/**
 * Section 8 — the dashboard. Day, week, month.
 *
 * Every tab answers the same two questions in the same order: what got done,
 * and what is still waiting. The second half is the one that usually gets left
 * out of dashboards, and it is the half that tells her — and her manager —
 * whether the desk is keeping up or quietly falling behind.
 *
 * Pending figures are deliberately "as of now" rather than scoped to the
 * period. A backlog is a present-tense fact; "items that were open during
 * week 34" is not a number anyone can act on.
 */
/* ------------------------------------------------------------ date walking */

/**
 * Dates as plain YYYY-MM-DD strings, stepped in UTC.
 *
 * Deliberately not `new Date(iso)` arithmetic in local time: on a machine at
 * +05:30 that parses as midnight UTC, displays as the previous evening, and
 * "yesterday" quietly becomes two days ago. ISO strings also compare correctly
 * with < and >, which is the whole of the range logic below.
 */
const isoOf = (dt) =>
  `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;

function todayIso() {
  const t = new Date();                       // her clock, not the server's
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function step(iso, period, dir) {
  const [y, m, d] = iso.split("-").map(Number);
  if (period === "month") {
    // Anchored to the 1st before shifting. Stepping back a month from the 31st
    // otherwise lands on the 3rd of the month after the one you asked for.
    return isoOf(new Date(Date.UTC(y, m - 1 + dir, 1)));
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dir * (period === "week" ? 7 : 1));
  return isoOf(dt);
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** "17 September 2026" — readable, and unambiguous between UK and US order. */
function pretty(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function rangeLabel(period, from, to) {
  if (period === "day") return pretty(from);
  if (period === "month") {
    const [y, m] = from.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  return `${pretty(from)} to ${pretty(to)}`;
}

export default function Dashboard({ toast }) {
  const [period, setPeriod] = useState("day");
  // null means "whatever today is". Only set once she walks backwards.
  const [anchor, setAnchor] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // Every day that holds a record, fetched once. Backs the calendar's dots —
  // without it every date looks equally worth trying, and a genuinely empty
  // weekend is indistinguishable from a broken one.
  const [activeDays, setActiveDays] = useState(null);

  useEffect(() => {
    api.activeDays().then((r) => setActiveDays(new Set(r.days))).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.dashboard(period, anchor));
    } catch (err) {
      toast(`Could not load the dashboard — ${err.message}`, null, "error");
    } finally {
      setLoading(false);
    }
  }, [period, anchor, toast]);

  useEffect(() => { load(); }, [load]);

  const today = todayIso();
  const span = data?.span;

  // Step from the window the server actually returned, not from local state.
  // For a week that is the Monday and for a month the 1st, so stepping it lands
  // squarely on the neighbouring window instead of drifting.
  const here = data ? data.range.from : today;
  const atToday = !data || data.range.to >= today;
  const atStart = !data || !span?.earliest || data.range.from <= span.earliest;

  const goTo = (iso) => setAnchor(iso === today ? null : iso);

  return (
    <div>
      <div className="pagehead">
        <div>
          <h1>Dashboard</h1>
          <span className="sub">
            {data ? rangeLabel(data.period, data.range.from, data.range.to) : "…"}
          </span>
        </div>
        <div className="tabs">
          {["day", "week", "month"].map((p) => (
            <button
              key={p}
              type="button"
              className={`tab${period === p ? " on" : ""}`}
              onClick={() => setPeriod(p)}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
          <Link className="btn" to="/impact">Impact page</Link>
        </div>
      </div>

      {data && (
        <div className="datenav">
          <button
            type="button"
            className="btn sm"
            disabled={atStart}
            onClick={() => goTo(step(here, data.period, -1))}
          >
            {/* No aria-label here. An aria-label REPLACES the text as the
                accessible name, so "Previous day" would have been the name and
                "Previous" the label, and every by-name lookup would miss. The
                chevron is decoration, so it is hidden and the words do the
                naming. */}
            <span aria-hidden="true">‹ </span>Previous {data.period}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={atToday}
            onClick={() => goTo(step(here, data.period, +1))}
          >
            Next {data.period}<span aria-hidden="true"> ›</span>
          </button>
          {anchor && (
            <button type="button" className="btn sm" onClick={() => setAnchor(null)}>
              Back to today
            </button>
          )}
          <DatePicker
            value={here}
            today={today}
            onSelect={goTo}
            activeDays={activeDays}
            min={span?.earliest}
            max={today}
          />
          {span?.earliest && (
            <span className="spannote">
              Records run {pretty(span.earliest)} to {pretty(span.latest)}
            </span>
          )}
        </div>
      )}

      {loading && !data ? (
        <div className="empty">Loading…</div>
      ) : !data ? (
        <div className="empty">No data.</div>
      ) : (
        <>
          {/* An empty window is a fact, not a failure, and the difference has
              to be on screen. Loaded from the workbook, today is genuinely
              empty and every month back to January 2025 is not - so a page of
              zeroes with nothing else on it reads as a broken import. Say
              where the records are and offer to go there. */}
          {data.headline?.total === 0 && span?.latest && span.total > 0 && (
            <div className="card nothinghere">
              <strong>
                Nothing was recorded {data.period === "day" ? "on this day" : `in this ${data.period}`}.
              </strong>
              <p>
                {/* toLocaleString, not the chart fmt(). fmt drops the thousands
                    separator on purpose, because "3,633" on an axis tick is
                    noise - but in a sentence it is exactly what you want. */}
                That is not a loading problem — the database holds {span.total.toLocaleString()} records,
                the most recent on {pretty(span.latest)}.
              </p>
              <button type="button" className="btn" onClick={() => goTo(span.latest)}>
                Go to {pretty(span.latest)}
              </button>
            </div>
          )}

          {/* Switch on data.period, NOT the period state.
              While a new period is loading the old payload is still in hand, and
              rendering Week against a Day payload reaches for charts.by_day,
              which does not exist there — a blank screen mid-click. The data
              says which view it can support; the button only says what was
              asked for. */}
          {data.period === "day" && <Day d={data} />}
          {data.period === "week" && <Week d={data} />}
          {data.period === "month" && <Month d={data} />}
          <Pending d={data} />
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- day */

function Day({ d }) {
  const h = d.headline;
  const [lo, hi] = d.baselines.call_band;
  const band = h.calls < lo ? "under" : h.calls > hi ? "over" : "in";

  return (
    <>
      <div className="stats">
        <Stat
          value={h.calls}
          label="calls"
          sub={`typical day ${lo}–${hi}`}
          tone={band === "in" ? "good" : band === "over" ? "warn" : null}
        />
        <Stat value={h.orders} label="orders placed" />
        <Stat value={h.issues_opened} label="issues opened" sub={`${h.issues_closed} closed`} />
        <Stat value={h.replacements} label="replacements" />
        <Stat value={h.stands} label="stands sent" />
        <Stat value={h.out_of_stock_lines} label="SKUs out" sub={`usual ${d.baselines.oos_lines_per_day}`} />
        <Stat value={h.total} label="records today" />
        <Stat
          value={d.speed.average ? `${d.speed.average}s` : "—"}
          label="per record"
          sub={d.speed.sample ? `${d.speed.sample} timed · sheet took ~${d.speed.baseline_seconds}s` : "nothing timed yet"}
          tone={d.speed.average && d.speed.average < d.speed.baseline_seconds ? "good" : null}
        />
      </div>

      <div className="figrow">
        <Figure
          title="The shape of the day"
          note="records logged, by hour"
          empty={h.total === 0}
          table={<Table head={["Hour", "Records"]} rows={d.charts.timeline.map((t) => [`${t.hour}:00`, t.n])} />}
        >
          <Bars data={d.charts.timeline} xKey="hour" yKey="n" />
        </Figure>

        <Figure
          title="What the work was"
          note="today, by type"
          empty={h.total === 0}
          table={<Table head={["Type", "Records"]} rows={d.charts.mix.map((m) => [m.label, m.n])} />}
        >
          <HBars data={d.charts.mix.filter((m) => m.n > 0)} labelKey="label" valueKey="n" />
        </Figure>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- week */

function Week({ d }) {
  const h = d.headline;
  return (
    <>
      <div className="stats">
        <Stat value={h.calls} label="calls" />
        <Stat value={h.orders} label="orders" />
        <Stat value={h.issues} label="delivery issues" />
        <Stat value={h.stands} label="stands sent" />
        <Stat value={h.credits} label="credits raised" />
        <Stat
          value={h.median_days_to_resolve == null ? "—" : `${h.median_days_to_resolve}d`}
          label="median to resolve"
          sub="median, not mean"
        />
        <Stat value={h.busiest_day || "—"} label="busiest day" />
        <Stat value={h.total} label="records this week" />
      </div>

      <div className="figrow">
        <Figure
          title="Volume by day"
          note="calls, orders and issues"
          empty={h.total === 0}
          table={
            <Table
              head={["Day", "Calls", "Orders", "Issues"]}
              rows={d.charts.by_day.map((x) => [x.date, x.calls, x.orders, x.issues])}
            />
          }
        >
          <GroupedBars
            data={d.charts.by_day}
            xKey="day"
            series={[
              { key: "calls", label: "Calls", colour: "var(--s1)" },
              { key: "orders", label: "Orders", colour: "var(--s2)" },
              { key: "issues", label: "Issues", colour: "var(--s3)" },
            ]}
          />
        </Figure>

        <Figure
          title="Issues by carrier"
          note="counts only — not a failure rate"
          empty={d.charts.carriers.length === 0}
          table={
            <Table
              head={["Carrier", "Issues", "Closed"]}
              rows={d.charts.carriers.map((c) => [c.carrier, c.n, c.closed])}
            />
          }
        >
          <HBars data={d.charts.carriers} labelKey="carrier" valueKey="n" colour="var(--s2)" />
        </Figure>
      </div>

      <div className="figrow">
        <Figure
          title="Why she was called"
          note="top reasons this week"
          empty={d.charts.call_reasons.length === 0}
          table={<Table head={["Reason", "Calls"]} rows={d.charts.call_reasons.map((c) => [c.label, c.n])} />}
        >
          <HBars data={d.charts.call_reasons} labelKey="label" valueKey="n" colour="var(--s1)" />
        </Figure>

        <Figure
          title="Busiest stores"
          note="records against each store"
          empty={d.charts.top_stores.length === 0}
          table={<Table head={["Store", "Records"]} rows={d.charts.top_stores.map((s) => [s.code_display, s.n])} />}
        >
          <HBars data={d.charts.top_stores} labelKey="code_display" valueKey="n" />
        </Figure>
      </div>

      <p className="fignote">
        Carrier counts are counts, not rates. DX showing fewer issues than DPD may simply mean
        fewer DX deliveries — the number of deliveries each carrier made is not in this system,
        so the chart cannot settle which carrier is worse. It can show which one is generating
        the work.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ month */

/**
 * A month where a series reads zero while other work was plainly being
 * recorded is almost certainly a month before that sheet existed, not a month
 * where nothing happened. In the migrated workbook the call log starts in
 * spring 2026, so the twelve-month chart shows calls climbing from nothing to
 * three hundred a month — which looks like a twentyfold rise in the work and
 * is nothing of the sort.
 *
 * Worked out from the data rather than hard-coded to a date, so it disappears
 * of its own accord once the whole window is months she has logged herself.
 */
function seriesStart(trend, key) {
  const first = trend.findIndex((t) => Number(t[key]) > 0);
  if (first <= 0) return null;                        // never, or from the start
  const before = trend.slice(0, first);
  const someWork = before.some((t) => Number(t.orders) > 0 || Number(t.issues) > 0);
  return someWork ? trend[first].ym : null;
}

function Month({ d }) {
  const h = d.headline;
  const pounds = (h.credit_value_pence / 100).toFixed(2);
  const callsFrom = seriesStart(d.charts.trend, "calls");
  return (
    <>
      <div className="stats">
        <Stat value={h.calls} label="calls" sub={`busiest month on record ${d.baselines.busiest_month_calls}`} />
        <Stat value={h.orders} label="orders" sub={`busiest ${d.baselines.busiest_month_orders}`} />
        <Stat value={h.issues_opened} label="issues opened" />
        <Stat
          value={h.resolution_rate == null ? "—" : `${h.resolution_rate}%`}
          label="resolved"
          sub={`baseline ${d.baselines.issue_resolution_rate}%`}
          tone={h.resolution_rate != null && h.resolution_rate >= d.baselines.issue_resolution_rate ? "good" : null}
        />
        <Stat value={h.two_p} label="2p orders raised" />
        <Stat value={`£${pounds}`} label="credit value" sub={`${h.credits} credits`} />
        <Stat value={h.total} label="records this month" />
      </div>

      <Figure
        title="Twelve months"
        note="calls, orders and issues per month"
        empty={d.charts.trend.length === 0}
        table={
          <Table
            head={["Month", "Calls", "Orders", "Issues"]}
            rows={d.charts.trend.map((t) => [t.ym, t.calls, t.orders, t.issues])}
          />
        }
      >
        <Lines
          data={d.charts.trend}
          xKey="ym"
          series={[
            { key: "calls", label: "Calls", colour: "var(--s1)" },
            { key: "orders", label: "Orders", colour: "var(--s2)" },
            { key: "issues", label: "Issues", colour: "var(--s3)" },
          ]}
        />
      </Figure>
      {callsFrom && (
        <p className="fignote">
          Calls only appear from {callsFrom}, which is when the call log in the
          spreadsheet begins. The rise before and after that point is the record
          starting, not the work starting.
        </p>
      )}

      <div className="figrow">
        <Figure
          title="Out of stock, by brand"
          note="SKU-days this month"
          empty={d.charts.oos_by_brand.length === 0}
          table={
            <Table
              head={["Brand", "SKU-days out", "SKUs"]}
              rows={d.charts.oos_by_brand.map((b) => [b.brand_group, b.days_out, b.skus])}
            />
          }
        >
          <HBars data={d.charts.oos_by_brand} labelKey="brand_group" valueKey="days_out" colour="var(--s4)" />
        </Figure>

        <Figure
          title="Out of stock, by SKU"
          note="the ones to chase"
          empty={d.charts.oos_by_sku.length === 0}
          table={
            <Table head={["SKU", "Days out"]} rows={d.charts.oos_by_sku.map((s) => [s.description, s.days_out])} />
          }
        >
          <HBars data={d.charts.oos_by_sku} labelKey="short" valueKey="days_out" colour="var(--s4)" />
        </Figure>
      </div>

      {d.charts.problem_stores.length > 0 && (
        <Figure title="Stores raising issues" note="new means their first issue was this month">
          <div className="fig-table">
            <Table
              head={["Store", "Issues", "New?"]}
              rows={d.charts.problem_stores.map((s) => [s.code_display, s.issues, s.is_new ? "new" : "repeat"])}
            />
          </div>
        </Figure>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- pending */

function Pending({ d }) {
  const p = d.pending;
  const total =
    p.open_items.total + p.drafts + p.requests_unfinished + p.campaign_lines_pending;

  return (
    <div className="card pendingblock">
      <h2>
        Still waiting
        <span className="cnt">as of now, not just this period</span>
        <span className="push mono">{total} things</span>
      </h2>
      <div className="body">
        <div className="stats tight">
          <Stat
            value={p.open_items.total}
            label="open follow-ups"
            sub={p.open_items.oldest_days ? `oldest ${p.open_items.oldest_days} days` : null}
            tone={p.open_items.older > 0 ? "warn" : null}
          />
          <Stat value={p.drafts} label="drafts to finish" sub="records with no store yet" />
          <Stat value={p.requests_unfinished} label="requests in flight" />
          <Stat value={p.campaign_lines_pending} label="allocation lines pending" sub={`${p.campaigns_open} campaigns open`} />
          <Stat value={p.booker_outstanding} label="not on Booker" tone={p.booker_outstanding > 0 ? "warn" : null} />
          <Stat value={p.out_of_stock_now} label="SKUs out now" sub={`${p.persistent_oos} out a week or more`} />
        </div>

        <Figure title="How old the open items are" note="the older bar is the one that matters">
          <HBars
            data={[
              { label: "Today", n: p.open_items.today },
              { label: "This week", n: p.open_items.week },
              { label: "Older than a week", n: p.open_items.older },
            ]}
            labelKey="label"
            valueKey="n"
            colour="var(--warn)"
          />
        </Figure>
      </div>
    </div>
  );
}
