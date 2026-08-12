"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "../auth";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? "Konto konnte nicht erstellt werden");
      }
      router.replace("/");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Konto konnte nicht erstellt werden");
    } finally { setBusy(false); }
  }

  return <main className="shell authPage"><section className="authCard panel">
    <p className="eyebrow">WAGI / GROUP INTELLIGENCE</p>
    <h1>Konto erstellen</h1>
    <p className="muted">Nach der Anmeldung verbindest du deine eigenen Konten und wählst deine Gruppen selbst aus.</p>
    {error && <div className="notice">{error}</div>}
    <form className="authForm" onSubmit={submit}>
      <label>Name<input type="text" autoComplete="name" required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>E-Mail<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>Passwort<input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} /><small>Mindestens 10 Zeichen</small></label>
      <button className="primaryButton" disabled={busy}>{busy ? "Konto wird erstellt …" : "Konto erstellen"}</button>
    </form>
    <p className="authSwitch">Bereits registriert? <Link href="/login">Anmelden</Link></p>
  </section></main>;
}
