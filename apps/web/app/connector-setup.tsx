"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { apiFetch } from "./auth";
import { localeCodes, translate, type Locale, type TranslationKey, type TranslationValues } from "./i18n";

type Translator = (key: TranslationKey, values?: TranslationValues) => string;
export type ConnectorSnapshot = {
  accountId?: string;
  platform?: string;
  label?: string;
  connector?: string;
  status: string;
  connected?: boolean;
  mode?: string;
  qr?: string | null;
  expiresAt?: string | null;
  qrExpiresAt?: number | null;
  qrLoginActive?: boolean;
  requestId?: string | null;
  lastError?: string | null;
  queuePosition?: number | null;
  queueLength?: number | null;
  waitReason?: string | null;
  leaseKind?: string | null;
};

const qrPollAttempts = 180;

function isConnectedSnapshot(snapshot: ConnectorSnapshot | null | undefined) {
  return snapshot?.connected === true || snapshot?.status === "ready" || snapshot?.status === "paused" || snapshot?.status === "completed" || snapshot?.status === "connected";
}

function connectorLabel(snapshot: ConnectorSnapshot | null, t: Translator) {
  if (!snapshot) return t("connectorNeedsAuth");
  if (isConnectedSnapshot(snapshot)) return t("connectorConnected");
  if (snapshot.status === "pairing" || snapshot.status === "reauth_required") return t("connectorNeedsAuth");
  if (snapshot.status === "error") return t("connectorError");
  return snapshot.status;
}

function connectorHint(snapshot: ConnectorSnapshot | null, t: Translator) {
  if (snapshot?.waitReason) {
    const hasPosition = typeof snapshot.queuePosition === "number" && typeof snapshot.queueLength === "number";
    const position = hasPosition ? ` · ${t("connectorQueuePosition", { position: snapshot.queuePosition as number, count: snapshot.queueLength as number })}` : "";
    return `${t("connectorQueueWaiting")}${position}`;
  }
  return snapshot?.lastError ?? (isConnectedSnapshot(snapshot) ? t("connectorConnected") : t("waitingForQr"));
}

export function ConnectorSetup({ locale }: { locale: Locale }) {
  const t = (key: TranslationKey, values?: TranslationValues) => translate(locale, key, values);
  const [whatsapp, setWhatsapp] = useState<ConnectorSnapshot | null>(null);
  const [telegram, setTelegram] = useState<ConnectorSnapshot | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState<string | null>(null);
  const refreshInFlight = useRef<Promise<{ whatsapp: ConnectorSnapshot | null; telegram: ConnectorSnapshot | null } | null> | null>(null);

  async function refreshStatus() {
    if (refreshInFlight.current) return refreshInFlight.current;
    const refresh = (async () => {
      try {
        const accountsResponse = await apiFetch("/api/v1/connectors/accounts");
        if (!accountsResponse.ok) throw new Error(t("connectorError"));
        let accounts = await accountsResponse.json() as Array<{ id: string; platform: string; label: string; status: string; lastError?: string | null }>;
        for (const platform of ["whatsapp", "telegram"]) {
          if (!accounts.some((account) => account.platform === platform)) {
            const created = await apiFetch("/api/v1/connectors/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform }) });
            if (created.ok) accounts = [...accounts, await created.json() as typeof accounts[number]];
          }
        }
        const snapshots = await Promise.all(["whatsapp", "telegram"].map(async (platform) => {
          const account = accounts.find((item) => item.platform === platform);
          if (!account) return null;
          const qrResponse = await apiFetch(`/api/v1/connectors/accounts/${account.id}/qr`);
          if (!qrResponse.ok) {
            const body = await qrResponse.json().catch(() => null) as { error?: string } | null;
            throw new Error(body?.error ?? `${t("connectorError")} (${qrResponse.status})`);
          }
          const qr = await qrResponse.json() as ConnectorSnapshot;
          return { ...account, ...qr, accountId: account.id, platform, connector: platform } as ConnectorSnapshot;
        }));
        setWhatsapp(snapshots[0]);
        setTelegram(snapshots[1]);
        setSetupError(null);
        return { whatsapp: snapshots[0], telegram: snapshots[1] };
      } catch (error) {
        setSetupError(error instanceof Error ? error.message : t("connectorError"));
        return null;
      }
    })();
    refreshInFlight.current = refresh;
    try {
      return await refresh;
    } finally {
      if (refreshInFlight.current === refresh) refreshInFlight.current = null;
    }
  }

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 4000);
    return () => window.clearInterval(timer);
  }, [locale]);

  async function startQr(snapshot: ConnectorSnapshot | null) {
    if (!snapshot?.accountId) return;
    setQrBusy(snapshot.accountId);
    try {
      const response = await apiFetch(`/api/v1/connectors/accounts/${snapshot.accountId}/qr`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? t("connectorError"));
      }
      const platform = snapshot.platform === "telegram" ? "telegram" : "whatsapp";
      for (let attempt = 0; attempt < qrPollAttempts; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const next = await refreshStatus();
        const current = next?.[platform];
        if (current?.qr || current?.status === "failed" || current?.status === "expired" || isConnectedSnapshot(current)) break;
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : t("connectorError"));
    } finally {
      setQrBusy(null);
    }
  }

  async function logoutConnector(snapshot: ConnectorSnapshot | null) {
    if (!snapshot?.accountId || !window.confirm(t("logoutConnectorConfirm"))) return;
    setQrBusy(snapshot.accountId);
    try {
      const response = await apiFetch(`/api/v1/connectors/accounts/${snapshot.accountId}/qr`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? t("logoutConnectorError"));
      }
      await refreshStatus();
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : t("logoutConnectorError"));
    } finally {
      setQrBusy(null);
    }
  }

  const whatsappConnected = isConnectedSnapshot(whatsapp);
  const telegramConnected = isConnectedSnapshot(telegram);

  return <section className="connectorSetup panel">
    <div className="panelHead"><div><p className="eyebrow">{t("connectors")}</p><h2>{t("connectorSetup")}</h2><p className="muted">{t("connectorSetupHint")}</p></div><button className="textButton" onClick={() => void refreshStatus()}>{t("refreshStatus")}</button></div>
    <div className="connectorSetupBody">
      {setupError && <div className="notice setupNotice">{setupError}</div>}
      <div className="connectorCards">
        <article className="connectorCard"><div className="connectorCardHead"><div><p className="eventGroup">{t("whatsappConnector")}</p><strong>{connectorLabel(whatsapp, t)}</strong></div><span className={`connectorDot ${whatsappConnected ? "ready" : ""}`} /></div>{whatsapp?.qr && !whatsappConnected ? <div className="connectorQr"><QRCodeSVG value={whatsapp.qr} size={168} includeMargin level="M" role="img" aria-label={t("scanWithWhatsapp")} /><p>{t("scanWithWhatsapp")}</p></div> : whatsappConnected ? <><p className="connectorHint">{connectorHint(whatsapp, t)}</p><button className="dangerButton" disabled={qrBusy === whatsapp?.accountId} onClick={() => void logoutConnector(whatsapp)}>{qrBusy === whatsapp?.accountId ? t("loggingOutConnector") : t("logoutConnector")}</button></> : <><p className="connectorHint">{connectorHint(whatsapp, t)}</p><button className="primaryButton" disabled={!whatsapp?.accountId || qrBusy === whatsapp?.accountId} onClick={() => void startQr(whatsapp)}>{qrBusy === whatsapp?.accountId ? t("waitingForQr") : t("startWhatsappQr")}</button></>}</article>
        <article className="connectorCard"><div className="connectorCardHead"><div><p className="eventGroup">{t("telegramConnector")}</p><strong>{connectorLabel(telegram, t)}</strong></div><span className={`connectorDot ${telegramConnected ? "ready" : ""}`} /></div>{telegram?.qr && !telegramConnected ? <div className="connectorQr"><QRCodeSVG value={telegram.qr} size={168} includeMargin level="M" role="img" aria-label={t("startTelegramQr")} /><p>{telegram.expiresAt ? t("qrExpires", { time: new Date(telegram.expiresAt).toLocaleTimeString(localeCodes[locale], { hour: "2-digit", minute: "2-digit" }) }) : t("waitingForQr")}</p></div> : telegramConnected ? <><p className="connectorHint">{connectorHint(telegram, t)}</p><button className="dangerButton" disabled={qrBusy === telegram?.accountId} onClick={() => void logoutConnector(telegram)}>{qrBusy === telegram?.accountId ? t("loggingOutConnector") : t("logoutConnector")}</button></> : <><p className="connectorHint">{connectorHint(telegram, t)}</p><button className="primaryButton" disabled={!telegram?.accountId || qrBusy === telegram?.accountId} onClick={() => void startQr(telegram)}>{qrBusy === telegram?.accountId ? t("waitingForQr") : t("startTelegramQr")}</button></>}</article>
      </div>
    </div>
  </section>;
}
