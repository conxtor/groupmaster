"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import EventMap from "./event-map";
import { buildGroupHierarchy, type GroupHierarchyNode } from "./group-hierarchy";
import {
  detectBrowserLocale,
  isSupportedLocale,
  localeCodes,
  localeNames,
  readLocaleCookie,
  supportedLocales,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationValues,
} from "./i18n";

type Place = { name: string; latitude?: number; longitude?: number };
type Event = { title: string; startsAt?: string; location?: string; sourceMessageIds?: string[] };
type Analysis = { relevant?: boolean; score?: number; summary?: string; places?: Place[]; events?: Event[] };
type Group = { id: string; subject: string; participantCount: number; isSelected: boolean; discoveredAt: string; platform?: "whatsapp" | "telegram"; chatType?: "group" | "supergroup" | "channel" | "topic"; language?: "de" | "es" | "ca" | "en" | "fr"; parentGroupId?: string; topicId?: number };
type Message = { id: string; groupId: string; groupSubject: string; senderJid: string; senderName?: string; kind: string; text?: string; replyToWaMessageId?: string; platform?: string; imageUrl?: string; mediaUrl?: string; thumbnailUrl?: string; receivedAt: string; hasMedia: boolean; analysis?: Analysis };
type EventVersion = { event: Event; place?: Place; updatedAt: string; sourceMessageIds: string[]; updateMessage?: Message };
type EventRecord = { key: string; groupId: string; groupSubject: string; groupPlatform?: string; versions: EventVersion[] };
type Translator = (key: TranslationKey, values?: TranslationValues) => string;
type ConnectorSnapshot = { connector: string; status: string; mode?: string; connected?: boolean; qr?: string | null; qrExpiresAt?: number | null; qrLoginActive?: boolean; lastError?: string | null };

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const waConnectorBase = process.env.NEXT_PUBLIC_WA_CONNECTOR_URL ?? "http://localhost:3001";
const tgConnectorBase = process.env.NEXT_PUBLIC_TG_CONNECTOR_URL ?? "http://localhost:3002";
const demoTimestamp = "2026-08-10T12:00:00.000Z";
const sampleGroups: Group[] = [
  { id: "120363mock@g.us", subject: "Barcelona Wochenende", participantCount: 6, isSelected: true, discoveredAt: demoTimestamp },
  { id: "120363mock2@g.us", subject: "Familie Costa Brava", participantCount: 5, isSelected: true, discoveredAt: demoTimestamp },
  { id: "120363mock3@g.us", subject: "Remote Team Europa", participantCount: 8, isSelected: true, discoveredAt: demoTimestamp },
];
const sampleMessages: Message[] = [
  { id: "sample-1", groupId: "120363mock@g.us", groupSubject: "Barcelona Wochenende", senderJid: "491701234567@s.whatsapp.net", senderName: "Alex", kind: "text", text: "Treffen wir uns Samstag um 10 Uhr für die Wanderung?", receivedAt: demoTimestamp, hasMedia: false, analysis: { relevant: true, score: 0.86, summary: "Wanderung mit Ort aus mehreren Nachrichten", events: [{ title: "Wanderung — Kloster Montserrat", startsAt: "Samstag 10:00", location: "Kloster Montserrat", sourceMessageIds: ["sample-1", "sample-location"] }] } },
  { id: "sample-location", groupId: "120363mock@g.us", groupSubject: "Barcelona Wochenende", senderJid: "491701234567@s.whatsapp.net", senderName: "Alex", kind: "location", text: "Kloster Montserrat — 08199 Monistrol de Montserrat", receivedAt: demoTimestamp, hasMedia: false, analysis: { places: [{ name: "Kloster Montserrat", latitude: 41.5933, longitude: 1.8372 }] } },
  { id: "sample-image", groupId: "120363mock@g.us", groupSubject: "Barcelona Wochenende", senderJid: "491761112233@s.whatsapp.net", senderName: "Lena", kind: "image", text: "Die aktuelle Routenkarte für den Montserrat-Aufstieg.", imageUrl: "/mock/barcelona-route.svg", receivedAt: demoTimestamp, hasMedia: true },
  { id: "sample-2", groupId: "120363mock2@g.us", groupSubject: "Familie Costa Brava", senderJid: "491709876543@s.whatsapp.net", senderName: "Sam", kind: "audio", text: "Audio wartet auf Transkription", receivedAt: demoTimestamp, hasMedia: true },
];

function connectorLabel(snapshot: ConnectorSnapshot | null, t: Translator) {
  if (!snapshot) return t("connectorNeedsAuth");
  if (snapshot.status === "ready") return t("connectorConnected");
  if (snapshot.status === "pairing" || snapshot.status === "reauth_required") return t("connectorNeedsAuth");
  if (snapshot.status === "error") return t("connectorError");
  return snapshot.status;
}

function ConnectorSetup({ locale }: { locale: Locale }) {
  const t = (key: TranslationKey, values?: TranslationValues) => translate(locale, key, values);
  const [whatsapp, setWhatsapp] = useState<ConnectorSnapshot | null>(null);
  const [telegram, setTelegram] = useState<ConnectorSnapshot | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [telegramQrBusy, setTelegramQrBusy] = useState(false);

  async function refreshStatus() {
    try {
      const [waResponse, tgResponse] = await Promise.all([
        fetch(`${waConnectorBase}/status`),
        fetch(`${tgConnectorBase}/status`),
      ]);
      if (!waResponse.ok || !tgResponse.ok) throw new Error(t("connectorError"));
      setWhatsapp(await waResponse.json() as ConnectorSnapshot);
      setTelegram(await tgResponse.json() as ConnectorSnapshot);
      setSetupError(null);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : t("connectorError"));
    }
  }

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 4000);
    return () => window.clearInterval(timer);
  }, [locale]);

  async function startTelegramQr() {
    setTelegramQrBusy(true);
    try {
      const response = await fetch(`${tgConnectorBase}/auth/qr`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? t("connectorError"));
      }
      await refreshStatus();
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : t("connectorError"));
    } finally { setTelegramQrBusy(false); }
  }

  return <section className="connectorSetup panel">
    <div className="panelHead"><div><p className="eyebrow">{t("connectors")}</p><h2>{t("connectorSetup")}</h2><p className="muted">{t("connectorSetupHint")}</p></div><button className="textButton" onClick={() => void refreshStatus()}>{t("refreshStatus")}</button></div>
    <div className="connectorSetupBody">
      {setupError && <div className="notice setupNotice">{setupError}</div>}
      <div className="connectorCards">
        <article className="connectorCard"><div className="connectorCardHead"><div><p className="eventGroup">{t("whatsappConnector")}</p><strong>{connectorLabel(whatsapp, t)}</strong></div><span className={`connectorDot ${whatsapp?.status === "ready" ? "ready" : ""}`} /></div>{whatsapp?.qr ? <div className="connectorQr"><QRCodeSVG value={whatsapp.qr} size={168} includeMargin level="M" /><p>{t("scanWithWhatsapp")}</p></div> : <p className="connectorHint">{whatsapp?.lastError ?? (whatsapp?.status === "ready" ? t("connectorConnected") : t("waitingForQr"))}</p>}</article>
        <article className="connectorCard"><div className="connectorCardHead"><div><p className="eventGroup">{t("telegramConnector")}</p><strong>{connectorLabel(telegram, t)}</strong></div><span className={`connectorDot ${telegram?.status === "ready" ? "ready" : ""}`} /></div>{telegram?.qr ? <div className="connectorQr"><QRCodeSVG value={telegram.qr} size={168} includeMargin level="M" /><p>{telegram.qrExpiresAt ? t("qrExpires", { time: new Date(telegram.qrExpiresAt).toLocaleTimeString(localeCodes[locale], { hour: "2-digit", minute: "2-digit" }) }) : t("waitingForQr")}</p></div> : <><p className="connectorHint">{telegram?.lastError ?? (telegram?.mode === "telegram-direct" ? t("directTelegramOnly") : t("directTelegramConfigRequired"))}</p><button className="primaryButton" disabled={telegramQrBusy || !telegram || telegram.mode !== "telegram-direct"} onClick={() => void startTelegramQr()}>{telegramQrBusy ? t("waitingForQr") : t("startTelegramQr")}</button></>}</article>
      </div>
    </div>
  </section>;
}

function time(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeCodes[locale], { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }).format(new Date(value));
}

function kindLabel(kind: string, locale: Locale) {
  const key = kind === "audio" ? "audio" : kind === "image" ? "image" : kind === "location" ? "location" : kind === "video" ? "video" : "text";
  return translate(locale, key);
}

function resolveMediaUrl(value?: string) {
  if (!value) return undefined;
  if (!value.startsWith("/api/")) return value;
  return `${apiBase.replace(/\/$/, "")}${value}`;
}

function imageSource(message: Message) {
  return resolveMediaUrl(message.thumbnailUrl ?? message.mediaUrl ?? message.imageUrl);
}

function messageGroupSubject(message: Message, t: Translator) {
  return message.platform === "whatsapp" && message.groupSubject === message.groupId ? t("whatsappGroup") : message.groupSubject;
}

function DashboardGroupBranch({ node, selectedGroup, onSelect, t, depth = 0 }: { node: GroupHierarchyNode<Group>; selectedGroup: string; onSelect: (groupId: string) => void; t: Translator; depth?: number }) {
  const selectable = node.group.isSelected;
  const subject = groupSubjectLabel(node.group, t);
  return <div className={`dashboardGroupBranch ${depth > 0 ? "nestedGroupBranch" : ""}`}>
    <button className={`groupRow ${selectedGroup === node.group.id ? "active" : ""} ${depth > 0 ? "topicRow" : ""} ${!selectable ? "groupContext" : ""}`} disabled={!selectable} onClick={() => onSelect(node.group.id)}>
      <span className={`avatar ${depth === 0 ? "supergroupAvatar" : ""}`}>{subject.slice(0, 1).toUpperCase()}</span>
      <span><strong>{subject}</strong><small>{node.group.platform === "telegram" ? "Telegram" : "WhatsApp"} · {groupTypeLabel(node.group, t)} · {t("members", { count: node.group.participantCount })}</small></span>
    </button>
    {node.children.length > 0 && <div className="groupChildren">{node.children.map((child) => <DashboardGroupBranch key={child.group.id} node={child} selectedGroup={selectedGroup} onSelect={onSelect} t={t} depth={depth + 1} />)}</div>}
  </div>;
}

function groupTypeLabel(group: Group, t: Translator) {
  if (group.chatType === "topic") return t("topic");
  if (group.chatType === "channel") return t("channel");
  if (group.chatType === "supergroup") return t("supergroup");
  return t("group");
}

function groupSubjectLabel(group: Group, t: Translator) {
  return group.platform === "whatsapp" && group.subject === group.id ? t("whatsappGroup") : group.subject;
}

function placeForEvent(event: Event, messages: Message[]) {
  const sourceIds = new Set(event.sourceMessageIds ?? []);
  const candidates = messages
    .filter((message) => sourceIds.has(message.id))
    .flatMap((message) => message.analysis?.places ?? [])
    .filter((place) => typeof place.latitude === "number" && typeof place.longitude === "number");
  if (!candidates.length) return undefined;
  const eventText = `${event.location ?? ""} ${event.title}`.toLocaleLowerCase();
  return candidates.find((place) => place.name && eventText.includes(place.name.toLocaleLowerCase())) ?? candidates.at(-1);
}

function eventTitle(event: Event) {
  return event.title.split(" — ")[0] || event.title;
}

function eventLocation(version: EventVersion, t: Translator) {
  return version.event.location ?? version.place?.name ?? t("locationOpen");
}

function eventSignature(event: Event, place?: Place) {
  return [event.title, event.startsAt, event.location, place?.latitude, place?.longitude].join("|");
}

function eventKey(event: Event, message: Message) {
  return `${message.groupId}:${event.sourceMessageIds?.[0] ?? eventTitle(event)}`;
}

function versionChange(previous: EventVersion, current: EventVersion, locale: Locale) {
  const t = (key: TranslationKey, values?: TranslationValues) => translate(locale, key, values);
  const changes: string[] = [];
  const previousLocation = previous.event.location ?? previous.place?.name;
  const currentLocation = current.event.location ?? current.place?.name;
  if (previousLocation !== currentLocation) changes.push(t("locationChange", { from: previousLocation ?? t("locationOpen"), to: currentLocation ?? t("locationOpen") }));
  if (previous.event.startsAt !== current.event.startsAt) changes.push(t("timeChange", { from: previous.event.startsAt ?? t("open"), to: current.event.startsAt ?? t("open") }));
  if (eventTitle(previous.event) !== eventTitle(current.event)) changes.push(t("descriptionUpdated"));
  return changes.length ? changes.join(" · ") : t("moreSources");
}

function eventVersions(messages: Message[]) {
  const records = new Map<string, EventRecord>();
  const orderedMessages = [...messages].sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
  for (const message of orderedMessages) {
    for (const event of message.analysis?.events ?? []) {
      const place = placeForEvent(event, messages);
      const sourceMessages = (event.sourceMessageIds ?? [])
        .map((sourceId) => messages.find((candidate) => candidate.id === sourceId))
        .filter((candidate): candidate is Message => Boolean(candidate));
      const updateMessage = [...sourceMessages, message].sort((left, right) => left.receivedAt.localeCompare(right.receivedAt)).at(-1);
      const updatedAt = updateMessage?.receivedAt ?? message.receivedAt;
      const key = eventKey(event, message);
      const signature = eventSignature(event, place);
      const record = records.get(key) ?? { key, groupId: message.groupId, groupSubject: message.groupSubject, groupPlatform: message.platform, versions: [] };
      const existing = record.versions.find((version) => eventSignature(version.event, version.place) === signature);
      if (existing) {
        existing.sourceMessageIds = [...new Set([...existing.sourceMessageIds, ...(event.sourceMessageIds ?? []), message.id])];
        if (updatedAt > existing.updatedAt) { existing.updatedAt = updatedAt; existing.updateMessage = updateMessage; }
      } else {
        record.versions.push({ event, place, updatedAt, sourceMessageIds: [...new Set([...(event.sourceMessageIds ?? []), message.id])], updateMessage });
      }
      records.set(key, record);
    }
  }
  return [...records.values()]
    .map((record) => ({ ...record, versions: record.versions.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)) }))
    .sort((left, right) => (right.versions.at(-1)?.updatedAt ?? "").localeCompare(left.versions.at(-1)?.updatedAt ?? ""));
}

function eventDate(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeCodes[locale], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }).format(new Date(value));
}

function EventBoard({ events, locale }: { events: EventRecord[]; locale: Locale }) {
  const t = (key: TranslationKey, values?: TranslationValues) => translate(locale, key, values);
  if (!events.length) return null;
  return (
    <div className="eventsBoard">
      <div className="eventsBoardHead"><div><p className="eyebrow">{t("currentEvents")}</p><h2>{t("eventsHeadline")}</h2><p className="muted">{t("eventsSubtitle")}</p></div><span className="count">{events.length}</span></div>
      <div className="eventList">{events.map((record) => {
        const current = record.versions.at(-1)!;
        const location = eventLocation(current, t);
        return <article className="eventCard" key={record.key}>
          <div className="eventCardHead"><div><p className="eventGroup">{record.groupPlatform === "whatsapp" && record.groupSubject === record.groupId ? t("whatsappGroup") : record.groupSubject}</p><h3>{eventTitle(current.event)}</h3><p className="eventMeta">{location}{current.event.startsAt ? ` · ${current.event.startsAt}` : ""}</p></div><span className="eventState">{record.versions.length > 1 ? t("updated") : t("new")}</span></div>
          <div className="eventSourceLine">{t("sourceMessages", { count: current.sourceMessageIds.length, date: eventDate(current.updatedAt, locale) })}</div>
          {current.place ? <EventMap latitude={current.place.latitude!} longitude={current.place.longitude!} label={location} mapLabel={t("mapFor", { label: location })} /> : <div className="mapMissing">{t("noCoordinates")}</div>}
          {record.versions.length > 1 && <div className="eventHistory"><div className="eventHistoryHead"><strong>{t("changeHistory")}</strong><span>{t("versions", { count: record.versions.length })}</span></div><ol>{[...record.versions].reverse().map((version, index, newestFirst) => { const chronologicalIndex = record.versions.indexOf(version); return <li key={`${record.key}-${version.updatedAt}-${index}`} className={index === 0 ? "current" : ""}><div className="historyMeta"><time dateTime={version.updatedAt}>{eventDate(version.updatedAt, locale)}</time><strong>{index === 0 ? t("current") : t("version", { number: chronologicalIndex + 1 })}</strong></div>{index < newestFirst.length - 1 && <p className="historyChange">{versionChange(newestFirst[index + 1], version, locale)}</p>}<p>{eventLocation(version, t)}{version.event.startsAt ? ` · ${version.event.startsAt}` : ""}</p>{version.updateMessage?.text && <small>{t("source", { text: version.updateMessage.text })}</small>}</li>; })}</ol></div>}
        </article>;
      })}</div>
    </div>
  );
}

export default function Dashboard() {
  const [groups, setGroups] = useState<Group[]>(sampleGroups);
  const [messages, setMessages] = useState<Message[]>(sampleMessages);
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("de");

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

  useEffect(() => {
    let active = true;
    async function loadDashboard() {
      try {
        const [groupsResponse, messagesResponse] = await Promise.all([fetch(`${apiBase}/api/v1/groups`), fetch(`${apiBase}/api/v1/messages?limit=100&relevant=true`)]);
        if (!groupsResponse.ok || !messagesResponse.ok) throw new Error("API nicht erreichbar");
        const nextGroups = await groupsResponse.json() as Group[];
        const nextMessages = await messagesResponse.json() as Message[];
        if (active) { setGroups(nextGroups); setMessages(nextMessages); setLive(true); setError(null); }
      } catch { if (active) setError(t("demoNotice")); }
    }
    void loadDashboard();
    const timer = window.setInterval(() => void loadDashboard(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [locale]);

  const visibleMessages = useMemo(() => selectedGroup === "all" ? messages : messages.filter((message) => message.groupId === selectedGroup), [messages, selectedGroup]);
  const eventRecords = useMemo(() => eventVersions(visibleMessages), [visibleMessages]);
  const selectedGroups = useMemo(() => groups.filter((group) => group.isSelected), [groups]);
  const dashboardGroupIds = useMemo(() => {
    const byId = new Map(groups.map((group) => [group.id, group]));
    const visible = new Set(selectedGroups.map((group) => group.id));
    for (const group of selectedGroups) {
      let parentId = group.parentGroupId;
      while (parentId) {
        visible.add(parentId);
        parentId = byId.get(parentId)?.parentGroupId;
      }
    }
    return visible;
  }, [groups, selectedGroups]);
  const dashboardHierarchy = useMemo(() => buildGroupHierarchy(groups, dashboardGroupIds), [groups, dashboardGroupIds]);

  function selectLocale(value: string) {
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.cookie = `wagi_locale=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }

  const scope = selectedGroup === "all" ? t("allSelectedGroups") : t("selectedGroup");

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><h1>{t("title")}</h1></div>
        <div className="topbarTools"><nav className="pageNav"><Link href="/" className="pageNavActive">{t("dashboard")}</Link><Link href="/knowledge">{t("knowledge")}</Link><Link href="/groups">{t("manageGroups")}</Link></nav><label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{supportedLocales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label><div className="status"><span className={`dot ${live ? "on" : ""}`} />{live ? t("liveConnected") : t("localPreview")}</div></div>
      </header>
      <section className="hero"><div><p className="eyebrow">{t("signalCheck")}</p><p className="heroNumber">{visibleMessages.filter((item) => item.analysis?.relevant).length || 1}</p><p className="muted">{t("relevantSignals", { scope })}</p></div><div className="heroNote"><span>✦</span><p>{t("heroNote")}</p></div></section>
      {error && <div className="notice">{error}</div>}
      <ConnectorSetup locale={locale} />
      <div className="grid">
        <aside className="panel groupsPanel"><div className="panelHead"><div><h2>{t("selectedGroupsOnly")}</h2><p className="muted groupSelectionHint">{t("groupSelectionHint")}</p></div><span className="count">{selectedGroups.length}</span></div><Link className="manageGroupsLink" href="/groups">{t("manageGroups")}</Link><button className={`groupRow ${selectedGroup === "all" ? "active" : ""}`} onClick={() => setSelectedGroup("all")}><span className="avatar all">✦</span><span><strong>{t("allSelected")}</strong><small>{t("liveOverview")}</small></span></button>{dashboardHierarchy.map((node) => <DashboardGroupBranch key={node.group.id} node={node} selectedGroup={selectedGroup} onSelect={setSelectedGroup} t={t} />)}</aside>
        <section className="panel feedPanel"><EventBoard events={eventRecords} locale={locale} /><div className="panelHead"><div><h2>{t("relevantMessages")}</h2><p className="muted">{t("relevantMessagesSubtitle")}</p></div><span className="count">{visibleMessages.length}</span></div><div className="feed">{visibleMessages.map((message) => { const source = imageSource(message); const original = resolveMediaUrl(message.mediaUrl) ?? source; return <article className="message" key={message.id}><div className="messageMeta"><span className="avatar small">{(message.senderName ?? "?").slice(0, 1)}</span><span><strong>{message.senderName ?? message.senderJid}</strong><small>{message.platform === "telegram" ? "Telegram" : "WhatsApp"} · {messageGroupSubject(message, t)} · {time(message.receivedAt, locale)}</small></span><span className={`kind ${message.kind}`}>{kindLabel(message.kind, locale)}</span></div>{message.replyToWaMessageId && <p className="replyRef">{t("replyTo", { id: message.replyToWaMessageId })}</p>}<p className="messageText">{message.text ?? t("noText")}</p>{message.kind === "image" && source && <figure className="imagePreview"><a href={original} target="_blank" rel="noreferrer"><img src={source} alt={message.text ?? t("mockImageAlt")} loading="lazy" /></a><figcaption>{t("mockImageCaption")}</figcaption></figure>}{message.analysis?.summary && <div className="analysis"><span className="signal">● {t("relevant")}</span><span>{message.analysis.summary}</span></div>}</article>; })}</div></section>
      </div>
      <footer><span>{t("footer")}</span><span>{t("build")}</span></footer>
    </main>
  );
}
