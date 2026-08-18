"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  detectBrowserLocale,
  isSupportedLocale,
  Locale,
  readLocaleCookie,
  supportedLocales,
  translate,
  TranslationKey,
  TranslationValues,
  writeLocaleCookie,
} from "./i18n";

type AppLocaleContextValue = {
  locale: Locale;
  selectLocale: (value: string) => void;
  locales: readonly Locale[];
  t: (key: TranslationKey, values?: TranslationValues) => string;
};

export const AppLocaleContext = createContext<AppLocaleContextValue | null>(null);

export function AppLocaleProvider({ children }: { children: React.ReactNode }) {
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

  const value = useMemo<AppLocaleContextValue>(() => ({
    locale,
    selectLocale,
    locales: supportedLocales,
    t: (key, values) => translate(locale, key, values),
  }), [locale]);

  return <AppLocaleContext.Provider value={value}>{children}</AppLocaleContext.Provider>;
}

export function useAppLocale() {
  const context = useContext(AppLocaleContext);
  if (!context) throw new Error("useAppLocale must be used inside AppLocaleProvider");
  return context;
}
