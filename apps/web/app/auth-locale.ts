"use client";

import { useContext, useEffect, useState } from "react";
import {
  detectBrowserLocale,
  isSupportedLocale,
  Locale,
  readLocaleCookie,
  supportedLocales,
  translateAuth,
  writeLocaleCookie,
} from "./i18n";
import { AppLocaleContext } from "./app-locale";

export function useAuthLocale() {
  const appLocale = useContext(AppLocaleContext);
  const [locale, setLocale] = useState<Locale>("de");

  useEffect(() => {
    if (appLocale) return;
    const preferred = readLocaleCookie(document.cookie) ?? detectBrowserLocale(navigator.languages ?? [navigator.language]);
    setLocale(preferred);
    document.documentElement.lang = preferred;
    writeLocaleCookie(preferred);
  }, [appLocale]);

  function selectLocale(value: string) {
    if (appLocale) {
      appLocale.selectLocale(value);
      return;
    }
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.documentElement.lang = value;
    writeLocaleCookie(value);
  }

  return {
    locale: appLocale?.locale ?? locale,
    selectLocale,
    locales: supportedLocales,
    t: (key: Parameters<typeof translateAuth>[1]) => translateAuth(appLocale?.locale ?? locale, key),
  };
}
