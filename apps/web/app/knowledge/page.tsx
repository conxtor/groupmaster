"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  detectBrowserLocale,
  isSupportedLocale,
  localeNames,
  readLocaleCookie,
  supportedLocales,
  translate,
  type Locale,
  type TranslationKey,
  type TranslationValues,
} from "../i18n";
import { AuthGate, apiFetch } from "../auth";

type Group = { id: string; subject: string; isSelected: boolean; platform?: string; chatType?: string; language?: "de" | "es" | "ca" | "en" | "fr" };
type KnowledgeSourceMessage = {
  id: string;
  groupId: string;
  senderJid: string;
  senderName?: string;
  kind: string;
  text?: string;
  transcript?: string;
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
type KnowledgeTopic = { id: string; groupId: string; groupSubject: string; topicKey: string; title: string; summary: string; confidence: number; sourceMessageIds: string[]; items: KnowledgeItem[]; updatedAt: string };
type Translator = (key: TranslationKey, values?: TranslationValues) => string;

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";

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
  return "text";
}

function KnowledgeSourceMessage({ source, locale, t }: { source: KnowledgeSourceMessage; locale: Locale; t: Translator }) {
  const preview = resolveMediaUrl(source.thumbnailUrl || source.imageUrl);
  const original = resolveMediaUrl(source.mediaUrl || source.imageUrl || source.thumbnailUrl);
  const video = resolveMediaUrl(source.mediaUrl);
  const displayText = source.kind === "audio" && source.transcript ? source.transcript : source.text || source.transcript || t("noText");
  const [imageOpen, setImageOpen] = useState(false);

  useEffect(() => {
    if (!imageOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setImageOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", onKeyDown); };
  }, [imageOpen]);

  const imageCaption = source.mediaUrl ? t("knowledgeSourceImage") : t("mockImageCaption");
  const imageAlt = source.mediaUrl ? t("knowledgeSourceImage") : t("mockImageAlt");
  return <article className="knowledgeSourceMessage">
    <div className="knowledgeSourceMessageHead">
      <span className="knowledgeSourceMessageLabel">{t(knowledgeSourceKind(source.kind))}{source.senderName ? ` · ${source.senderName}` : ""}</span>
      <time dateTime={source.receivedAt}>{formatKnowledgeDate(source.receivedAt, locale)}</time>
    </div>
    <p className="knowledgeSourceMessageText">{displayText}</p>
    {source.kind === "image" && preview && <figure className="knowledgeSourceMessageFigure">
      <button className="imagePreviewButton" type="button" onClick={() => setImageOpen(true)} aria-label={t("openImage")}>
        <img crossOrigin="use-credentials" src={preview} alt={imageAlt} loading="lazy" />
      </button>
      <figcaption>{imageCaption}</figcaption>
    </figure>}
    {source.kind === "video" && video && <figure className="knowledgeSourceMessageFigure">
      <video crossOrigin="use-credentials" className="embeddedVideo" controls preload="metadata" poster={preview || undefined} src={video}>{t("videoUnsupported")}</video>
      <figcaption>{t("embeddedVideo")}</figcaption>
    </figure>}
    {imageOpen && original && <div className="imageModalBackdrop" role="dialog" aria-modal="true" aria-label={imageAlt} onClick={() => setImageOpen(false)}>
      <div className="imageModal" onClick={(event) => event.stopPropagation()}>
        <button className="imageModalClose" type="button" onClick={() => setImageOpen(false)} aria-label={t("closeImage")}>×</button>
        <img crossOrigin="use-credentials" className="imageModalImage" src={original} alt={imageAlt} />
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
    <p className="knowledgeNodeContent">{item.content}</p>
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

export default function KnowledgePage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [topics, setTopics] = useState<KnowledgeTopic[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("all");
  const [locale, setLocale] = useState<Locale>("de");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    async function loadKnowledge() {
      try {
        const [groupsResponse, knowledgeResponse] = await Promise.all([
          apiFetch("/api/v1/groups"),
          apiFetch("/api/v1/knowledge"),
        ]);
        if (!groupsResponse.ok || !knowledgeResponse.ok) throw new Error(t("connectorError"));
        const nextGroups = (await groupsResponse.json() as Group[]).filter((group) => group.isSelected);
        const nextTopics = await knowledgeResponse.json() as KnowledgeTopic[];
        if (active) {
          setGroups(nextGroups);
          setTopics(nextTopics);
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

  function selectLocale(value: string) {
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.cookie = `wagi_locale=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }

  return <AuthGate><main className="shell knowledgePage">
    <header className="topbar">
      <div><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><h1>{t("knowledgeBaseTitle")}</h1></div>
      <div className="topbarTools"><nav className="pageNav"><Link href="/">{t("dashboard")}</Link><Link href="/knowledge" className="pageNavActive">{t("knowledge")}</Link><Link href="/connectors">{t("connectors")}</Link><Link href="/groups">{t("manageGroups")}</Link></nav><label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{supportedLocales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label><div className="status"><span className={`dot ${live ? "on" : ""}`} />{live ? t("liveConnected") : t("localPreview")}</div></div>
    </header>
    <section className="selectionIntro"><div><p className="eyebrow">{t("knowledge")}</p><p className="selectionLead">{t("knowledgeBaseHint")}</p></div><label className="knowledgeSourcePicker"><span>{t("selectedGroupsOnly")}</span><select value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)}><option value="all">{t("allSelected")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select></label></section>
    {error && <div className="notice">{error}</div>}
    {!visibleTopics.length ? <section className="panel emptyState knowledgeEmpty">{t("knowledgeBaseEmpty")}</section> : <section className="knowledgeGrid">{visibleTopics.map((topic) => {
      const items = sortKnowledgeItems(topic.items ?? []);
      return <article className="panel knowledgeCard" key={topic.id}>
        <div className="knowledgeCardHead"><div><p className="eventGroup">{topic.groupSubject}</p><h2>{topic.title}</h2></div><span className="confidenceBadge">{Math.round(topic.confidence * 100)}%</span></div>
        <p className="knowledgeSummary">{topic.summary}</p>
        <div className="knowledgeMeta"><span>{t("knowledgeSources", { count: topic.sourceMessageIds.length })}</span><span>{t("knowledgeItems", { count: countKnowledgeItems(items) })}</span></div>
        <div className="knowledgeHierarchy">{items.map((item) => <KnowledgeBranch key={item.id} item={item} locale={locale} t={t} />)}</div>
      </article>;
    })}</section>}
    <footer><span>{t("footer")}</span><Link href="/">{t("openDashboard")}</Link></footer>
  </main></AuthGate>;
}
