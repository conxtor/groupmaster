"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiFetch, useAppLocale } from "../../auth";
import { adminTranslate } from "../admin-i18n";

type Language = "de" | "es" | "ca" | "en" | "fr";
type Topic = { id: string; language: Language; topicKey: string; title: string; description: string; enabled: boolean; sortOrder: number; createdAt: string; updatedAt: string };
type TopicPage = { items: Topic[]; page: number; pageSize: number; total: number; totalPages: number };
type RebuildJob = { id: string; status: string; totalCount: number; processedCount: number; failedCount: number; skippedCount: number; error?: string; createdAt: string; startedAt?: string; completedAt?: string; updatedAt: string };

const languages: Array<[Language, string]> = [["de", "Deutsch"], ["es", "Español"], ["ca", "Català"], ["en", "English"], ["fr", "Français"]];

function formatDate(value: string | undefined, locale: Language) {
  return value ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "–";
}

function jobLabel(status: string, locale: Language) {
  return ({ queued: adminTranslate(locale, "queuedStatus"), running: adminTranslate(locale, "runningStatus"), completed: adminTranslate(locale, "completedStatus"), failed: adminTranslate(locale, "failedStatus"), cancelled: adminTranslate(locale, "cancelledStatus") } as Record<string, string>)[status] ?? status;
}

export default function KnowledgeTopicsAdminPage() {
  const { locale } = useAppLocale();
  const at = (key: Parameters<typeof adminTranslate>[1], values?: Record<string, string | number>) => adminTranslate(locale, key, values);
  const [pageData, setPageData] = useState<TopicPage>({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 });
  const [jobs, setJobs] = useState<RebuildJob[]>([]);
  const [language, setLanguage] = useState<Language>("de");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [newTopic, setNewTopic] = useState({ language: "de" as Language, topicKey: "", title: "", description: "", sortOrder: "100" });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function loadTopics() {
    const query = new URLSearchParams({ language, page: String(page), pageSize: String(pageSize) });
    if (search) query.set("search", search);
    const response = await apiFetch(`/api/v1/admin/knowledge/topics?${query.toString()}`);
    if (!response.ok) throw new Error(at("noTopics"));
    setPageData(await response.json() as TopicPage);
  }

  async function loadJobs() {
    const response = await apiFetch("/api/v1/admin/knowledge/topics/rebuild");
    if (!response.ok) throw new Error(at("loadFailed"));
    setJobs(await response.json() as RebuildJob[]);
  }

  useEffect(() => { void loadTopics().catch((value) => setError(value instanceof Error ? value.message : at("loadFailed"))); }, [language, search, page, pageSize]);
  useEffect(() => {
    void loadJobs().catch((value) => setError(value instanceof Error ? value.message : at("loadFailed")));
    const timer = window.setInterval(() => void loadJobs().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, []);

  function applySearch(event: FormEvent) { event.preventDefault(); setPage(1); setSearch(searchInput.trim()); }
  function changeTopic(id: string, patch: Partial<Topic>) { setPageData((current) => ({ ...current, items: current.items.map((topic) => topic.id === id ? { ...topic, ...patch } : topic) })); }

  async function createTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setWorking(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/knowledge/topics", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...newTopic, sortOrder: Number(newTopic.sortOrder), enabled: true }) });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? at("create"));
      setNewTopic({ ...newTopic, topicKey: "", title: "", description: "" });
      await loadTopics();
    } catch (value) { setError(value instanceof Error ? value.message : at("create")); } finally { setWorking(false); }
  }

  async function saveTopic(topic: Topic) {
    setError(null);
    const response = await apiFetch(`/api/v1/admin/knowledge/topics/${encodeURIComponent(topic.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(topic) });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? at("save"));
    await loadTopics();
  }

  async function deleteTopic(topic: Topic) {
    if (!window.confirm(`${at("delete")} „${topic.title}“ (${topic.language})?`)) return;
    setError(null);
    const response = await apiFetch(`/api/v1/admin/knowledge/topics/${encodeURIComponent(topic.id)}`, { method: "DELETE" });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) { setError(body?.error ?? at("delete")); return; }
    await loadTopics();
  }

  async function rebuildKnowledge() {
    if (!window.confirm(at("rebuildHint"))) return;
    setWorking(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/knowledge/topics/rebuild", { method: "POST" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? at("rebuildKnowledge"));
      await loadJobs();
    } catch (value) { setError(value instanceof Error ? value.message : at("failedStatus")); } finally { setWorking(false); }
  }

  const latest = jobs[0];
  const progress = latest && latest.totalCount > 0 ? Math.min(100, Math.round(((latest.processedCount + latest.failedCount + latest.skippedCount) / latest.totalCount) * 100)) : 0;

  return <main className="shell adminPage">
    <header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{at("topicAdminTitle")}</h1><p className="muted">{at("topicAdminHint")}</p></div></header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("rebuildKnowledge")}</h2><p className="muted">{at("rebuildHint")}</p></div><button className="primaryButton" type="button" disabled={working || latest?.status === "queued" || latest?.status === "running"} onClick={() => void rebuildKnowledge()}>{working ? at("rebuildingKnowledge") : at("rebuildKnowledge")}</button></div>{latest && <div className="knowledgeRebuildStatus"><div><strong>{jobLabel(latest.status, locale)}</strong><span>{at("messagesProgress", { processed: latest.processedCount, total: latest.totalCount, failed: latest.failedCount, skipped: latest.skippedCount })}</span></div><progress max="100" value={progress} /><small>{latest.error ?? at("latestUpdated", { date: formatDate(latest.updatedAt, locale) })}</small></div>}{jobs.length > 1 && <details><summary>{at("priorRebuilds", { count: jobs.length - 1 })}</summary><div className="knowledgeRebuildHistory">{jobs.slice(1).map((job) => <div key={job.id}><span>{jobLabel(job.status, locale)}</span><span>{job.processedCount}/{job.totalCount}</span><time>{formatDate(job.createdAt, locale)}</time></div>)}</div></details>}</section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("newTopic")}</h2><p className="muted">{at("newTopicHint")}</p></div></div><form className="learningCreateForm knowledgeTopicCreateForm" onSubmit={createTopic}><label><span>{at("language")}</span><select value={newTopic.language} onChange={(event) => setNewTopic({ ...newTopic, language: event.target.value as Language })}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>{at("key")}</span><input required pattern="[a-z0-9][a-z0-9._-]{0,79}" value={newTopic.topicKey} onChange={(event) => setNewTopic({ ...newTopic, topicKey: event.target.value })} placeholder="z. B. health" /></label><label><span>{at("title")}</span><input required value={newTopic.title} onChange={(event) => setNewTopic({ ...newTopic, title: event.target.value })} /></label><label><span>{at("description")}</span><input value={newTopic.description} onChange={(event) => setNewTopic({ ...newTopic, description: event.target.value })} /></label><label><span>{at("order")}</span><input type="number" min="0" max="10000" value={newTopic.sortOrder} onChange={(event) => setNewTopic({ ...newTopic, sortOrder: event.target.value })} /></label><button className="primaryButton" disabled={working}>{at("create")}</button></form></section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>{pageData.total} {at("topicsCount")}</h2><p className="muted">{at("topicsHint")}</p></div></div><form className="learningSearchForm" onSubmit={applySearch}><label className="learningSearchField"><span>{at("search")}</span><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={at("searchTopicsPlaceholder")} /></label><label><span>{at("language")}</span><select value={language} onChange={(event) => { setLanguage(event.target.value as Language); setPage(1); }}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>{at("perPage")}</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><button className="primaryButton" type="submit">{at("search")}</button></form><div className="knowledgeTopicTable"><div className="knowledgeTopicHeader"><span>{at("key")}</span><span>{at("title")}</span><span>{at("description")}</span><span>{at("enabled")}</span><span>{at("actions")}</span></div>{pageData.items.map((topic) => <div className="knowledgeTopicRow" key={topic.id}><input aria-label={at("key")} value={topic.topicKey} onChange={(event) => changeTopic(topic.id, { topicKey: event.target.value })} /><input aria-label={at("title")} value={topic.title} onChange={(event) => changeTopic(topic.id, { title: event.target.value })} /><input aria-label={at("description")} value={topic.description} onChange={(event) => changeTopic(topic.id, { description: event.target.value })} /><label className="knowledgeTopicEnabled"><input type="checkbox" checked={topic.enabled} onChange={(event) => changeTopic(topic.id, { enabled: event.target.checked })} /><span>{topic.enabled ? at("yes") : at("no")}</span></label><span className="knowledgeTopicActions"><button className="textButton" type="button" onClick={() => void saveTopic(topic).catch((value) => setError(value instanceof Error ? value.message : at("save")))}>{at("save")}</button><button className="dangerButton" type="button" onClick={() => void deleteTopic(topic)}>{at("delete")}</button></span></div>)}{!pageData.items.length && <p className="adminEmpty">{at("noTopics")}</p>}</div><div className="learningPagination"><button className="textButton" type="button" disabled={pageData.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>{at("previous")}</button><span>{at("pageOf", { page: pageData.page, total: Math.max(1, pageData.totalPages) })}</span><button className="textButton" type="button" disabled={pageData.page >= pageData.totalPages} onClick={() => setPage((current) => current + 1)}>{at("next")}</button></div></section>
  </main>;
}
