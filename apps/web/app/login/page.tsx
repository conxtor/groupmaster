"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "../auth";
import { localeNames } from "../i18n";
import { useAuthLocale } from "../auth-locale";

export default function LoginPage() {
  const router = useRouter();
  const { locale, selectLocale, locales, t } = useAuthLocale();
  const [nextPath, setNextPath] = useState("/");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verificationNeeded, setVerificationNeeded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next?.startsWith("/")) setNextPath(next);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(null); setVerificationNeeded(false);
    try {
      const response = await apiFetch("/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, locale }) });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { code?: string } | null;
        if (body?.code === "email_verification_required") setVerificationNeeded(true);
        throw new Error(body?.code === "email_verification_required" ? t("verificationRequired") : t("loginFailed"));
      }
      router.replace(nextPath);
    } catch (value) { setError(value instanceof Error ? value.message : t("loginFailed")); }
    finally { setBusy(false); }
  }

  return <main className="shell authPage"><section className="authCard panel">
    <div className="authHeader"><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><label className="languagePicker"><span>🌐</span><select aria-label="Language" value={locale} onChange={(event) => selectLocale(event.target.value)}>{locales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label></div>
    <h1>{t("loginTitle")}</h1><p className="muted">{t("loginHint")}</p>
    {error && <div className="notice">{error}</div>}{verificationNeeded && <p className="authSwitch"><Link href="/verify-email/resend">{t("resendVerification")}</Link></p>}
    <form className="authForm" onSubmit={submit}>
      <label>{t("email")}<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>{t("password")}<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="primaryButton" disabled={busy}>{busy ? t("loginBusy") : t("loginButton")}</button>
    </form>
    <p className="authSwitch"><Link href="/password-reset">{t("forgotPassword")}</Link></p>
    <p className="authSwitch">{t("noAccount")} <Link href="/register">{t("createAccount")}</Link></p>
  </section></main>;
}
