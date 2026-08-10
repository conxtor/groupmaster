"use client";

import { useEffect, useMemo, useState } from "react";
import EventMap from "./event-map";
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
type Group = { id: string; subject: string; participantCount: number; isSelected: boolean; discoveredAt: string };
type Message = { id: string; groupId: string; groupSubject: string; senderJid: string; senderName?: string; kind: string; text?: string; replyToWaMessageId?: string; platform?: string; imageUrl?: string; receivedAt: string; hasMedia: boolean; analysis?: Analysis };
type EventVersion = { event: Event; place?: Place; updatedAt: string; sourceMessageIds: string[]; updateMessage?: Message };
type EventRecord = { key: string; groupSubject: string; versions: EventVersion[] };
type Translator = (key: TranslationKey, values?: TranslationValues) => string;

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
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

function time(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeCodes[locale], { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }).format(new Date(value));
}

function kindLabel(kind: string, locale: Locale) {
  const key = kind === "audio" ? "audio" : kind === "image" ? "image" : kind === "location" ? "location" : kind === "video" ? "video" : "text";
  return translate(locale, key);
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
      const record = records.get(key) ?? { key, groupSubject: message.groupSubject, versions: [] };
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
          <div className="eventCardHead"><div><p className="eventGroup">{record.groupSubject}</p><h3>{eventTitle(current.event)}</h3><p className="eventMeta">{location}{current.event.startsAt ? ` · ${current.event.startsAt}` : ""}</p></div><span className="eventState">{record.versions.length > 1 ? t("updated") : t("new")}</span></div>
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
    Promise.all([fetch(`${apiBase}/api/v1/groups`), fetch(`${apiBase}/api/v1/messages?limit=100`)]).then(async ([groupsResponse, messagesResponse]) => {
      if (!groupsResponse.ok || !messagesResponse.ok) throw new Error("API nicht erreichbar");
      const nextGroups = await groupsResponse.json() as Group[];
      const nextMessages = await messagesResponse.json() as Message[];
      if (active) { setGroups(nextGroups); setMessages(nextMessages); setLive(true); setError(null); }
    }).catch(() => { if (active) setError(t("demoNotice")); });
    return () => { active = false; };
  }, []);

  const visibleMessages = useMemo(() => selectedGroup === "all" ? messages : messages.filter((message) => message.groupId === selectedGroup), [messages, selectedGroup]);
  const eventRecords = useMemo(() => eventVersions(visibleMessages), [visibleMessages]);

  function selectLocale(value: string) {
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.cookie = `wagi_locale=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }

  async function toggleGroup(group: Group) {
    const selected = !group.isSelected;
    setGroups((current) => current.map((item) => item.id === group.id ? { ...item, isSelected: selected } : item));
    try { await fetch(`${apiBase}/api/v1/groups/${encodeURIComponent(group.id)}/select`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selected }) }); }
    catch { setError(t("groupSelectionError")); }
  }

  const scope = selectedGroup === "all" ? t("allSelectedGroups") : t("selectedGroup");

  return (
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><h1>{t("title")}</h1></div>
        <div className="topbarTools"><label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{supportedLocales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label><div className="status"><span className={`dot ${live ? "on" : ""}`} />{live ? t("liveConnected") : t("localPreview")}</div></div>
      </header>
      <section className="hero"><div><p className="eyebrow">{t("signalCheck")}</p><p className="heroNumber">{visibleMessages.filter((item) => item.analysis?.relevant).length || 1}</p><p className="muted">{t("relevantSignals", { scope })}</p></div><div className="heroNote"><span>✦</span><p>{t("heroNote")}</p></div></section>
      {error && <div className="notice">{error}</div>}
      <div className="grid">
        <aside className="panel groupsPanel"><div className="panelHead"><h2>{t("groups")}</h2><span className="count">{groups.length}</span></div><button className={`groupRow ${selectedGroup === "all" ? "active" : ""}`} onClick={() => setSelectedGroup("all")}><span className="avatar all">✦</span><span><strong>{t("allSelected")}</strong><small>{t("liveOverview")}</small></span></button>{groups.map((group) => <div className="groupRowWrap" key={group.id}><button className={`groupRow ${selectedGroup === group.id ? "active" : ""}`} onClick={() => setSelectedGroup(group.id)}><span className="avatar">{group.subject.slice(0, 1).toUpperCase()}</span><span><strong>{group.subject}</strong><small>{t("members", { count: group.participantCount })}</small></span></button><button aria-label={t("groupSelection", { group: group.subject })} className={`toggle ${group.isSelected ? "selected" : ""}`} onClick={() => void toggleGroup(group)}>{group.isSelected ? "✓" : "＋"}</button></div>)}</aside>
        <section className="panel feedPanel"><EventBoard events={eventRecords} locale={locale} /><div className="panelHead"><div><h2>{t("messageStream")}</h2><p className="muted">{t("messageSubtitle")}</p></div><span className="count">{visibleMessages.length}</span></div><div className="feed">{visibleMessages.map((message) => <article className="message" key={message.id}><div className="messageMeta"><span className="avatar small">{(message.senderName ?? "?").slice(0, 1)}</span><span><strong>{message.senderName ?? message.senderJid}</strong><small>{message.platform === "telegram" ? "Telegram" : "WhatsApp"} · {message.groupSubject} · {time(message.receivedAt, locale)}</small></span><span className={`kind ${message.kind}`}>{kindLabel(message.kind, locale)}</span></div>{message.replyToWaMessageId && <p className="replyRef">{t("replyTo", { id: message.replyToWaMessageId })}</p>}<p className="messageText">{message.text ?? t("noText")}</p>{message.kind === "image" && message.imageUrl && <figure className="imagePreview"><img src={message.imageUrl} alt={message.text ?? t("mockImageAlt")} loading="lazy" /><figcaption>{t("mockImageCaption")}</figcaption></figure>}{message.analysis?.summary && <div className="analysis"><span className="signal">● {message.analysis.relevant ? t("relevant") : t("lowRelevance")}</span><span>{message.analysis.summary}</span></div>}</article>)}</div></section>
      </div>
      <footer><span>{t("footer")}</span><span>{t("build")}</span></footer>
    </main>
  );
}
