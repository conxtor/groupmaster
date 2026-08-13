"use client";

import { useEffect, useState } from "react";
import {
  detectBrowserLocale,
  isSupportedLocale,
  Locale,
  readLocaleCookie,
  supportedLocales,
  translateAuth,
  writeLocaleCookie,
} from "./i18n";

export function useAuthLocale() {
  const [locale, setLocale] = useState<Locale>("de");

  useEffect(() => {
    const preferred = readLocaleCookie(document.cookie) ?? detectBrowserLocale(navigator.languages ?? [navigator.language]);
    setLocale(preferred);
    document.documentElement.lang = preferred;
    writeLocaleCookie(preferred);
  }, []);

  function selectLocale(value: string) {
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.documentElement.lang = value;
    writeLocaleCookie(value);
  }

  return {
    locale,
    selectLocale,
    locales: supportedLocales,
    t: (key: Parameters<typeof translateAuth>[1]) => translateAuth(locale, key),
  };
}
