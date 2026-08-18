"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../auth";
import { localeNames } from "../i18n";
import { useAuthLocale } from "../auth-locale";

export default function VerifyEmailPage() {
  const { locale, selectLocale, locales, t } = useAuthLocale();
  const [state, setState] = useState<"working" | "success" | "error">("working");
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) { setState("error"); return; }
    void apiFetch("/api/v1/auth/verify-email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).then((response) => setState(response.ok ? "success" : "error")).catch(() => setState("error"));
  }, []);
  return <main className="shell authPage"><section className="authCard panel">
    <div className="authHeader"><p className="eyebrow">CONXTOR - MESSAGING GROUP INTELLIGENCE</p><label className="languagePicker"><span>🌐</span><select aria-label="Language" value={locale} onChange={(event) => selectLocale(event.target.value)}>{locales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label></div>
    <h1>{t("verificationTitle")}</h1>{state === "working" && <p className="muted">{t("verificationWorking")}</p>}{state === "success" && <><div className="successNotice">{t("verificationSuccess")}</div><p className="authSwitch"><Link href="/login">{t("signIn")}</Link></p></>}{state === "error" && <><div className="notice">{t("verificationFailed")}</div><p className="authSwitch"><Link href="/register">{t("createAccount")}</Link></p></>}
  </section></main>;
}
