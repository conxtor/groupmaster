"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { buildGroupHierarchy, type GroupHierarchyNode } from "../group-hierarchy";
import { AuthGate, apiFetch } from "../auth";
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

type Group = {
  id: string;
  subject: string;
  participantCount: number;
  isSelected: boolean;
  discoveredAt: string;
  platform?: "whatsapp" | "telegram";
  chatType?: "group" | "supergroup" | "channel" | "topic";
  language?: "de" | "es" | "ca" | "en" | "fr";
  parentGroupId?: string;
  topicId?: number;
};

type Translator = (key: TranslationKey, values?: TranslationValues) => string;
const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

function groupTypeLabel(group: Group, t: Translator) {
  if (group.chatType === "topic") return t("topic");
  if (group.chatType === "channel") return t("channel");
  if (group.chatType === "supergroup") return t("supergroup");
  return t("group");
}

function groupSubjectLabel(group: Group, t: Translator) {
  return group.platform === "whatsapp" && group.subject === group.id ? t("whatsappGroup") : group.subject;
}

function GroupRow({ group, t, child, onToggle }: { group: Group; t: Translator; child?: boolean; onToggle: (group: Group) => void }) {
  return <div className={`selectionRow ${child ? "selectionChild" : ""}`}>
    <div className="selectionIdentity">
      <span className="avatar">{group.subject.slice(0, 1).toUpperCase()}</span>
      <div><strong>{groupSubjectLabel(group, t)}</strong><small>{group.platform === "telegram" ? "Telegram" : "WhatsApp"} · {groupTypeLabel(group, t)} · {t("members", { count: group.participantCount })}</small></div>
    </div>
    <button type="button" aria-pressed={group.isSelected} aria-label={t("groupSelection", { group: group.subject })} className={`toggle ${group.isSelected ? "selected" : ""}`} onClick={() => onToggle(group)}>{group.isSelected ? "✓" : "＋"}</button>
  </div>;
}

function GroupBranch({ node, t, onToggle, depth = 0 }: { node: GroupHierarchyNode<Group>; t: Translator; onToggle: (group: Group) => void; depth?: number }) {
  return <div className={`selectionBranch ${depth > 0 ? "nestedBranch" : ""}`}>
    <GroupRow group={node.group} t={t} child={depth > 0} onToggle={onToggle} />
    {node.children.length > 0 && <div className="selectionChildren">{node.children.map((child) => <GroupBranch key={child.group.id} node={child} t={t} onToggle={onToggle} depth={depth + 1} />)}</div>}
  </div>;
}

export default function GroupSelectionPage() {
  const [groups, setGroups] = useState<Group[]>([]);
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
    async function loadGroups() {
      try {
        const response = await apiFetch("/api/v1/groups");
        if (!response.ok) throw new Error(t("groupSelectionError"));
        const nextGroups = await response.json() as Group[];
        if (active) { setGroups(nextGroups); setLive(true); setError(null); }
      } catch {
        if (active) { setLive(false); setError(t("demoNotice")); }
      }
    }
    void loadGroups();
    const timer = window.setInterval(() => void loadGroups(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [locale]);

  const hierarchy = useMemo(() => buildGroupHierarchy(groups), [groups]);

  function selectLocale(value: string) {
    if (!isSupportedLocale(value)) return;
    setLocale(value);
    document.cookie = `wagi_locale=${value}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }

  async function toggleGroup(group: Group) {
    const selected = !group.isSelected;
    setGroups((current) => current.map((item) => item.id === group.id ? { ...item, isSelected: selected } : item));
    try {
      const response = await apiFetch(`/api/v1/groups/${encodeURIComponent(group.id)}/select`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selected }),
      });
      if (!response.ok) throw new Error(t("groupSelectionError"));
    } catch {
      setGroups((current) => current.map((item) => item.id === group.id ? { ...item, isSelected: group.isSelected } : item));
      setError(t("groupSelectionError"));
    }
  }

  const selectedCount = groups.filter((group) => group.isSelected).length;

  return <AuthGate><main className="shell selectionPage">
    <header className="topbar">
      <div><p className="eyebrow">WAGI / GROUP INTELLIGENCE</p><h1>{t("groupSelectionPage")}</h1></div>
      <div className="topbarTools"><nav className="pageNav"><Link href="/">{t("dashboard")}</Link><Link href="/knowledge">{t("knowledge")}</Link><Link href="/connectors">{t("connectors")}</Link><Link href="/groups" className="pageNavActive">{t("manageGroups")}</Link></nav><label className="languagePicker"><span>{t("language")}</span><select aria-label={t("language")} value={locale} onChange={(event) => selectLocale(event.target.value)}>{supportedLocales.map((option) => <option key={option} value={option}>{localeNames[option]}</option>)}</select></label><div className="status"><span className={`dot ${live ? "on" : ""}`} />{live ? t("liveConnected") : t("localPreview")}</div></div>
    </header>
    <section className="selectionIntro"><div><p className="eyebrow">{t("groups")}</p><p className="selectionLead">{t("groupSelectionPageHint")}</p></div><div className="selectionSummary"><strong>{selectedCount}</strong><span>{t("selectedCount")}</span></div></section>
    {error && <div className="notice">{error}</div>}
    <section className="panel selectionPanel">
      <div className="panelHead"><div><h2>{t("manageGroups")}</h2><p className="muted">{t("groupSelectionHint")}</p></div><span className="count">{groups.length}</span></div>
      {groups.length === 0 ? <p className="emptyState">{t("noGroupsDiscovered")}</p> : <div className="selectionTree">{hierarchy.map((node) => <GroupBranch key={node.group.id} node={node} t={t} onToggle={toggleGroup} />)}</div>}
    </section>
    <footer><span>{t("footer")}</span><Link href="/">{t("openDashboard")}</Link></footer>
  </main></AuthGate>;
}
