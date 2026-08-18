"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../auth";
import { localeNames } from "../../i18n";
import { useAuthLocale } from "../../auth-locale";

export default function ResendVerificationPage() {
  const { locale, selectLocale, locales, t } = useAuthLocale();
  const [email, setEmail] = useState(""); const [sent, setSent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/auth/email-verification/resend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, locale }) });
      if (!response.ok) throw new Error(t("loginFailed")); setSent(true);
    } catch (value) { setError(value instanceof Error ? value.message : t("loginFailed")); } finally { setBusy(false); }
  }
  return <main className="shell authPage"><section className="authCard panel">
    <div className="authHeader"><p className="eyebrow">CONXTOR - MESSAGING GROUP INTELLIGENCE</p><label className="languagePicker"><span>🌐</span><select aria-label="Language" value={locale} onChange={(event) => selectLocale(event.target.value)}>{locales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label></div>
    <h1>{t("verificationTitle")}</h1><p className="muted">{t("verificationRequired")}</p>{sent ? <div className="successNotice">{t("verificationSent")}</div> : <form className="authForm" onSubmit={submit}><label>{t("email")}<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>{error && <div className="notice">{error}</div>}<button className="primaryButton" disabled={busy}>{busy ? t("resendingVerification") : t("resendVerification")}</button></form>}<p className="authSwitch"><Link href="/login">{t("signIn")}</Link></p>
  </section></main>;
}
