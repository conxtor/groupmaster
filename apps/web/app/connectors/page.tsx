"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthGate, useAppLocale } from "../auth";
import { ConnectorSetup } from "../connector-setup";

export default function ConnectorsPage() {
  const [live, setLive] = useState(false);
  const { locale, t } = useAppLocale();

  return <AuthGate><main className="shell connectorPage">
    <header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{t("connectorSetup")}</h1></div></header>
    <section className="selectionIntro"><div><p className="eyebrow">{t("connectors")}</p><p className="selectionLead">{t("connectorSetupHint")}</p></div></section>
    <ConnectorSetup locale={locale} />
    <footer><span>{t("footer")}</span><Link href="/">{t("openDashboard")}</Link></footer>
  </main></AuthGate>;
}
