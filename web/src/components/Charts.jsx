import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * Chart primitives, built to one set of rules so every figure on the dashboard
 * reads as the same system.
 *
 * The rules that are not negotiable, and why:
 *
 *   - Bars cap at 24px and carry a 4px rounded data-end, square at the
 *     baseline. The band's leftover width is air, not a fatter bar.
 *   - Adjacent marks are separated by a 2px gap in the surface colour, never
 *     by a stroke. A stroke is ink that is not data.
 *   - Markers carry a 2px surface ring so they stay legible where they cross.
 *   - Axis ticks are chosen so every gridline lands on a whole number. A
 *     y-axis reading 37.5 records is nonsense.
 *   - Labels are selective: the peak and the endpoints, never a number on
 *     every mark.
 *   - Two or more series always get a legend. One series gets none — the
 *     title already says what is plotted.
 *   - Every figure has a table view. The series greens sit just under 3:1
 *     against the light surface, and the palette validator says that obliges
 *     visible labels or a table. This is the table.
 *
 * The categorical hues are the app's own --s1..--s5, in fixed order, checked
 * with the palette validator in both light and dark. They are never cycled and
 * never assigned by rank: a filter that drops a series must not repaint the
 * ones that remain.
 */

const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];

/**
 * Measure the plot so one SVG unit is one CSS pixel.
 *
 * This matters more than it looks. With a fixed 100-wide viewBox and
 * preserveAspectRatio="none", a "24 unit" bar cap became 24% of the chart —
 * 135px on a 565px card, five times the 24px the spec allows. Measuring means
 * the cap, the 2px gaps and the axis label positions are all in real pixels,
 * and the axis labels line up with the bands they name.
 */
function usePlotWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el && el.clientWidth) setW(el.clientWidth);
  }, []);
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [measure]);
  return [ref, w];
}

const BAR_MAX = 24;   // px, per the mark spec
const GAP = 2;        // px of surface between touching marks

/** X-axis labels positioned on their band centres, in pixels. */
function Axis({ data, xKey, left, band, every = 1 }) {
  return (
    <div className="xaxis">
      {data.map((d, i) => (
        <span
          key={i}
          style={{ left: `${left + band * (i + 0.5)}px` }}
          className={i % every ? "hide" : ""}
        >
          {d[xKey]}
        </span>
      ))}
    </div>
  );
}

/** Ticks that divide whole, so no gridline ever reads 37.5. */
function scale(max, targetTicks = 4) {
  if (!max || max <= 0) return { max: 1, ticks: [0, 1] };
  const raw = max / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return { max: top, ticks };
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

/* ------------------------------------------------------------------ figure */

/**
 * The wrapper every chart sits in: title, optional note, and the chart/table
 * toggle that the contrast check obliges.
 */
export function Figure({ title, note, children, table, empty }) {
  const [view, setView] = useState("chart");
  const hasTable = Boolean(table);
  return (
    <figure className="fig">
      <figcaption>
        <span className="t">{title}</span>
        {note && <span className="n">{note}</span>}
        {hasTable && (
          <span className="toggle-view">
            <button
              type="button"
              className={view === "chart" ? "on" : ""}
              onClick={() => setView("chart")}
              aria-pressed={view === "chart"}
            >
              Chart
            </button>
            <button
              type="button"
              className={view === "table" ? "on" : ""}
              onClick={() => setView("table")}
              aria-pressed={view === "table"}
            >
              Table
            </button>
          </span>
        )}
      </figcaption>
      {empty ? (
        <div className="fig-empty">Nothing recorded yet for this period.</div>
      ) : view === "chart" ? (
        children
      ) : (
        <div className="fig-table">{table}</div>
      )}
    </figure>
  );
}

function Table({ head, rows }) {
  return (
    <table>
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => <td key={j} className={j ? "mono" : ""}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* -------------------------------------------------------------------- bars */

/**
 * Vertical bars, one series. Used for the day's hour-by-hour shape and for
 * month-by-month volume.
 */
export function Bars({ data, xKey, yKey, colour = "var(--accent)", height = 160, labelPeak = true }) {
  const [hover, setHover] = useState(null);
  const [ref, W] = usePlotWidth();
  const id = useId();
  const max = Math.max(0, ...data.map((d) => Number(d[yKey]) || 0));
  const s = scale(max);
  const pad = { l: 34, r: 8, t: 10, b: 6 };
  const plotW = Math.max(40, W - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const band = plotW / Math.max(1, data.length);
  // cap the bar and let the band's leftover be air, never a fatter bar
  const barW = Math.max(2, Math.min(band - GAP, BAR_MAX));
  const peak = data.reduce((a, b) => ((Number(b[yKey]) || 0) > (Number(a?.[yKey]) || -1) ? b : a), null);

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        width={W}
        height={height}
        style={{ height: `${height}px` }}
        role="img"
        aria-labelledby={`${id}-t`}
      >
        <title id={`${id}-t`}>{`${data.length} points, peak ${fmt(max)}`}</title>
        {s.ticks.map((t) => {
          const y = pad.t + plotH - (t / s.max) * plotH;
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="grid" />
              <text x={pad.l - 6} y={y + 3} className="ytick">{fmt(t)}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const v = Number(d[yKey]) || 0;
          const h = s.max ? (v / s.max) * plotH : 0;
          const x = pad.l + i * band + (band - barW) / 2;
          return (
            <g key={i} onMouseEnter={() => setHover({ i, d })}>
              {/* a full-height hit target, so a 2px bar is still hoverable */}
              <rect x={pad.l + i * band} y={pad.t} width={band} height={plotH} fill="transparent" />
              {v > 0 && (
                <rect
                  x={x}
                  y={pad.t + plotH - h}
                  width={barW}
                  height={Math.max(h, 1)}
                  rx={Math.min(4, barW / 2)}
                  fill={colour}
                  opacity={hover && hover.i !== i ? 0.6 : 1}
                />
              )}
            </g>
          );
        })}
      </svg>

      <Axis data={data} xKey={xKey} left={pad.l} band={band} every={data.length > 14 ? 2 : 1} />

      {labelPeak && peak && max > 0 && (
        <div className="peaknote">
          peak <strong>{fmt(Number(peak[yKey]))}</strong> at {peak[xKey]}
        </div>
      )}

      {hover && (
        <div className="tip" role="status">
          <strong>{hover.d[xKey]}</strong> {fmt(Number(hover.d[yKey]) || 0)}
        </div>
      )}
    </div>
  );
}

/**
 * Horizontal bars, one series, value labelled on every row.
 *
 * Horizontal because these are all "which of these named things is biggest" —
 * brand groups, stores, SKUs — and a rotated x-label is a tell that the chart
 * is the wrong way round. One colour for every bar: the length already encodes
 * the magnitude, so colouring darker-where-bigger would spend the only free
 * channel restating it.
 */
export function HBars({ data, labelKey, valueKey, colour = "var(--accent)", suffix = "", max: givenMax }) {
  const max = givenMax ?? Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  return (
    <div className="hbars">
      {data.map((d, i) => {
        const v = Number(d[valueKey]) || 0;
        return (
          <div className="hbar" key={i}>
            <span className="l" title={String(d[labelKey])}>{d[labelKey]}</span>
            <span className="track">
              <span className="fill" style={{ width: `${Math.max(1.5, (v / max) * 100)}%`, background: colour }} />
            </span>
            <span className="v mono">{fmt(v)}{suffix}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Grouped columns, up to three series. Legend always, direct label only on the
 * tallest column of each series.
 */
export function GroupedBars({ data, xKey, series, height = 180 }) {
  const [hover, setHover] = useState(null);
  const [ref, W] = usePlotWidth();
  const max = Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const s = scale(max);
  const pad = { l: 34, r: 8, t: 10, b: 6 };
  const plotW = Math.max(40, W - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const band = plotW / Math.max(1, data.length);
  // each series bar capped at 24px, with a 2px surface gap between neighbours
  const inner = Math.max(2, Math.min((band - GAP * (series.length + 1)) / series.length, BAR_MAX));
  const groupW = inner * series.length + GAP * (series.length - 1);

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <div className="legend">
        {series.map((se, i) => (
          <span key={se.key}>
            <i style={{ background: se.colour || SERIES[i] }} />
            {se.label}
          </span>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} style={{ height: `${height}px` }} role="img">
        {s.ticks.map((t) => {
          const y = pad.t + plotH - (t / s.max) * plotH;
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="grid" />
              <text x={pad.l - 6} y={y + 3} className="ytick">{fmt(t)}</text>
            </g>
          );
        })}
        {data.map((d, i) => (
          <g key={i} onMouseEnter={() => setHover({ i, d })}>
            <rect x={pad.l + i * band} y={pad.t} width={band} height={plotH} fill="transparent" />
            {series.map((se, j) => {
              const v = Number(d[se.key]) || 0;
              const h = s.max ? (v / s.max) * plotH : 0;
              const x = pad.l + i * band + (band - groupW) / 2 + j * (inner + GAP);
              return v > 0 ? (
                <rect
                  key={se.key}
                  x={x}
                  y={pad.t + plotH - h}
                  width={inner}
                  height={Math.max(h, 1)}
                  rx={Math.min(4, inner / 2)}
                  fill={se.colour || SERIES[j]}
                  opacity={hover && hover.i !== i ? 0.6 : 1}
                />
              ) : null;
            })}
          </g>
        ))}
      </svg>

      <Axis data={data} xKey={xKey} left={pad.l} band={band} />

      {hover && (
        <div className="tip" role="status">
          <strong>{hover.d[xKey]}</strong>
          {series.map((se, i) => (
            <span key={se.key}>
              <i style={{ background: se.colour || SERIES[i] }} />
              {se.label} {fmt(Number(hover.d[se.key]) || 0)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Lines over time, up to three series, with a crosshair and end labels.
 * One y-axis only — two measures of different scale get two charts, never a
 * second axis.
 */
export function Lines({ data, xKey, series, height = 200 }) {
  const [hover, setHover] = useState(null);
  const [ref, W] = usePlotWidth();
  const max = Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const s = scale(max);
  const pad = { l: 34, r: 12, t: 10, b: 6 };
  const plotW = Math.max(40, W - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const step = data.length > 1 ? plotW / (data.length - 1) : 0;

  const xy = (i, v) => [pad.l + i * step, pad.t + plotH - (s.max ? (v / s.max) * plotH : 0)];

  const paths = useMemo(
    () =>
      series.map((se) => ({
        ...se,
        d: data
          .map((row, i) => {
            const [x, y] = xy(i, Number(row[se.key]) || 0);
            return `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
          })
          .join(" "),
      })),
    [data, series, s.max, W]
  );

  return (
    <div className="chart lines" ref={ref} onMouseLeave={() => setHover(null)}>
      <div className="legend">
        {series.map((se, i) => (
          <span key={se.key}>
            <i style={{ background: se.colour || SERIES[i] }} />
            {se.label}
          </span>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} style={{ height: `${height}px` }} role="img">
        {s.ticks.map((t) => {
          const y = pad.t + plotH - (t / s.max) * plotH;
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} className="grid" />
              <text x={pad.l - 6} y={y + 3} className="ytick">{fmt(t)}</text>
            </g>
          );
        })}

        {hover != null && (
          <line
            x1={pad.l + hover * step}
            x2={pad.l + hover * step}
            y1={pad.t}
            y2={pad.t + plotH}
            className="crosshair"
          />
        )}

        {paths.map((p, i) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={p.colour || SERIES[i]}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* end markers carry a 2px surface ring so they survive crossing */}
        {series.map((se, i) => {
          const last = data.length - 1;
          if (last < 0) return null;
          const [x, y] = xy(last, Number(data[last][se.key]) || 0);
          return (
            <circle
              key={se.key}
              cx={x}
              cy={y}
              r="4"
              fill={se.colour || SERIES[i]}
              stroke="var(--surface)"
              strokeWidth="2"
            />
          );
        })}

        {data.map((_, i) => (
          <rect
            key={i}
            x={pad.l + i * step - step / 2}
            y={pad.t}
            width={step || plotW}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      <Axis data={data} xKey={xKey} left={pad.l - step / 2} band={step || plotW} every={data.length > 8 ? 2 : 1} />

      {hover != null && data[hover] && (
        <div className="tip" role="status">
          <strong>{data[hover][xKey]}</strong>
          {series.map((se, i) => (
            <span key={se.key}>
              <i style={{ background: se.colour || SERIES[i] }} />
              {se.label} {fmt(Number(data[hover][se.key]) || 0)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A number that is the chart. Used where a bar chart of one value would be silly. */
export function Stat({ value, label, sub, tone }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ""}`}>
      <strong>{value}</strong>
      <span className="l">{label}</span>
      {sub && <span className="s">{sub}</span>}
    </div>
  );
}

export { Table, SERIES, fmt };
