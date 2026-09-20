import { createPortal } from "react-dom";
import { useEffect, useState } from "react";

/**
 * Renders its children into document.body, positioned under `anchorRef`.
 *
 * StorePicker and ProductPicker used to position their suggestion list with
 * plain CSS (`position: absolute` inside their own box). That works until the
 * box sits inside a `.card` — every card clips overflow for its rounded
 * corners, so the list opened (the state was there, the DOM node was there)
 * but rendered invisible, clipped away at the card's edge. A portal escapes
 * any ancestor's overflow or stacking context entirely, so it can never be
 * clipped by a container neither picker knows about.
 */
export default function DropdownPortal({ anchorRef, portalRef, open, children }) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 5, left: r.left, width: r.width });
    };
    update();
    // capture:true so scrolling any ancestor (not just the window) repositions it
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, anchorRef]);

  if (!open || !rect) return null;

  return createPortal(
    <div
      ref={portalRef}
      style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width, zIndex: 1000 }}
    >
      {children}
    </div>,
    document.body
  );
}
