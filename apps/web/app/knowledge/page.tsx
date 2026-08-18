"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { buildGroupHierarchy, type GroupHierarchyNode } from "../group-hierarchy";
import {
  type Locale,
  type TranslationKey,
  type TranslationValues,
} from "../i18n";
import { AuthGate, apiFetch, useAppLocale } from "../auth";
import { AudioPlayer, VideoPlayer } from "../media-player";
import { LinkifiedText } from "../linkified-text";

type Group = { id: string; subject: string; participantCount?: number; isSelected: boolean; platform?: "whatsapp" | "telegram"; chatType?: "group" | "supergroup" | "channel" | "topic"; parentGroupId?: string; language?: "de" | "es" | "ca" | "en" | "fr" };
type KnowledgeSourceMessage = {
  id: string;
  groupId: string;
  senderJid: string;
  senderName?: string;
  kind: string;
  text?: string;
  transcript?: string;
  documentSummary?: string;
  mediaMime?: string;
  mediaStatus?: string;
  receivedAt: string;
  hasMedia: boolean;
  imageUrl?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
};
type KnowledgeItem = {
  id: string;
  itemType: "fact" | "insight" | "entity";
  itemRole?: "summary" | "detail";
  content: string;
  confidence: number;
  sourceMessageIds: string[];
  updatedAt?: string;
  sourceMessages?: KnowledgeSourceMessage[];
  children?: KnowledgeItem[];
};
type KnowledgeTopic = { id: string; groupId: string; groupSubject: string; topicKey: string; subtopicKey?: string; parentTopicId?: string; title: string; summary: string; confidence: number; sourceMessageIds: string[]; items: KnowledgeItem[]; subtopics?: KnowledgeTopic[]; updatedAt: string };
type Translator = (key: TranslationKey, values?: TranslationValues) => string;

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";

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

function collectKnowledgeSources(items: KnowledgeItem[], target: Map<string, KnowledgeSourceMessage>) {
  for (const item of items) {
    for (const source of item.sourceMessages ?? []) target.set(source.id, source);
    collectKnowledgeSources(item.children ?? [], target);
  }
}

function stabilizeKnowledgeItem(item: KnowledgeItem, previousSources: Map<string, KnowledgeSourceMessage>): KnowledgeItem {
  return {
    ...item,
    sourceMessages: item.sourceMessages?.map((source) => {
      const previous = previousSources.get(source.id);
      if (!previous) return source;
      return {
        ...source,
        mediaUrl: keepUsableSignedMediaUrl(previous.mediaUrl, source.mediaUrl),
        thumbnailUrl: keepUsableSignedMediaUrl(previous.thumbnailUrl, source.thumbnailUrl),
      };
    }),
    children: item.children?.map((child) => stabilizeKnowledgeItem(child, previousSources)),
  };
}

function preserveKnowledgeMedia(previousTopics: KnowledgeTopic[], nextTopics: KnowledgeTopic[]) {
  const previousSources = new Map<string, KnowledgeSourceMessage>();
  for (const topic of previousTopics) {
    collectKnowledgeSources(topic.items ?? [], previousSources);
    for (const subtopic of topic.subtopics ?? []) collectKnowledgeSources(subtopic.items ?? [], previousSources);
  }
  return nextTopics.map((topic) => ({
    ...topic,
    items: (topic.items ?? []).map((item) => stabilizeKnowledgeItem(item, previousSources)),
    subtopics: topic.subtopics?.map((subtopic) => ({
      ...subtopic,
      items: (subtopic.items ?? []).map((item) => stabilizeKnowledgeItem(item, previousSources)),
    })),
  }));
}

function itemTypeLabel(itemType: KnowledgeItem["itemType"], t: Translator) {
  return t(itemType);
}

function sortKnowledgeItems(items: KnowledgeItem[] = []) {
  return [...items].sort((left, right) => {
    const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    return rightTime - leftTime;
  });
}

function countKnowledgeItems(items: KnowledgeItem[] = []): number {
  return items.reduce((count, item) => count + 1 + countKnowledgeItems(item.children ?? []), 0);
}

function formatKnowledgeDate(value: string | undefined, locale: Locale) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function resolveMediaUrl(value: string | undefined) {
  if (!value) return "";
  return value.startsWith("/api/") ? `${apiBase}${value}` : value;
}

function knowledgeSourceKind(kind: string): TranslationKey {
  if (kind === "image") return "image";
  if (kind === "audio") return "audio";
  if (kind === "location") return "location";
  if (kind === "video") return "video";
  if (kind === "document") return "document";
  return "text";
}

function shortDocumentSummary(value: string | undefined, fallback: string) {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 240 ? `${normalized.slice(0, 237).trimEnd()}…` : normalized;
}

function KnowledgeSourceMessage({ source, locale, t }: { source: KnowledgeSourceMessage; locale: Locale; t: Translator }) {
  const preview = resolveMediaUrl(source.thumbnailUrl || source.imageUrl);
  const original = resolveMediaUrl(source.mediaUrl || source.imageUrl || source.thumbnailUrl);
  const video = resolveMediaUrl(source.mediaUrl);
  const displayText = source.kind === "document"
    ? `${t("documentSummary")}: ${shortDocumentSummary(source.documentSummary || source.text, t("noText"))}`
    : source.kind === "audio" && source.transcript ? source.transcript : source.text || source.transcript || t("noText");
  const [imageOpen, setImageOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);

  useEffect(() => {
    if (!imageOpen && !videoOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setImageOpen(false); setVideoOpen(false); } };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKeyDown); };
  }, [imageOpen, videoOpen]);

  const imageCaption = source.mediaUrl ? t("knowledgeSourceImage") : t("mockImageCaption");
  const imageAlt = source.mediaUrl ? t("knowledgeSourceImage") : t("mockImageAlt");
  return <article className="knowledgeSourceMessage">
    <div className="knowledgeSourceMessageHead">
      <span className="knowledgeSourceMessageLabel">{t(knowledgeSourceKind(source.kind))}{source.senderName ? ` · ${source.senderName}` : ""}</span>
      <time dateTime={source.receivedAt}>{formatKnowledgeDate(source.receivedAt, locale)}</time>
    </div>
    <p className="knowledgeSourceMessageText"><LinkifiedText text={displayText} /></p>
    {source.kind === "document" && original && <p className="documentLink"><a href={original} target="_blank" rel="noopener noreferrer">{t("openDocument")}</a></p>}
    {source.kind === "audio" && original && <AudioPlayer messageId={source.id} src={original} label={t("originalAudio")} unsupported={t("audioUnsupported")} />}
    {source.kind === "image" && preview && <figure className="knowledgeSourceMessageFigure">
      <button className="imagePreviewButton" type="button" onClick={() => setImageOpen(true)} aria-label={t("openImage")}>
        <img crossOrigin="use-credentials" src={preview} alt={imageAlt} loading="lazy" />
      </button>
      <figcaption>{imageCaption}</figcaption>
    </figure>}
    {source.kind === "video" && video && <figure className="knowledgeSourceMessageFigure">
      <button className="videoPreviewButton" type="button" onClick={() => setVideoOpen(true)} aria-label={t("openVideo")}><VideoPlayer videoId={source.id} src={video} poster={source.thumbnailUrl ? preview || undefined : undefined} className="embeddedVideo" controls={false} muted unsupported={t("videoUnsupported")} /></button>
      <figcaption>{t("embeddedVideo")}</figcaption>
    </figure>}
    {imageOpen && original && <div className="imageModalBackdrop" role="dialog" aria-modal="true" aria-label={imageAlt} onClick={() => setImageOpen(false)}>
      <div className="imageModal" onClick={(event) => event.stopPropagation()}>
        <button className="imageModalClose" type="button" onClick={() => setImageOpen(false)} aria-label={t("closeImage")}>×</button>
        <img crossOrigin="use-credentials" className="imageModalImage" src={original} alt={imageAlt} />
      </div>
    </div>}
    {videoOpen && video && <div className="imageModalBackdrop" role="dialog" aria-modal="true" aria-label={t("embeddedVideo")} onClick={() => setVideoOpen(false)}>
      <div className="imageModal" onClick={(event) => event.stopPropagation()}>
        <button className="imageModalClose" type="button" onClick={() => setVideoOpen(false)} aria-label={t("closeVideo")}>×</button>
        <VideoPlayer videoId={source.id} src={video} className="videoModalVideo" controls autoPlay unsupported={t("videoUnsupported")} />
      </div>
    </div>}
  </article>;
}

function KnowledgeBranch({ item, locale, t, depth = 0 }: { item: KnowledgeItem; locale: Locale; t: Translator; depth?: number }) {
  const children = sortKnowledgeItems(item.children ?? []);
  const [expanded, setExpanded] = useState(true);
  return <div className={`knowledgeNode knowledgeNodeDepth${Math.min(depth, 3)}`}>
    <div className="knowledgeNodeHead">
      <div className="knowledgeNodeIdentity">
        {children.length ? <button className="knowledgeNodeToggle" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-label={expanded ? t("knowledgeCollapse") : t("knowledgeExpand")}>{expanded ? "−" : "+"}</button> : <span className="knowledgeNodeBullet">•</span>}
        <span className={`knowledgeType ${item.itemType}`}>{itemTypeLabel(item.itemType, t)}</span>
        {item.updatedAt && <time className="knowledgeNodeTime" dateTime={item.updatedAt}>{formatKnowledgeDate(item.updatedAt, locale)}</time>}
      </div>
      <span className="knowledgeNodeConfidence">{Math.round(item.confidence * 100)}%</span>
    </div>
    <p className="knowledgeNodeContent"><LinkifiedText text={item.content} /></p>
    <div className="knowledgeNodeMeta">
      <span>{t("knowledgeSources", { count: item.sourceMessageIds.length })}</span>
      {children.length > 0 && <span>{t("knowledgeChildren", { count: children.length })}</span>}
    </div>
    {item.sourceMessages && item.sourceMessages.length > 0 && <div className="knowledgeSourceMessages">
      {item.sourceMessages.map((source) => <KnowledgeSourceMessage key={source.id} source={source} locale={locale} t={t} />)}
    </div>}
    {expanded && children.length > 0 && <div className="knowledgeNodeChildren">{children.map((child) => <KnowledgeBranch key={child.id} item={child} locale={locale} t={t} depth={depth + 1} />)}</div>}
  </div>;
}

function KnowledgeTopicBranch({ topic, locale, t, nested = false }: { topic: KnowledgeTopic; locale: Locale; t: Translator; nested?: boolean }) {
  const items = sortKnowledgeItems(topic.items ?? []);
  return <section className={nested ? "knowledgeSubtopic" : "knowledgeRootTopic"}>
    <div className="knowledgeCardHead"><div><p className="eventGroup">{nested ? topic.title : topic.groupSubject}</p>{nested ? <h3><LinkifiedText text={topic.title} /></h3> : <h2><LinkifiedText text={topic.title} /></h2>}</div><span className="confidenceBadge">{Math.round(topic.confidence * 100)}%</span></div>
    <p className="knowledgeSummary"><LinkifiedText text={topic.summary} /></p>
    <div className="knowledgeMeta"><span>{t("knowledgeSources", { count: topic.sourceMessageIds.length })}</span><span>{t("knowledgeItems", { count: countKnowledgeItems(items) })}</span></div>
    <div className="knowledgeHierarchy">{items.map((item) => <KnowledgeBranch key={item.id} item={item} locale={locale} t={t} />)}</div>
  </section>;
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

function KnowledgeGroupBranch({ node, selectedGroup, onSelect, t, depth = 0 }: { node: GroupHierarchyNode<Group>; selectedGroup: string; onSelect: (groupId: string) => void; t: Translator; depth?: number }) {
  const selectable = node.group.isSelected;
  const subject = groupSubjectLabel(node.group, t);
  return <div className={`dashboardGroupBranch ${depth > 0 ? "nestedGroupBranch" : ""}`}>
    <button className={`groupRow ${selectedGroup === node.group.id ? "active" : ""} ${depth > 0 ? "topicRow" : ""} ${!selectable ? "groupContext" : ""}`} disabled={!selectable} onClick={() => onSelect(node.group.id)}>
      <span className={`avatar ${depth === 0 ? "supergroupAvatar" : ""}`}>{subject.slice(0, 1).toUpperCase()}</span>
      <span><strong>{subject}</strong><small>{node.group.platform === "telegram" ? "Telegram" : "WhatsApp"} · {groupTypeLabel(node.group, t)} · {t("members", { count: node.group.participantCount ?? 0 })}</small></span>
    </button>
    {node.children.length > 0 && <div className="groupChildren">{node.children.map((child) => <KnowledgeGroupBranch key={child.group.id} node={child} selectedGroup={selectedGroup} onSelect={onSelect} t={t} depth={depth + 1} />)}</div>}
  </div>;
}

export default function KnowledgePage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [topics, setTopics] = useState<KnowledgeTopic[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("all");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { locale, t } = useAppLocale();

  useEffect(() => {
    let active = true;
    async function loadKnowledge() {
      try {
        const [groupsResponse, knowledgeResponse] = await Promise.all([
          apiFetch("/api/v1/groups"),
          apiFetch("/api/v1/knowledge"),
        ]);
        if (!groupsResponse.ok || !knowledgeResponse.ok) throw new Error(t("connectorError"));
        const nextGroups = await groupsResponse.json() as Group[];
        const nextTopics = await knowledgeResponse.json() as KnowledgeTopic[];
        if (active) {
          setGroups(nextGroups);
          setTopics((current) => preserveKnowledgeMedia(current, nextTopics));
          setSelectedGroup((current) => current !== "all" && nextGroups.some((group) => group.id === current) ? current : "all");
          setLive(true);
          setError(null);
        }
      } catch {
        if (active) { setLive(false); setError(t("demoNotice")); }
      }
    }
    void loadKnowledge();
    const timer = window.setInterval(() => void loadKnowledge(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [locale]);

  const visibleTopics = useMemo(() => {
    const filtered = selectedGroup === "all" ? topics : topics.filter((topic) => topic.groupId === selectedGroup);
    return [...filtered].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [topics, selectedGroup]);

  const selectedGroups = useMemo(() => groups.filter((group) => group.isSelected), [groups]);
  const visibleGroupIds = useMemo(() => {
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
  const groupHierarchy = useMemo(() => buildGroupHierarchy(groups, visibleGroupIds), [groups, visibleGroupIds]);

  return <AuthGate><main className="shell knowledgePage">
    <header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{t("knowledgeBaseTitle")}</h1></div></header>
    <section className="selectionIntro"><div><p className="eyebrow">{t("knowledge")}</p><p className="selectionLead">{t("knowledgeBaseHint")}</p></div><div className="selectionSummary"><strong>{selectedGroup === "all" ? visibleTopics.length : visibleTopics.length}</strong><span>{t("knowledge")}</span></div></section>
    {error && <div className="notice">{error}</div>}
    <div className="dashboardGrid knowledgeLayout">
      <aside className="panel groupsPanel knowledgeGroupsPanel"><div className="panelHead"><div><h2>{t("selectedGroupsOnly")}</h2><p className="muted groupSelectionHint">{t("groupSelectionHint")}</p></div><span className="count">{selectedGroups.length}</span></div><Link className="manageGroupsLink" href="/groups">{t("manageGroups")}</Link><button className={`groupRow ${selectedGroup === "all" ? "active" : ""}`} type="button" onClick={() => setSelectedGroup("all")}><span className="avatar all">✦</span><span><strong>{t("allSelected")}</strong><small>{t("knowledge")}</small></span></button>{groupHierarchy.map((node) => <KnowledgeGroupBranch key={node.group.id} node={node} selectedGroup={selectedGroup} onSelect={setSelectedGroup} t={t} />)}</aside>
      <section className="knowledgeContent">{!visibleTopics.length ? <section className="panel emptyState knowledgeEmpty">{t("knowledgeBaseEmpty")}</section> : <section className="knowledgeGrid">{visibleTopics.map((topic) => {
        return <article className="panel knowledgeCard" key={topic.id}>
          <KnowledgeTopicBranch topic={topic} locale={locale} t={t} />
          {!!topic.subtopics?.length && <div className="knowledgeSubtopics">{topic.subtopics.map((subtopic) => <KnowledgeTopicBranch key={subtopic.id} topic={subtopic} locale={locale} t={t} nested />)}</div>}
        </article>;
      })}</section>}</section>
    </div>
    <footer><span>{t("footer")}</span><Link href="/">{t("openDashboard")}</Link></footer>
  </main></AuthGate>;
}
