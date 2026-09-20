import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import CaptureBar from "../components/CaptureBar.jsx";
import ActivityRow from "../components/ActivityRow.jsx";
import { api } from "../lib/api.js";

/**
 * The home screen — capture bar, today's log (T15), and the unlisted-work
 * panel that turns repeated "Other" entries into real chips (section 6.4).
 */
export default function Capture({ workTypes, toast, onCountsChanged }) {
  const [today, setToday] = useState({ activities: [], counts: {}, speed: {} });
  const [unlisted, setUnlisted] = useState({ clusters: [], health: null });
  const [newIds, setNewIds] = useState(new Set());

  const loadToday = useCallback(async () => {
    try {
      const data = await api.today();
      setToday(data);
      onCountsChanged?.(data.counts);
    } catch {
      /* the capture bar must keep working even if the log fails to load */
    }
  }, [onCountsChanged]);

  const loadUnlisted = useCallback(async () => {
    try {
      setUnlisted(await api.unlisted());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadToday();
    loadUnlisted();
  }, [loadToday, loadUnlisted]);

  const onSaved = useCallback(
    (activity, seconds, error, info) => {
      if (info) return toast(info);
      if (error) return toast(`Could not save — ${error.message}`, null, "error");
      if (!activity) return undefined;
      if (!activity.is_draft) {
        setNewIds((s) => new Set([activity.activity_id, ...s]));
        setToday((t) => ({
          ...t,
          activities: [activity, ...t.activities],
          counts: { ...t.counts, total: (t.counts.total || 0) + 1 },
        }));
      }
      toast(
        activity.is_draft ? "Saved to drafts" : "Saved",
        activity.is_draft ? "no store yet" : seconds ? `${seconds.toFixed(1)}s` : null
      );
      loadToday();
      return undefined;
    },
    [toast, loadToday]
  );

  const onCluster = useCallback(
    (cluster) => {
      if (cluster.occurrences >= 3) {
        toast(`Logged ${cluster.occurrences}× — ready to become a chip`, "see Unlisted work");
      }
      loadUnlisted();
    },
    [toast, loadUnlisted]
  );

  async function promote(cluster) {
    const workTypeId = cluster.work_type_id || "call";
    try {
      const res = await api.promote(cluster.cluster_id, { work_type_id: workTypeId, backfill: true });
      toast(`"${res.label}" is now a chip`, res.backfilled ? `${res.backfilled} past records tagged` : null);
      loadUnlisted();
      window.dispatchEvent(new Event("deskops:vocab-changed"));
    } catch (err) {
      toast(`Could not promote — ${err.message}`, null, "error");
    }
  }

  async function dismiss(cluster) {
    await api.dismissCluster(cluster.cluster_id);
    toast("Dismissed", "records keep their text");
    loadUnlisted();
  }

  const c = today.counts || {};
  const speed = today.speed || {};
  const health = unlisted.health;

  return (
    <>
      <CaptureBar workTypes={workTypes} onSaved={onSaved} onCluster={onCluster} />

      <div className="cols">
        <div>
          <div className="counters">
            <Counter value={c.calls} label="Calls" />
            <Counter value={c.orders} label="Orders" />
            <Counter value={c.issues} label="Issues" />
            <Counter value={c.replacements} label="Replacements" />
            <Counter value={c.open} label="Open items" flag={c.open > 0} to="/open" />
          </div>

          <div className="card">
            <h2>
              Today <span className="cnt">{today.activities.length} records</span>
              <span className="push">newest first</span>
            </h2>
            <div>
              {today.activities.length === 0 && (
                <div className="empty">Nothing logged yet today. Pick a store and a chip above.</div>
              )}
              {today.activities.map((a) => (
                <ActivityRow key={a.activity_id} a={a} isNew={newIds.has(a.activity_id)} />
              ))}
            </div>
          </div>
        </div>

        <div className="rail">
          <div className="card">
            <h2>
              Unlisted work{" "}
              <span className="cnt">{unlisted.clusters.length} clusters</span>
            </h2>
            {health && (
              <div className={`meter ${health.band === "good" ? "good" : health.band === "watch" ? "warn" : "bad"}`}>
                <span className="pc tnum">{health.other_rate}%</span>
                <span className="lbl2">
                  logged as Other, last {health.window_days} days
                  <br />
                  target: under 5%
                </span>
              </div>
            )}
            <div>
              {unlisted.clusters.length === 0 && (
                <div className="empty">Nothing unclassified waiting.</div>
              )}
              {unlisted.clusters.slice(0, 8).map((cl) => (
                <div key={cl.cluster_id} className={`unl${cl.ready ? " ready" : ""}`}>
                  <div className="lab">{cl.suggested_label}</div>
                  <div className="meta mono">
                    {cl.occurrences}× · {cl.work_type_id || "call"}
                  </div>
                  <div className="acts">
                    <button
                      type="button"
                      className="go"
                      disabled={!cl.ready}
                      onClick={() => promote(cl)}
                    >
                      {cl.ready ? "Make it a chip" : `Needs 3× (${cl.occurrences}/3)`}
                    </button>
                    <button type="button" className="no" onClick={() => dismiss(cl)}>
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Time per record</h2>
            <div className="body">
              <div className="bar">
                <i
                  className="new"
                  style={{ width: `${Math.max(4, Math.min(100, ((speed.average || 0) / 45) * 100))}%` }}
                />
              </div>
              <div className="lg">
                <span>This app</span>
                <b className="mono">{speed.average ? `${speed.average}s` : "—"}</b>
              </div>
              <div className="bar">
                <i className="old" style={{ width: "100%" }} />
              </div>
              <div className="lg">
                <span>Spreadsheet row</span>
                <b className="mono">~45s</b>
              </div>
              <p className="note">
                {speed.count
                  ? `${speed.count} record${speed.count === 1 ? "" : "s"} today — about ${Math.round(
                      45 / (speed.average || 45)
                    )}× faster than the spreadsheet.`
                  : "Save a few records to compare."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Counter({ value, label, flag, to }) {
  const inner = (
    <>
      <div className="v tnum">{value ?? 0}</div>
      <div className="k">{label}</div>
    </>
  );
  return to ? (
    <Link className={`ct${flag ? " flag" : ""}`} to={to}>
      {inner}
    </Link>
  ) : (
    <div className={`ct${flag ? " flag" : ""}`}>{inner}</div>
  );
}
