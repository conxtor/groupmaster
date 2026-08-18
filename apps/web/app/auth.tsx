"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAppLocale } from "./app-locale";
import { localeNames, translateAuth } from "./i18n";
export { useAppLocale } from "./app-locale";

export const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  roles: string[];
};

export async function apiFetch(path: string, init: RequestInit = {}) {
  return fetch(`${apiBase.replace(/\/$/, "")}${path}`, { ...init, credentials: "include" });
}

function logoutUser(router: ReturnType<typeof useRouter>) {
  return apiFetch("/api/v1/auth/logout", { method: "POST" }).finally(() => router.replace("/login"));
}

function AppTopNav({ user }: { user: AuthUser }) {
  const router = useRouter();
  const pathname = usePathname();
  const { locale, selectLocale, locales, t } = useAppLocale();
  const isAdmin = user.roles.includes("admin");

  const links = [
    ["/", t("dashboard")],
    ["/knowledge", t("knowledge")],
    ["/groups", t("manageGroups")],
    ["/connectors", t("connectors")],
    ["/replays", t("replayBackfill")],
    ["/profile", t("profile")],
  ] as const;
  const adminLinks = isAdmin ? [
    ["/admin", t("adminOverview")],
    ["/admin/users", t("adminUsers")],
    ["/admin/ai-learning", t("adminLearning")],
    ["/admin/knowledge-topics", t("adminKnowledgeTopics")],
  ] as const : [];

  function isActive(href: string) {
    return href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  }

  return <header className="appTopbar">
    <Link href="/" className="appBrand" aria-label={t("appName")}><strong>CONXTOR</strong><span>{t("appDescriptor")}</span></Link>
    <nav className="globalNav" aria-label={t("mainNavigation")}>
      {links.map(([href, label]) => <Link key={href} href={href} className={isActive(href) ? "active" : ""}>{label}</Link>)}
      {adminLinks.length > 0 && <span className="navDivider" aria-hidden="true" />}
      {adminLinks.map(([href, label]) => <Link key={href} href={href} className={isActive(href) ? "active adminNavLink" : "adminNavLink"}>{label}</Link>)}
    </nav>
    <div className="appTopbarTools">
      <label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{locales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label>
      <span className="appUser"><strong>{user.name}</strong><small>{user.email}</small></span>
      <button type="button" className="textButton" onClick={() => void logoutUser(router)}>{t("logout")}</button>
    </div>
  </header>;
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { locale } = useAppLocale();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void apiFetch("/api/v1/auth/me").then(async (response) => {
      if (!active) return;
      if (!response.ok) {
        router.replace(`/login?next=${encodeURIComponent(pathname || "/")}`);
        return;
      }
      setUser(await response.json() as AuthUser);
      setLoading(false);
    }).catch(() => {
      if (active) router.replace(`/login?next=${encodeURIComponent(pathname || "/")}`);
    });
    return () => { active = false; };
  }, [pathname, router]);

  if (loading || !user) return <main className="shell authLoading"><p className="muted">{translateAuth(locale, "sessionChecking")}</p></main>;
  return <><AppTopNav user={user} />{children}</>;
}
