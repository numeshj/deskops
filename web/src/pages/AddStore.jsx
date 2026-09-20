import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../lib/api.js";

/**
 * Register a new Fs number.
 *
 * A separate page rather than something squeezed into the store picker
 * mid-call: the wholesaler's own account system is where an Fs number
 * actually originates, so by the time anyone is here they already have it
 * written down — this is about getting it into the system correctly, not
 * about speed the way the capture bar is.
 */
export default function AddStore({ toast }) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [postcode, setPostcode] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactRole, setContactRole] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const canSave = code.trim().length > 0 && !saving;

  async function save(e) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.addStore({
        code: code.trim(),
        name: name.trim() || null,
        group_name: groupName.trim() || null,
        address_line: addressLine.trim() || null,
        postcode: postcode.trim() || null,
        delivery_note: deliveryNote.trim() || null,
        contact_name: contactName.trim() || null,
        contact_role: contactRole.trim() || null,
        contact_phone: contactPhone.trim() || null,
      });
      toast(`${res.code_display} added`, name.trim() || null);
      navigate(`/stores/${res.store_id}`);
    } catch (err) {
      if (err.status === 409) {
        setError({
          message: `${err.data?.code_display || "That store"} is already in the system.`,
          storeId: err.data?.store_id,
        });
      } else if (err.data?.error === "invalid_code") {
        setError({ message: "That doesn't look like an Fs number — try something like Fs335." });
      } else {
        setError({ message: `Could not add it — ${err.message}` });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h2>Add a new store</h2>
      <form className="body" onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label className="lbl" htmlFor="new-code">Fs number</label>
          <input
            id="new-code"
            className="field mono"
            placeholder="Fs612"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
        </div>

        <div>
          <label className="lbl" htmlFor="new-name">Store name</label>
          <input
            id="new-name"
            className="field"
            placeholder="e.g. Morrisons Daily"
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="row" style={{ gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label className="lbl" htmlFor="new-group">Group (optional)</label>
            <input id="new-group" className="field" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="lbl" htmlFor="new-postcode">Postcode (optional)</label>
            <input id="new-postcode" className="field" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="lbl" htmlFor="new-address">Address (optional)</label>
          <input id="new-address" className="field" value={addressLine} onChange={(e) => setAddressLine(e.target.value)} />
        </div>

        <div>
          <label className="lbl" htmlFor="new-delivery">Delivery note (optional)</label>
          <input
            id="new-delivery"
            className="field"
            placeholder='e.g. "goes to the main Morrisons"'
            value={deliveryNote}
            onChange={(e) => setDeliveryNote(e.target.value)}
          />
        </div>

        <div className="chiplabel">First contact (optional)</div>
        <div className="row" style={{ gap: 10 }}>
          <div style={{ flex: "1 1 200px" }}>
            <input className="field" placeholder="Name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </div>
          <div style={{ flex: "0 1 140px" }}>
            <input className="field" placeholder="Role" value={contactRole} onChange={(e) => setContactRole(e.target.value)} />
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <input className="field mono" placeholder="Phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
          </div>
        </div>

        {error && (
          <div className="empty" style={{ borderColor: "var(--crit)", color: "var(--crit)" }}>
            {error.message}
            {error.storeId && (
              <>
                {" "}
                <Link to={`/stores/${error.storeId}`}>Go to it</Link>
              </>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={() => navigate(-1)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!canSave}>
            {saving ? "Adding…" : "Add store"}
          </button>
        </div>
      </form>
    </div>
  );
}
