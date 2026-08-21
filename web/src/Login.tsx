import { FormEvent, useState } from "react";
import { api } from "./api";

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { await api.login(email, password); onSuccess(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <main className="login-page">
    <div className="login-photo"><img src="/images/padel-hero.jpg" alt="Padel court at golden hour" /><div className="login-caption"><span>COURT/01</span><h1>The court is<br />waiting.</h1><p>Private booking automation for London players.</p></div></div>
    <form className="login-panel" onSubmit={submit}>
      <div className="login-mark"><i /><i /><i /></div>
      <span className="eyebrow dark">Private access</span>
      <h2>Welcome back.</h2>
      <p>Sign in to manage court watches and bookings.</p>
      {error && <div className="login-error">{error}</div>}
      <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<span>→</span></button>
      <small>Protected with a secure, HTTP-only session.</small>
    </form>
  </main>;
}
