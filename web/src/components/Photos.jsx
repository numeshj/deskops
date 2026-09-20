import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";

/**
 * Photos on a record — the dead "Pictures" column, finally working.
 *
 * In the workbook that column existed and was always empty, because there was
 * nowhere for a photo to go. A stand sent to a store, a damaged pallet, a wrong
 * label: the photo IS the evidence, and "sent stand" on its own settles no
 * argument three weeks later.
 *
 * Uploads go straight through as the request body with the file's own
 * content-type — no multipart, so nothing extra has to be installed server-side.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export default function Photos({ activityId, compact, toast }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { attachments } = await api.attachments(activityId);
      setItems(attachments);
    } catch {
      /* a record with no photos is the normal case */
    } finally {
      setLoaded(true);
    }
  }, [activityId]);

  useEffect(() => { load(); }, [load]);

  async function upload(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    try {
      for (const file of list) {
        if (file.size > MAX_BYTES) {
          toast?.(`${file.name} is too big — 8 MB is the limit`, null, "error");
          continue;
        }
        await api.upload(activityId, file);
      }
      await load();
      toast?.(list.length === 1 ? "Photo attached" : `${list.length} photos attached`);
    } catch (err) {
      toast?.(`Could not attach — ${err.message}`, null, "error");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(a) {
    try {
      await api.removeAttachment(a.attachment_id);
      setItems((cur) => cur.filter((x) => x.attachment_id !== a.attachment_id));
    } catch (err) {
      toast?.(`Could not remove — ${err.message}`, null, "error");
    }
  }

  if (!loaded) return null;
  if (compact && items.length === 0) {
    return (
      <button type="button" className="photobtn" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? "…" : "+ photo"}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(e) => upload(e.target.files)}
        />
      </button>
    );
  }

  return (
    <div className="photos">
      {items.map((a) => (
        <figure className="photo" key={a.attachment_id}>
          <a href={a.url} target="_blank" rel="noreferrer">
            {a.mime === "application/pdf" ? (
              <span className="pdf">PDF</span>
            ) : (
              <img src={a.url} alt={a.caption || "attachment"} loading="lazy" />
            )}
          </a>
          <button type="button" className="x" onClick={() => remove(a)} aria-label="Remove photo">×</button>
        </figure>
      ))}

      <button type="button" className="photoadd" onClick={() => fileRef.current?.click()} disabled={busy}>
        {busy ? "Uploading…" : "+ photo"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        onChange={(e) => upload(e.target.files)}
      />
    </div>
  );
}
