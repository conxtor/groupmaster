"use client";

import { useAppLocale } from "./app-locale";

const repositoryUrl = "https://github.com/conxtor/groupmaster";
const licenseUrl = "https://opensource.org/license/mit";

export default function SiteFooter() {
  const { t } = useAppLocale();

  return <footer className="siteFooter" aria-label={t("footer")}>
    <span>© 2026 Volker Kerkhoff</span>
    <a href={repositoryUrl} target="_blank" rel="noopener noreferrer">{t("sourceCode")}</a>
    <a href={licenseUrl} target="_blank" rel="noopener noreferrer">{t("licenseMit")}</a>
  </footer>;
}
