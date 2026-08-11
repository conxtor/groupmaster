"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "../auth";

export default function LoginPage() {
  const router = useRouter();
  const [nextPath, setNextPath] = useState("/");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next?.startsWith("/")) setNextPath(next);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? "Anmeldung fehlgeschlagen");
      }
      router.replace(nextPath);
    } catch (value) {
      setError(value instanceof Error ? value.message : "Anmeldung fehlgeschlagen");
    } finally { setBusy(false); }
  }

  return <main className="shell authPage"><section className="authCard panel">
    <p className="eyebrow">WAGI / GROUP INTELLIGENCE</p>
    <h1>Anmelden</h1>
    <p className="muted">Melde dich an, um deine freigegebenen Gruppen und Wissenseinträge zu sehen.</p>
    {error && <div className="notice">{error}</div>}
    <form className="authForm" onSubmit={submit}>
      <label>E-Mail<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Passwort<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="primaryButton" disabled={busy}>{busy ? "Anmeldung …" : "Anmelden"}</button>
    </form>
    <p className="authSwitch">Noch kein Konto? <Link href="/register">Konto erstellen</Link></p>
  </section></main>;
}
