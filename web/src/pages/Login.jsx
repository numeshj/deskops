import { useState } from "react";
import { api, setToken } from "../lib/api.js";

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState("yashoda@example.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token, user } = await api.login(email, password);
      setToken(token);
      onSignedIn(user);
    } catch (err) {
      setError(err.message === "invalid_credentials" ? "That email and password don't match." : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card">
        <h1>Desk Ops</h1>
        <p>Sign in to log your work.</p>
        <form onSubmit={submit}>
          <input className="field" type="email" value={email} autoComplete="username"
            onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Email" />
          <input className="field" type="password" value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" />
          {error && <div className="err">{error}</div>}
          <button className="btn primary" style={{ width: "100%" }} disabled={busy || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <div className="hint">
          Development accounts:<br />
          <span className="mono">yashoda@example.com / desk1234</span><br />
          <span className="mono">admin@example.com / admin1234</span>
        </div>
      </div>
    </div>
  );
}
