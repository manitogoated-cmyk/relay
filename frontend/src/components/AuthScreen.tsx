import { useState } from "react";
import { api, ApiError } from "../api";
import { BrandMark } from "../icons";
import type { User } from "../types";
import { Field, Spinner } from "./ui";

export function AuthScreen({ mode, needsToken, onDone }: { mode: "login" | "setup"; needsToken: boolean; onDone: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "setup" && password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await api.login(username.trim(), password)
          : await api.setup({ username: username.trim(), password, display_name: displayName.trim(), setup_token: token });
      onDone(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.details?.[0] ? `${err.details[0].field}: ${err.details[0].message}` : err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="auth-glow" aria-hidden />
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <BrandMark size={40} />
          <div>
            <h1>Relay</h1>
            <p>Your own webhook platform</p>
          </div>
        </div>
        <h2>{mode === "login" ? "Sign in" : "Create your account"}</h2>
        {mode === "setup" && <p className="muted">This is the first run. The account you create here owns every webhook and message.</p>}
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required pattern="[A-Za-z0-9_.\-]{3,64}" title="3-64 letters, digits, dot, dash or underscore" />
        </Field>
        {mode === "setup" && (
          <Field label="Display name" hint="Optional">
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
          </Field>
        )}
        <Field label="Password" hint={mode === "setup" ? "At least 10 characters" : undefined}>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "setup" ? 10 : undefined} />
        </Field>
        {mode === "setup" && (
          <Field label="Repeat password">
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </Field>
        )}
        {mode === "setup" && needsToken && (
          <Field label="Setup token" hint="The value of RELAY_SETUP_TOKEN on the server">
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
          </Field>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy && <Spinner />} {mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </main>
  );
}
