"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../auth";
import { localeNames } from "../i18n";
import { useAuthLocale } from "../auth-locale";

export default function RegisterPage() {
  const { locale, selectLocale, locales, t } = useAuthLocale();
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [sent, setSent] = useState(false); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password, locale }) });
      if (!response.ok) throw new Error(t("registrationFailed"));
      setSent(true);
    } catch (value) { setError(value instanceof Error ? value.message : t("registrationFailed")); }
    finally { setBusy(false); }
  }

  return <main className="shell authPage"><section className="authCard panel">
    <div className="authHeader"><p className="eyebrow">CONXTOR - MESSAGING GROUP INTELLIGENCE</p><label className="languagePicker"><span>🌐</span><select aria-label="Language" value={locale} onChange={(event) => selectLocale(event.target.value)}>{locales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label></div>
    {sent ? <><h1>{t("verificationTitle")}</h1><p className="muted">{t("verificationSent")}</p><p className="authSwitch"><Link href="/login">{t("signIn")}</Link></p></> : <>
      <h1>{t("registerTitle")}</h1><p className="muted">{t("registerHint")}</p>{error && <div className="notice">{error}</div>}
      <form className="authForm" onSubmit={submit}>
        <label>{t("name")}<input type="text" autoComplete="name" required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>{t("email")}<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>{t("password")}<input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} /><small>{t("passwordMinimum")}</small></label>
        <button className="primaryButton" disabled={busy}>{busy ? t("registerBusy") : t("registerButton")}</button>
      </form><p className="authSwitch">{t("haveAccount")} <Link href="/login">{t("signIn")}</Link></p>
    </>}
  </section></main>;
}
