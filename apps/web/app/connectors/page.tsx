"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate } from "../auth";
import { ConnectorSetup } from "../connector-setup";
import {
  detectBrowserLocale,
  isSupportedLocale,
  localeNames,
  readLocaleCookie,
  supportedLocales,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationValues,
} from "../i18n";

export default function ConnectorsPage() {
  const [locale, setLocale] = useState<Locale>("de");
  const [live, setLive] = useState(false);
  const t = (key: TranslationKey, values?: TranslationValues) => translate(locale, key, values);

  useEffect(() => {
    const savedLocale = readLocaleCookie(document.cookie);
    const browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language];
    const nextLocale = savedLocale ?? detectBrowserLocale(browserLanguages);
    setLocale(nextLocale);
    document.cookie = `wagi_locale=${nextLocale}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  function selectLocale(value: string) {
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.cookie = `wagi_locale=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }

  return <AuthGate><main className="shell connectorPage">
    <header className="topbar">
      <div><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><h1>{t("connectorSetup")}</h1></div>
      <div className="topbarTools"><nav className="pageNav"><Link href="/">{t("dashboard")}</Link><Link href="/knowledge">{t("knowledge")}</Link><Link href="/connectors" className="pageNavActive">{t("connectors")}</Link><Link href="/groups">{t("manageGroups")}</Link></nav><label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{supportedLocales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label><div className="status"><span className={`dot ${live ? "on" : ""}`} />{live ? t("liveConnected") : t("localPreview")}</div></div>
    </header>
    <section className="selectionIntro"><div><p className="eyebrow">{t("connectors")}</p><p className="selectionLead">{t("connectorSetupHint")}</p></div></section>
    <ConnectorSetup locale={locale} />
    <footer><span>{t("footer")}</span><Link href="/">{t("openDashboard")}</Link></footer>
  </main></AuthGate>;
}
