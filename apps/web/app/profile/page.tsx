"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthGate, apiFetch } from "../auth";
import { localeNames, translate, TranslationKey } from "../i18n";
import { useAuthLocale } from "../auth-locale";

type ProfileUser = { name: string; email: string; preferredLocale?: string };

function ProfileContent() {
  const router = useRouter();
  const { locale, selectLocale, locales, t } = useAuthLocale();
  const dashboardText = (key: TranslationKey) => translate(locale, key);
  const [profile, setProfile] = useState<ProfileUser | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch("/api/v1/auth/me").then(async (response) => {
      if (!response.ok) return;
      const value = await response.json() as ProfileUser;
      setProfile(value); setName(value.name); setEmail(value.email);
      if (value.preferredLocale && value.preferredLocale !== locale) selectLocale(value.preferredLocale);
    }).catch(() => setError(t("profileError")));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      const response = await apiFetch("/api/v1/auth/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, locale, currentPassword, newPassword }) });
      const body = await response.json().catch(() => null) as { error?: string; verificationRequired?: boolean; sessionRevoked?: boolean } | null;
      if (!response.ok) throw new Error(body?.error ?? t("profileError"));
      setNotice(body?.verificationRequired ? t("profileVerificationSent") : t("profileSaved"));
      setCurrentPassword(""); setNewPassword("");
      if (body?.sessionRevoked || body?.verificationRequired) window.setTimeout(() => router.replace("/login"), 1200);
    } catch (value) { setError(value instanceof Error ? value.message : t("profileError")); }
    finally { setBusy(false); }
  }

  return <main className="shell profilePage"><header className="topbar"><div><p className="eyebrow">WAGI / ACCOUNT</p><h1>{t("profileTitle")}</h1><p className="muted">{t("profileHint")}</p></div><nav className="pageNav"><Link href="/">{dashboardText("dashboard")}</Link><Link className="pageNavActive" href="/profile">{t("profileLink")}</Link></nav></header>
    <section className="authCard panel profileCard"><div className="profileTools"><label className="languagePicker"><span>{dashboardText("language")}</span><select aria-label={dashboardText("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{locales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label></div>
      {profile && <form className="authForm" onSubmit={submit}><label>{t("name")}<input type="text" required minLength={2} value={name} onChange={(event) => setName(event.target.value)} /></label><label>{t("email")}<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>{t("currentPassword")}<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label><label>{t("newPassword")}<input type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /><small>{t("passwordMinimum")}</small></label>{error && <div className="notice">{error}</div>}{notice && <div className="successNotice">{notice}</div>}<button className="primaryButton" disabled={busy}>{busy ? t("savingProfile") : t("saveProfile")}</button></form>}
    </section>
  </main>;
}

export default function ProfilePage() { return <AuthGate><ProfileContent /></AuthGate>; }
