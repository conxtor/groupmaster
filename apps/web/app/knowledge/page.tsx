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

type Group = { id: string; subject: string; isSelected: boolean; platform?: string; chatType?: string; language?: "de" | "es" | "ca" | "en" | "fr" };
type KnowledgeItem = { id: string; itemType: "fact" | "insight" | "entity"; content: string; confidence: number; sourceMessageIds: string[] };
type KnowledgeTopic = { id: string; groupId: string; groupSubject: string; topicKey: string; title: string; summary: string; confidence: number; sourceMessageIds: string[]; items: KnowledgeItem[]; updatedAt: string };
type Translator = (key: TranslationKey, values?: TranslationValues) => string;

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

function itemTypeLabel(itemType: KnowledgeItem["itemType"], t: Translator) {
  return t(itemType);
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
          fetch(`${apiBase}/api/v1/groups`),
          fetch(`${apiBase}/api/v1/knowledge`),
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

  const visibleTopics = useMemo(() => selectedGroup === "all" ? topics : topics.filter((topic) => topic.groupId === selectedGroup), [topics, selectedGroup]);

  function selectLocale(value: string) {
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.cookie = `wagi_locale=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }

  return <main className="shell knowledgePage">
    <header className="topbar">
      <div><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><h1>{t("knowledgeBaseTitle")}</h1></div>
      <div className="topbarTools"><nav className="pageNav"><Link href="/">{t("dashboard")}</Link><Link href="/knowledge" className="pageNavActive">{t("knowledge")}</Link><Link href="/groups">{t("manageGroups")}</Link></nav><label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{supportedLocales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label><div className="status"><span className={`dot ${live ? "on" : ""}`} />{live ? t("liveConnected") : t("localPreview")}</div></div>
    </header>
    <section className="selectionIntro"><div><p className="eyebrow">{t("knowledge")}</p><p className="selectionLead">{t("knowledgeBaseHint")}</p></div><label className="knowledgeSourcePicker"><span>{t("selectedGroupsOnly")}</span><select value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)}><option value="all">{t("allSelected")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select></label></section>
    {error && <div className="notice">{error}</div>}
    {!visibleTopics.length ? <section className="panel emptyState knowledgeEmpty">{t("knowledgeBaseEmpty")}</section> : <section className="knowledgeGrid">{visibleTopics.map((topic) => <article className="panel knowledgeCard" key={topic.id}><div className="knowledgeCardHead"><div><p className="eventGroup">{topic.groupSubject}</p><h2>{topic.title}</h2></div><span className="confidenceBadge">{Math.round(topic.confidence * 100)}%</span></div><p className="knowledgeSummary">{topic.summary}</p><div className="knowledgeMeta"><span>{t("knowledgeSources", { count: topic.sourceMessageIds.length })}</span><span>{t("knowledgeItems", { count: topic.items.length })}</span></div><div className="knowledgeItems">{topic.items.map((item) => <div className="knowledgeItem" key={item.id}><div className="knowledgeItemHead"><span className={`knowledgeType ${item.itemType}`}>{itemTypeLabel(item.itemType, t)}</span><span>{Math.round(item.confidence * 100)}%</span></div><p>{item.content}</p><small>{t("knowledgeSources", { count: item.sourceMessageIds.length })}</small></div>)}</div></article>)}</section>}
    <footer><span>{t("footer")}</span><Link href="/">{t("openDashboard")}</Link></footer>
  </main>;
}
