import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from "react-router-dom";
import { api, setToken } from "./lib/api.js";
import { start as startQueue, subscribe as subscribeQueue, flush as flushQueue } from "./lib/queue.js";
import Capture from "./pages/Capture.jsx";
import OpenItems from "./pages/OpenItems.jsx";
import Drafts from "./pages/Drafts.jsx";
import StoreView from "./pages/StoreView.jsx";
import AddStore from "./pages/AddStore.jsx";
import OrderView from "./pages/OrderView.jsx";
import Stock from "./pages/Stock.jsx";
import Requests from "./pages/Requests.jsx";
import Campaigns from "./pages/Campaigns.jsx";
import CampaignView from "./pages/CampaignView.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Impact from "./pages/Impact.jsx";
import Login from "./pages/Login.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  );
}

function Root() {
  const [user, setUser] = useState(undefined); // undefined = still checking
  const [workTypes, setWorkTypes] = useState([]);
  const [counts, setCounts] = useState({});
  const [toastState, setToastState] = useState(null);
  const [pending, setPending] = useState(0);
  const toastTimer = useRef(null);

  const toast = useCallback((message, sub, kind) => {
    clearTimeout(toastTimer.current);
    setToastState({ message, sub, kind });
    toastTimer.current = setTimeout(() => setToastState(null), kind === "error" ? 4200 : 2000);
  }, []);

  const loadVocab = useCallback(async () => {
    try {
      const { work_types } = await api.workTypes();
      setWorkTypes(work_types);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Wake the backend immediately. On free hosting the container may be cold,
    // and this request starts it warming while she is still typing her password
    // — by the time she saves her first record it is usually up.
    api.get("/health").catch(() => {});

    api
      .me()
      .then(({ user: u }) => setUser(u))
      .catch(() => setUser(null));
  }, []);

  // the offline queue retries anything that could not be sent
  useEffect(() => {
    const stop = startQueue((path, body) => api.post(path, body));
    const unsub = subscribeQueue(setPending);
    return () => {
      stop();
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    loadVocab();
    const refresh = () => loadVocab();
    window.addEventListener("deskops:vocab-changed", refresh);
    return () => window.removeEventListener("deskops:vocab-changed", refresh);
  }, [user, loadVocab]);

  if (user === undefined) {
    return <div className="page muted">Loading…</div>;
  }
  if (!user) {
    return <Login onSignedIn={(u) => setUser(u)} />;
  }

  return (
    <div className="shell">
      <Topbar user={user} counts={counts} pending={pending} onSignOut={() => setUser(null)} />
      <div className="page">
        <Routes>
          <Route
            path="/"
            element={<Capture workTypes={workTypes} toast={toast} onCountsChanged={setCounts} />}
          />
          <Route path="/open" element={<OpenItems toast={toast} />} />
          <Route path="/drafts" element={<Drafts workTypes={workTypes} toast={toast} />} />
          <Route path="/dashboard" element={<Dashboard toast={toast} />} />
          <Route path="/impact" element={<Impact toast={toast} />} />
          <Route path="/stock" element={<Stock toast={toast} />} />
          <Route path="/requests" element={<Requests toast={toast} />} />
          <Route path="/allocations" element={<Campaigns toast={toast} />} />
          <Route path="/allocations/:id" element={<CampaignView toast={toast} />} />
          <Route path="/stores/new" element={<AddStore toast={toast} />} />
          <Route path="/stores/:id" element={<StoreView />} />
          <Route path="/orders/:id" element={<OrderView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>

      <div className={`toast${toastState ? " on" : ""}`} role="status" aria-live="polite">
        <span>{toastState?.message}</span>
        {toastState?.sub && <span className="s">{toastState.sub}</span>}
      </div>
    </div>
  );
}

function Topbar({ user, counts, pending, onSignOut }) {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .drafts()
        .then((d) => alive && setDrafts(d.drafts.length))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function signOut() {
    await api.logout().catch(() => {});
    setToken(null);
    onSignOut();
    navigate("/");
  }

  return (
    <div className="topbar">
      <div className="brand">
        <h1>Desk Ops</h1>
        <span className="sub">order desk</span>
      </div>
      <nav className="nav">
        <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
          Capture
        </NavLink>
        <NavLink to="/open" className={({ isActive }) => (isActive ? "active" : "")}>
          Open
          {counts.open > 0 && <span className="badge">{counts.open}</span>}
        </NavLink>
        <NavLink to="/drafts" className={({ isActive }) => (isActive ? "active" : "")}>
          Drafts
          {drafts > 0 && <span className="badge">{drafts}</span>}
        </NavLink>
        <NavLink to="/stock" className={({ isActive }) => (isActive ? "active" : "")}>
          Stock
        </NavLink>
        <NavLink to="/requests" className={({ isActive }) => (isActive ? "active" : "")}>
          Requests
        </NavLink>
        <NavLink to="/allocations" className={({ isActive }) => (isActive ? "active" : "")}>
          Allocations
        </NavLink>
        <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "active" : "")}>
          Dashboard
        </NavLink>
      </nav>
      {pending > 0 && (
        <button
          type="button"
          className="syncpill"
          onClick={() => flushQueue((p, b2) => api.post(p, b2))}
          title="Records saved on this device, waiting to reach the server. Click to retry now."
        >
          <span className="dot" />
          {pending} to sync
        </button>
      )}
      <button type="button" className="btn sm ghost" onClick={signOut}>
        {user.display_name} · Sign out
      </button>
    </div>
  );
}
