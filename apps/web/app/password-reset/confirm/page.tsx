"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../auth";
import { localeNames } from "../../i18n";
import { useAuthLocale } from "../../auth-locale";

export default function PasswordResetConfirmPage() {
  const { locale, selectLocale, locales, t } = useAuthLocale();
  const [token, setToken] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [state, setState] = useState<"form" | "success" | "error">("form"); const [busy, setBusy] = useState(false);
  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") ?? ""); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!token || password.length < 10 || password !== confirmation) { setState("error"); return; }
    setBusy(true); setState("form");
    try { const response = await apiFetch("/api/v1/auth/password-reset/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, newPassword: password }) }); setState(response.ok ? "success" : "error"); } catch { setState("error"); } finally { setBusy(false); }
  }
  return <main className="shell authPage"><section className="authCard panel">
    <div className="authHeader"><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><label className="languagePicker"><span>🌐</span><select aria-label="Language" value={locale} onChange={(event) => selectLocale(event.target.value)}>{locales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label></div>
    <h1>{t("resetPasswordTitle")}</h1><p className="muted">{t("resetPasswordHint")}</p>{state === "success" ? <><div className="successNotice">{t("resetSuccess")}</div><p className="authSwitch"><Link href="/login">{t("signIn")}</Link></p></> : <form className="authForm" onSubmit={submit}><label>{t("newPassword")}<input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>{t("confirmPassword")}<input type="password" autoComplete="new-password" required minLength={10} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>{state === "error" && <div className="notice">{t("invalidToken")}</div>}<button className="primaryButton" disabled={busy}>{busy ? t("resetBusy") : t("resetButton")}</button></form>}
  </section></main>;
}
