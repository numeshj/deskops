import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

/**
 * Section 4.8 — allocation campaigns.
 *
 * The workbook had one sheet, invented for one brand, when Hayati released
 * limited stock. The next allocation got another sheet. This list is the thing
 * that stops that happening: a campaign is a record type, not a new file.
 */
export default function Campaigns({ toast }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setData(await api.campaigns());
  }, []);

  useEffect(() => {
    load().catch(() => toast("Could not load campaigns", null, "error"));
  }, [load, toast]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createCampaign({ name: name.trim(), brand: brand.trim() || null });
      setName("");
      setBrand("");
      toast("Campaign opened");
      await load();
    } catch (err) {
      toast(`Could not open it — ${err.message}`, null, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div><div className="empty">Loading campaigns…</div></div>;

  const open = data.campaigns.filter((c) => c.status === "open");
  const closed = data.campaigns.filter((c) => c.status === "closed");

  return (
    <div>
      <div className="pagehead">
        <h1>Allocations</h1>
      </div>

      <form className="card newcampaign" onSubmit={create}>
        <input
          className="field"
          placeholder="Campaign name — e.g. Hayati Pro Max+ 6K, Sep 2026"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Campaign name"
        />
        <input
          className="field short"
          placeholder="Brand"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          aria-label="Brand"
        />
        <button className="btn primary" disabled={busy || !name.trim()}>Open campaign</button>
      </form>

      {open.length === 0 && closed.length === 0 && (
        <div className="empty">
          No allocations yet. Open one the next time a brand releases limited stock, then add the
          stores you are ringing round.
        </div>
      )}

      {open.map((c) => <CampaignRow key={c.campaign_id} c={c} />)}

      {closed.length > 0 && (
        <>
          <h2 className="sectionhead">Closed</h2>
          {closed.map((c) => <CampaignRow key={c.campaign_id} c={c} />)}
        </>
      )}
    </div>
  );
}

function CampaignRow({ c }) {
  const pct = c.units_requested ? Math.round((c.units_fulfilled / c.units_requested) * 100) : 0;
  return (
    <Link className={`card camp${c.status === "closed" ? " closed" : ""}`} to={`/allocations/${c.campaign_id}`}>
      <div className="c-main">
        <div className="c-name">{c.name}</div>
        <div className="c-sub">
          {c.brand ? `${c.brand} · ` : ""}
          {c.stores} store{c.stores === 1 ? "" : "s"} · {c.lines} line{c.lines === 1 ? "" : "s"}
          {c.opened_on ? ` · opened ${String(c.opened_on).slice(0, 10)}` : ""}
        </div>
      </div>
      <div className="c-nums">
        <div className="c-units">
          <strong>{c.units_fulfilled}</strong> / {c.units_requested} units
        </div>
        <div className="c-bar" aria-label={`${pct}% fulfilled`}>
          <span style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        {c.booker_outstanding > 0 && (
          <div className="c-flag">{c.booker_outstanding} not on Booker</div>
        )}
      </div>
    </Link>
  );
}
