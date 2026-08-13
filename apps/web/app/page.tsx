"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import EventMap from "./event-map";
import { buildGroupHierarchy, type GroupHierarchyNode } from "./group-hierarchy";
import { AuthGate, apiFetch } from "./auth";
import { AudioPlayer, VideoPlayer } from "./media-player";
import { LinkifiedText } from "./linkified-text";
import {
  detectBrowserLocale,
  isSupportedLocale,
  localeCodes,
  localeNames,
  localizeRuntimeError,
  readLocaleCookie,
  supportedLocales,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationValues,
} from "./i18n";

type Place = { name: string; latitude?: number; longitude?: number };
type Event = { eventKey?: string; title: string; startsAt?: string; location?: string; sourceMessageIds?: string[] };
type Analysis = { relevant?: boolean; relevanceLevel?: "high" | "medium" | "low"; score?: number; summary?: string; places?: Place[]; events?: Event[] };
type Group = { id: string; subject: string; participantCount: number; isSelected: boolean; discoveredAt: string; platform?: "whatsapp" | "telegram"; chatType?: "group" | "supergroup" | "channel" | "topic"; language?: "de" | "es" | "ca" | "en" | "fr"; parentGroupId?: string; topicId?: number };
type Message = { id: string; groupId: string; groupSubject: string; waMessageId?: string; senderJid: string; senderName?: string; kind: string; text?: string; replyToWaMessageId?: string; platform?: string; imageUrl?: string; mediaUrl?: string; thumbnailUrl?: string; transcript?: string; audioStatus?: string; audioJobId?: string; audioAttempts?: number; audioError?: string; audioNextAttemptAt?: string; receivedAt: string; hasMedia: boolean; analysis?: Analysis };
type MessageNode = Message & { children: MessageNode[] };

function keepUsableSignedMediaUrl(previousValue: string | undefined, nextValue: string | undefined) {
  if (!previousValue || !nextValue) return nextValue;
  try {
    const previousUrl = new URL(previousValue, window.location.origin);
    const nextUrl = new URL(nextValue, window.location.origin);
    if (previousUrl.pathname !== nextUrl.pathname || previousUrl.searchParams.get("thumbnail") !== nextUrl.searchParams.get("thumbnail")) return nextValue;
    const expires = Number(previousUrl.searchParams.get("expires"));
    if (Number.isFinite(expires) && expires <= Math.floor(Date.now() / 1000) + 60) return nextValue;
    return previousValue;
  } catch {
    return nextValue;
  }
}

function preserveMessageMedia(previousMessages: Message[], nextMessages: Message[]) {
  const previousByID = new Map(previousMessages.map((message) => [message.id, message]));
  return nextMessages.map((message) => {
    const previous = previousByID.get(message.id);
    if (!previous) return message;
    return {
      ...message,
      mediaUrl: keepUsableSignedMediaUrl(previous.mediaUrl, message.mediaUrl),
      thumbnailUrl: keepUsableSignedMediaUrl(previous.thumbnailUrl, message.thumbnailUrl),
    };
  });
}
type EventVersion = { event: Event; place?: Place; updatedAt: string; sourceMessageIds: string[]; updateMessage?: Message };
type EventRecord = { key: string; groupId: string; groupSubject: string; groupPlatform?: string; versions: EventVersion[] };
type Translator = (key: TranslationKey, values?: TranslationValues) => string;
type ServiceStatus = { connectors: Array<{ connector: string; status: string; detail?: string; lastError?: string; updatedAt: string; queuePosition?: number | null; queueLength?: number | null; waitReason?: string | null }>; audioJobs: Record<string, number>; recentAudioErrors: Array<{ id: string; error?: string; attempts: number; groupSubject: string }>; aiProcessing: { total: number; completed: number; pending: number; model?: string; promptVersion?: string; updatedAt?: string } };

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";
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

function jobStatusLabel(status: string, t: Translator) {
  if (status === "queued") return t("jobQueued");
  if (status === "processing") return t("jobProcessing");
  if (status === "completed") return t("jobCompleted");
  if (status === "failed") return t("jobFailed");
  return status;
}

function ProcessingStatus({ locale, status }: { locale: Locale; status: ServiceStatus | null }) {
  const t = (key: TranslationKey, values?: TranslationValues) => translate(locale, key, values);
  if (!status) return null;
  const jobEntries = Object.entries(status.audioJobs);
  const ai = status.aiProcessing ?? { total: 0, completed: 0, pending: 0 };
  return <section className="statusPanel panel">
    <div className="panelHead"><div><p className="eyebrow">{t("processingStatus")}</p><h2>{t("connectionStatus")}</h2></div><span className="count">{status.connectors.length}</span></div>
    <div className="statusPanelBody">
      <div className="statusGroup"><strong>{t("connectionStatus")}</strong>{status.connectors.length ? status.connectors.map((connector) => <div className="statusLine" key={connector.connector}><span className={`statusBadge ${connector.status === "ready" || connector.status === "paused" ? "ok" : connector.status === "error" || connector.status === "reauth_required" ? "error" : "pending"}`}>{connector.status}</span><span>{connector.connector}</span>{connector.waitReason && <small>{t("connectorQueueWaiting")}{typeof connector.queuePosition === "number" && typeof connector.queueLength === "number" ? ` · ${t("connectorQueuePosition", { position: connector.queuePosition, count: connector.queueLength })}` : ""}</small>}{connector.lastError && <small>{t("lastError", { error: connector.lastError })}</small>}</div>) : <p className="muted">{t("noConnectorStatus")}</p>}</div>
      <div className="statusGroup"><strong>{t("audioStatus")}</strong>{jobEntries.length ? jobEntries.map(([jobStatus, count]) => <span className="jobCount" key={jobStatus}>{count} · {jobStatusLabel(jobStatus, t)}</span>) : <p className="muted">{t("noConnectorStatus")}</p>}</div>
      <div className="statusGroup"><strong>{t("aiProcessing")}</strong><span className="jobCount">{ai.pending} · {t("messagesPending")}</span><span className="jobCount">{ai.completed}/{ai.total} · {t("messagesAnalyzed")}</span>{ai.model && <small className="statusMeta">{t("aiModel", { model: ai.model })}</small>}{ai.promptVersion && <small className="statusMeta">{t("aiPrompt", { version: ai.promptVersion })}</small>}</div>
      {status.recentAudioErrors.length > 0 && <div className="statusErrors"><strong>{t("audioFailed")}</strong>{status.recentAudioErrors.slice(0, 3).map((job) => <p key={job.id}>{job.groupSubject} · {t("audioAttempts", { count: job.attempts })}{job.error ? ` · ${localizeRuntimeError(locale, job.error)}` : ""}</p>)}</div>}
    </div>
  </section>;
}

function time(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(localeCodes[locale], { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }).format(new Date(value));
}

function kindLabel(kind: string, locale: Locale) {
  const key = kind === "audio" ? "audio" : kind === "image" ? "image" : kind === "location" ? "location" : kind === "video" ? "video" : kind === "document" ? "document" : "text";
  return translate(locale, key);
}

function shortDocumentSummary(value: string | undefined, fallback: string) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 240 ? `${normalized.slice(0, 237).trimEnd()}…` : normalized;
}

function messageIdentity(message: Message) {
  if (!message.waMessageId) return message.id;
  return message.waMessageId.startsWith(`${message.groupId}:`) ? message.waMessageId : `${message.groupId}:${message.waMessageId}`;
}

function buildMessageHierarchy(messages: Message[]) {
  const nodes = messages.map((message) => ({ ...message, children: [] as MessageNode[] }));
  const byIdentity = new Map<string, MessageNode>();
  for (const node of nodes) {
    byIdentity.set(node.id, node);
    byIdentity.set(messageIdentity(node), node);
  }
  const roots: MessageNode[] = [];
  for (const node of nodes) {
    const parent = node.replyToWaMessageId ? byIdentity.get(node.replyToWaMessageId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: MessageNode[]) => {
    items.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
    for (const item of items) sort(item.children);
  };
  sort(roots);
  return roots;
}

function resolveMediaUrl(value?: string) {
  if (!value) return undefined;
  if (!value.startsWith("/api/")) return value;
  return `${apiBase.replace(/\/$/, "")}${value}`;
}

function imageSource(message: Message) {
  return resolveMediaUrl(message.thumbnailUrl ?? message.mediaUrl ?? message.imageUrl);
}

function videoSource(message: Message) {
  return resolveMediaUrl(message.mediaUrl);
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

function audioStatusLabel(status: string | undefined, t: Translator) {
  if (status === "queued") return t("audioQueued");
  if (status === "processing") return t("audioProcessing");
  if (status === "completed") return t("audioCompleted");
  if (status === "failed") return t("audioFailed");
  return status ?? t("audioStatus");
}

function EventBoard({ events, messages, locale }: { events: EventRecord[]; messages: Message[]; locale: Locale }) {
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
          <details className="eventSources"><summary>{t("viewSourceMessages")}</summary><div className="eventSourceFeed">{current.sourceMessageIds.map((sourceID) => messages.find((message) => message.id === sourceID)).filter((message): message is Message => Boolean(message)).map((message) => <MessageCard key={`${record.key}-${message.id}`} message={{ ...message, children: [] }} locale={locale} t={t} />)}{current.sourceMessageIds.every((sourceID) => !messages.some((message) => message.id === sourceID)) && <p className="muted">{t("noSourceMessages")}</p>}</div></details>
          {current.place ? <EventMap latitude={current.place.latitude!} longitude={current.place.longitude!} label={location} mapLabel={t("mapFor", { label: location })} /> : <div className="mapMissing">{t("noCoordinates")}</div>}
          {record.versions.length > 1 && <div className="eventHistory"><div className="eventHistoryHead"><strong>{t("changeHistory")}</strong><span>{t("versions", { count: record.versions.length })}</span></div><ol>{[...record.versions].reverse().map((version, index, newestFirst) => { const chronologicalIndex = record.versions.indexOf(version); return <li key={`${record.key}-${version.updatedAt}-${index}`} className={index === 0 ? "current" : ""}><div className="historyMeta"><time dateTime={version.updatedAt}>{eventDate(version.updatedAt, locale)}</time><strong>{index === 0 ? t("current") : t("version", { number: chronologicalIndex + 1 })}</strong></div>{index < newestFirst.length - 1 && <p className="historyChange">{versionChange(newestFirst[index + 1], version, locale)}</p>}<p>{eventLocation(version, t)}{version.event.startsAt ? ` · ${version.event.startsAt}` : ""}</p>{version.updateMessage?.text && <small>{t("source", { text: version.updateMessage.text })}</small>}</li>; })}</ol></div>}
        </article>;
      })}</div>
    </div>
  );
}

function MessageCard({ message, locale, t, depth = 0, onRetryAudio, onTranscriptSaved, onFeedback }: { message: MessageNode; locale: Locale; t: Translator; depth?: number; onRetryAudio?: (message: Message) => Promise<void>; onTranscriptSaved?: (messageId: string, transcript: string) => Promise<void>; onFeedback?: (messageId: string, targetType: "relevance" | "event" | "place", targetKey: string, decision: "accept" | "reject" | "correct", correction?: Record<string, unknown>) => Promise<void> }) {
  const source = imageSource(message);
  const original = resolveMediaUrl(message.mediaUrl) ?? source;
  const video = videoSource(message);
  const displayText = message.kind === "document"
    ? `${t("documentSummary")}: ${shortDocumentSummary(message.analysis?.summary ?? message.text, t("noText"))}`
    : message.kind === "audio" && message.transcript ? message.transcript : message.text ?? message.transcript ?? t("noText");
  const [imageOpen, setImageOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [transcriptDraft, setTranscriptDraft] = useState(message.transcript ?? "");
  const [savingTranscript, setSavingTranscript] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedbackSaved, setFeedbackSaved] = useState(false);

  useEffect(() => setTranscriptDraft(message.transcript ?? ""), [message.transcript]);

  async function saveFeedback(targetType: "relevance" | "event" | "place", targetKey: string, decision: "accept" | "reject" | "correct", correction: Record<string, unknown> = {}) {
    if (!onFeedback) return;
    await onFeedback(message.id, targetType, targetKey, decision, correction);
    setFeedbackSaved(true);
  }

  useEffect(() => {
    if (!imageOpen && !videoOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setImageOpen(false); setVideoOpen(false); } };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKeyDown); };
  }, [imageOpen, videoOpen]);

  return <>
    <article className={`message ${depth > 0 ? "messageReply" : ""}`}>
      <div className="messageMeta"><span className="avatar small">{(message.senderName ?? "?").slice(0, 1)}</span><span><strong>{message.senderName ?? message.senderJid}</strong><small>{message.platform === "telegram" ? "Telegram" : "WhatsApp"} · {messageGroupSubject(message, t)} · {time(message.receivedAt, locale)}</small></span><span className={`kind ${message.kind}`}>{kindLabel(message.kind, locale)}</span></div>
      {message.replyToWaMessageId && <p className="replyRef">{t("replyTo", { id: message.replyToWaMessageId })}</p>}
      <p className="messageText"><LinkifiedText text={displayText} /></p>
      {message.kind === "document" && original && <p className="documentLink"><a href={original} target="_blank" rel="noopener noreferrer">{t("openDocument")}</a></p>}
      {message.kind === "audio" && original && <AudioPlayer messageId={message.id} src={original} label={t("originalAudio")} unsupported={t("audioUnsupported")} />}
      {(message.kind === "audio" || message.audioStatus || message.transcript) && <div className={`audioJobPanel ${message.audioStatus === "failed" ? "failed" : ""}`}>
        <div className="audioJobHead"><strong>{t("audioStatus")}</strong><span>{audioStatusLabel(message.audioStatus, t)}</span></div>
        {typeof message.audioAttempts === "number" && <small>{t("audioAttempts", { count: message.audioAttempts })}</small>}
        {message.audioError && <p className="audioJobError">{t("audioError", { error: localizeRuntimeError(locale, message.audioError) })}</p>}
        {actionError && <p className="audioJobError">{actionError}</p>}
        {message.audioStatus === "failed" && message.audioJobId && onRetryAudio && <button className="textButton" type="button" onClick={async () => { setActionError(null); try { await onRetryAudio(message); } catch (error) { setActionError(error instanceof Error ? error.message : t("connectorError")); } }}>{t("retryAudio")}</button>}
        {(message.transcript || message.audioJobId) && <details className="transcriptReview" open={Boolean(message.transcript)}><summary>{t("reviewTranscript")}</summary><textarea value={transcriptDraft} onChange={(event) => setTranscriptDraft(event.target.value)} placeholder={t("transcriptPlaceholder")} /><button className="primaryButton" type="button" disabled={!onTranscriptSaved || !transcriptDraft.trim() || savingTranscript} onClick={async () => { if (!onTranscriptSaved) return; setActionError(null); setSavingTranscript(true); try { await onTranscriptSaved(message.id, transcriptDraft.trim()); } catch (error) { setActionError(error instanceof Error ? error.message : t("connectorError")); } finally { setSavingTranscript(false); } }}>{savingTranscript ? t("retryingAudio") : t("saveTranscript")}</button></details>}
      </div>}
      {message.kind === "image" && source && <figure className="imagePreview"><button className="imagePreviewButton" type="button" onClick={() => setImageOpen(true)} aria-label={t("openImage")}><img crossOrigin="use-credentials" src={source} alt={message.text ?? (message.mediaUrl ? t("knowledgeSourceImage") : t("mockImageAlt"))} loading="lazy" /></button><figcaption>{message.mediaUrl ? t("knowledgeSourceImage") : t("mockImageCaption")}</figcaption></figure>}
      {message.kind === "video" && video && <figure className="videoPreview"><button className="videoPreviewButton" type="button" onClick={() => setVideoOpen(true)} aria-label={t("openVideo")}><VideoPlayer videoId={message.id} src={video} poster={message.thumbnailUrl ? source || undefined : undefined} className="previewVideo" controls={false} muted unsupported={t("videoUnsupported")} /></button><figcaption>{t("embeddedVideo")}</figcaption></figure>}
      {message.analysis && <div className="analysis"><div className="analysisSummary"><span className={`signal relevance-${message.analysis.relevanceLevel ?? (message.analysis.relevant === false ? "low" : "medium")}`}>● {message.analysis.relevanceLevel === "high" ? t("relevanceHigh") : message.analysis.relevanceLevel === "medium" ? t("relevanceMedium") : t("relevanceLow")}</span>{message.analysis.summary && <span><LinkifiedText text={message.analysis.summary} /></span>}</div>{onFeedback && <div className="analysisFeedback"><span className="feedbackLabel">{t("setRelevance")}</span><button className="textButton" type="button" onClick={() => void saveFeedback("relevance", message.id, "correct", { relevanceLevel: "high" })}>{t("relevanceHigh")}</button><button className="textButton" type="button" onClick={() => void saveFeedback("relevance", message.id, "correct", { relevanceLevel: "medium" })}>{t("relevanceMedium")}</button><button className="textButton" type="button" onClick={() => void saveFeedback("relevance", message.id, "correct", { relevanceLevel: "low" })}>{t("relevanceLow")}</button>{message.analysis.events?.map((event) => <span className="feedbackGroup" key={event.eventKey ?? event.title}><small>{t("eventDetected")}</small><button className="textButton" type="button" onClick={() => void saveFeedback("event", event.eventKey ?? event.title, "accept", { confidence: 0.95 })}>{t("confirmEvent")}</button><button className="textButton" type="button" onClick={() => void saveFeedback("event", event.eventKey ?? event.title, "reject")}>{t("rejectEvent")}</button></span>)}{message.analysis.places?.map((place) => <span className="feedbackGroup" key={place.name}><small>{t("placeDetected")}</small><button className="textButton" type="button" onClick={() => void saveFeedback("place", place.name, "accept", { confidence: 0.95 })}>{t("confirmPlace")}</button><button className="textButton" type="button" onClick={() => void saveFeedback("place", place.name, "reject")}>{t("rejectPlace")}</button></span>)}{feedbackSaved && <small>{t("feedbackSaved")}</small>}</div>}</div>}
      {message.children.length > 0 && <div className="messageReplies">{message.children.map((child) => <MessageCard key={child.id} message={child} locale={locale} t={t} depth={depth + 1} onRetryAudio={onRetryAudio} onTranscriptSaved={onTranscriptSaved} onFeedback={onFeedback} />)}</div>}
    </article>
    {imageOpen && original && <div className="imageModalBackdrop" role="dialog" aria-modal="true" aria-label={message.text ?? t("mockImageAlt")} onClick={() => setImageOpen(false)}>
      <div className="imageModal" onClick={(event) => event.stopPropagation()}>
        <button className="imageModalClose" type="button" onClick={() => setImageOpen(false)} aria-label={t("closeImage")}>×</button>
        <img crossOrigin="use-credentials" className="imageModalImage" src={original} alt={message.text ?? t("mockImageAlt")} />
      </div>
    </div>}
    {videoOpen && video && <div className="imageModalBackdrop" role="dialog" aria-modal="true" aria-label={t("embeddedVideo")} onClick={() => setVideoOpen(false)}>
      <div className="imageModal" onClick={(event) => event.stopPropagation()}>
        <button className="imageModalClose" type="button" onClick={() => setVideoOpen(false)} aria-label={t("closeVideo")}>×</button>
        <VideoPlayer videoId={message.id} src={video} className="videoModalVideo" controls autoPlay unsupported={t("videoUnsupported")} />
      </div>
    </div>}
  </>;
}

export default function Dashboard() {
  const [groups, setGroups] = useState<Group[]>(sampleGroups);
  const [messages, setMessages] = useState<Message[]>(sampleMessages);
  const [eventSourceMessages, setEventSourceMessages] = useState<Message[]>(sampleMessages);
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [relevanceFilter, setRelevanceFilter] = useState("all");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [eventOnly, setEventOnly] = useState(false);
  const [placeOnly, setPlaceOnly] = useState(false);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [messageOffset, setMessageOffset] = useState(0);
  const [messagesHasMore, setMessagesHasMore] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>("de");
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);

  const t = (key: TranslationKey, values?: TranslationValues) => translate(locale, key, values);
  const messagePageSize = 50;
  const queryGroupId = selectedGroup !== "all" ? selectedGroup : groupFilter;

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
    setMessageOffset(0);
  }, [locale, showAllMessages, searchQuery, queryGroupId, kindFilter, relevanceFilter, fromFilter, toFilter, eventOnly, placeOnly]);

  useEffect(() => {
    let active = true;
    async function loadDashboard() {
      if (active) setMessagesLoading(true);
      try {
        const filters = new URLSearchParams();
        filters.set("limit", String(messagePageSize));
        filters.set("offset", String(messageOffset));
        if (!showAllMessages) filters.set("relevant", "true");
        if (relevanceFilter !== "all") filters.set("relevanceLevel", relevanceFilter);
        if (searchQuery.trim()) filters.set("q", searchQuery.trim());
        if (queryGroupId !== "all") filters.set("groupId", queryGroupId);
        if (kindFilter !== "all") filters.set("kind", kindFilter);
        if (fromFilter) filters.set("from", new Date(fromFilter).toISOString());
        if (toFilter) filters.set("to", new Date(toFilter).toISOString());
        if (eventOnly) filters.set("event", "true");
        if (placeOnly) filters.set("place", "true");
        const sourceFilters = new URLSearchParams({ limit: "200", offset: "0" });
        if (queryGroupId !== "all") sourceFilters.set("groupId", queryGroupId);
        const [groupsResponse, messagesResponse, sourceMessagesResponse, statusResponse] = await Promise.all([apiFetch("/api/v1/groups"), apiFetch(`/api/v1/messages?${filters.toString()}`), apiFetch(`/api/v1/messages?${sourceFilters.toString()}`), apiFetch("/api/v1/status")]);
        if (!groupsResponse.ok || !messagesResponse.ok) throw new Error("API nicht erreichbar");
        const nextGroups = await groupsResponse.json() as Group[];
        const nextMessages = await messagesResponse.json() as Message[];
        const nextSourceMessages = sourceMessagesResponse.ok ? await sourceMessagesResponse.json() as Message[] : nextMessages;
        const nextStatus = statusResponse.ok ? await statusResponse.json() as ServiceStatus : null;
        if (active) { setGroups(nextGroups); setMessages((current) => preserveMessageMedia(current, nextMessages)); setEventSourceMessages((current) => preserveMessageMedia(current, nextSourceMessages)); setMessagesHasMore(messagesResponse.headers.get("x-has-more") === "true"); setServiceStatus(nextStatus); setLive(true); setError(null); }
      } catch { if (active) setError(t("liveDataUnavailable")); }
      finally { if (active) setMessagesLoading(false); }
    }
    void loadDashboard();
    const timer = window.setInterval(() => void loadDashboard(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [locale, showAllMessages, searchQuery, queryGroupId, kindFilter, relevanceFilter, fromFilter, toFilter, eventOnly, placeOnly, messageOffset]);

  const visibleMessages = useMemo(() => selectedGroup === "all" ? messages : messages.filter((message) => message.groupId === selectedGroup), [messages, selectedGroup]);
  const messageThreads = useMemo(() => buildMessageHierarchy(visibleMessages), [visibleMessages]);
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

  function clearFilters() {
    setSelectedGroup("all");
    setGroupFilter("all");
    setSearchQuery("");
    setKindFilter("all");
    setRelevanceFilter("all");
    setFromFilter("");
    setToFilter("");
    setEventOnly(false);
    setPlaceOnly(false);
  }

  function selectGroup(groupId: string) {
    setSelectedGroup(groupId);
    setGroupFilter(groupId);
  }

  async function retryAudio(message: Message) {
    if (!message.audioJobId) return;
    const response = await apiFetch(`/api/v1/audio/jobs/${message.audioJobId}/retry`, { method: "POST" });
    if (!response.ok) throw new Error(t("connectorError"));
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, audioStatus: "queued", audioError: undefined } : item));
  }

  async function saveTranscript(messageID: string, transcript: string) {
    const message = messages.find((item) => item.id === messageID);
    if (!message?.audioJobId) return;
    const response = await apiFetch(`/api/v1/audio/jobs/${message.audioJobId}/transcript`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript }) });
    if (!response.ok) throw new Error(t("connectorError"));
    setMessages((current) => current.map((item) => item.id === messageID ? { ...item, transcript, audioStatus: "completed", audioError: undefined } : item));
  }

  async function submitFeedback(messageID: string, targetType: "relevance" | "event" | "place", targetKey: string, decision: "accept" | "reject" | "correct", correction: Record<string, unknown> = {}) {
    const message = messages.find((item) => item.id === messageID);
    if (!message) return;
    const response = await apiFetch("/api/v1/ai/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: messageID, groupId: message.groupId, targetType, targetKey, decision, correction }),
    });
    if (!response.ok) throw new Error(t("connectorError"));
    if (targetType === "relevance") {
      const level = correction.relevanceLevel as "high" | "medium" | "low" | undefined;
      setMessages((current) => current.map((item) => item.id === messageID ? {
        ...item,
        analysis: { ...item.analysis, relevanceLevel: level ?? (decision === "accept" ? "high" : "low"), relevant: (level ?? (decision === "accept" ? "high" : "low")) !== "low", score: level === "high" ? 0.86 : level === "medium" ? 0.60 : 0.20 },
      } : item));
    }
  }

  const scope = selectedGroup === "all" ? t("allSelectedGroups") : t("selectedGroup");

  return <AuthGate>{(
    <main className="shell">
      <header className="topbar">
        <div><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><h1>{t("title")}</h1></div>
        <div className="topbarTools"><nav className="pageNav"><Link href="/" className="pageNavActive">{t("dashboard")}</Link><Link href="/knowledge">{t("knowledge")}</Link><Link href="/connectors">{t("connectors")}</Link><Link href="/groups">{t("manageGroups")}</Link><Link href="/replays">{t("replayBackfill")}</Link></nav><label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{supportedLocales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label><div className="status"><span className={`dot ${live ? "on" : ""}`} />{live ? t("liveConnected") : t("localPreview")}</div></div>
      </header>
      <section className="hero"><div><p className="eyebrow">{t("signalCheck")}</p><p className="heroNumber">{visibleMessages.filter((item) => item.analysis?.relevant).length || 1}</p><p className="muted">{t("relevantSignals", { scope })}</p></div><div className="heroNote"><span>✦</span><p>{t("heroNote")}</p></div></section>
      {error && <div className="notice">{error}</div>}
      <ProcessingStatus locale={locale} status={serviceStatus} />
      <section className="panel filterPanel"><div className="panelHead"><div><p className="eyebrow">{t("searchMessages")}</p><h2>{t("messageStream")}</h2></div><button className="textButton" type="button" onClick={clearFilters}>{t("clearFilters")}</button></div><div className="filterGrid"><label><span>{t("searchMessages")}</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("searchMessages")} /></label><label><span>{t("filterGroup")}</span><select value={groupFilter} onChange={(event) => selectGroup(event.target.value)}><option value="all">{t("allSelected")}</option>{selectedGroups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select></label><label><span>{t("filterKind")}</span><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}><option value="all">{t("allKinds")}</option>{["text", "audio", "image", "video", "location", "document"].map((kind) => <option key={kind} value={kind}>{kindLabel(kind, locale)}</option>)}</select></label><label><span>{t("setRelevance")}</span><select value={relevanceFilter} onChange={(event) => setRelevanceFilter(event.target.value)}><option value="all">{t("allRelevance")}</option><option value="high">{t("relevanceHigh")}</option><option value="medium">{t("relevanceMedium")}</option><option value="low">{t("relevanceLow")}</option></select></label><label><span>{t("filterFrom")}</span><input type="datetime-local" value={fromFilter} onChange={(event) => setFromFilter(event.target.value)} /></label><label><span>{t("filterTo")}</span><input type="datetime-local" value={toFilter} onChange={(event) => setToFilter(event.target.value)} /></label><label className="filterCheck"><input type="checkbox" checked={eventOnly} onChange={(event) => setEventOnly(event.target.checked)} /><span>{t("filterEvents")}</span></label><label className="filterCheck"><input type="checkbox" checked={placeOnly} onChange={(event) => setPlaceOnly(event.target.checked)} /><span>{t("filterPlaces")}</span></label></div></section>
      <div className="grid">
        <aside className="panel groupsPanel"><div className="panelHead"><div><h2>{t("selectedGroupsOnly")}</h2><p className="muted groupSelectionHint">{t("groupSelectionHint")}</p></div><span className="count">{selectedGroups.length}</span></div><Link className="manageGroupsLink" href="/groups">{t("manageGroups")}</Link><button className={`groupRow ${selectedGroup === "all" ? "active" : ""}`} onClick={() => selectGroup("all")}><span className="avatar all">✦</span><span><strong>{t("allSelected")}</strong><small>{t("liveOverview")}</small></span></button>{dashboardHierarchy.map((node) => <DashboardGroupBranch key={node.group.id} node={node} selectedGroup={selectedGroup} onSelect={selectGroup} t={t} />)}</aside>
        <section className="panel feedPanel"><EventBoard events={eventRecords} messages={eventSourceMessages} locale={locale} /><div className="panelHead"><div><h2>{showAllMessages ? t("allMessages") : t("relevantMessages")}</h2><p className="muted">{showAllMessages ? t("allMessagesSubtitle") : t("relevantMessagesSubtitle")}</p></div><div className="feedControls"><button className={`textButton ${!showAllMessages ? "active" : ""}`} type="button" aria-pressed={!showAllMessages} onClick={() => setShowAllMessages(false)}>{t("relevantOnly")}</button><button className={`textButton ${showAllMessages ? "active" : ""}`} type="button" aria-pressed={showAllMessages} onClick={() => setShowAllMessages(true)}>{t("allMessages")}</button><span className="count">{visibleMessages.length}</span></div></div><div className="feed">{messageThreads.map((message) => <MessageCard key={message.id} message={message} locale={locale} t={t} onRetryAudio={retryAudio} onTranscriptSaved={saveTranscript} onFeedback={submitFeedback} />)}</div><div className="paginationControls" aria-label={t("messagePagination")}><button className="textButton" type="button" disabled={messageOffset === 0 || messagesLoading} onClick={() => setMessageOffset((current) => Math.max(0, current - messagePageSize))}>{t("previousPage")}</button><span>{t("messagePage", { page: Math.floor(messageOffset / messagePageSize) + 1 })}{messagesLoading ? ` · ${t("loadingMessages")}` : ""}</span><button className="textButton" type="button" disabled={!messagesHasMore || messagesLoading} onClick={() => setMessageOffset((current) => current + messagePageSize)}>{t("nextPage")}</button></div></section>
      </div>
      <footer><span>{t("footer")}</span><span>{t("build")}</span></footer>
    </main>
  )}</AuthGate>;
}
