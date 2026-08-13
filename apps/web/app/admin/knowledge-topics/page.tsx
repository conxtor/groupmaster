"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../auth";

type Language = "de" | "es" | "ca" | "en" | "fr";
type Topic = { id: string; language: Language; topicKey: string; title: string; description: string; enabled: boolean; sortOrder: number; createdAt: string; updatedAt: string };
type TopicPage = { items: Topic[]; page: number; pageSize: number; total: number; totalPages: number };
type RebuildJob = { id: string; status: string; totalCount: number; processedCount: number; failedCount: number; skippedCount: number; error?: string; createdAt: string; startedAt?: string; completedAt?: string; updatedAt: string };

const languages: Array<[Language, string]> = [["de", "Deutsch"], ["es", "Español"], ["ca", "Català"], ["en", "English"], ["fr", "Français"]];

function formatDate(value?: string) {
  return value ? new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "–";
}

function jobLabel(status: string) {
  return ({ queued: "Wartet", running: "Läuft", completed: "Abgeschlossen", failed: "Fehler", cancelled: "Abgebrochen" } as Record<string, string>)[status] ?? status;
}

export default function KnowledgeTopicsAdminPage() {
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
    if (!response.ok) throw new Error("KB-Themen konnten nicht geladen werden");
    setPageData(await response.json() as TopicPage);
  }

  async function loadJobs() {
    const response = await apiFetch("/api/v1/admin/knowledge/topics/rebuild");
    if (!response.ok) throw new Error("KB-Neuaufbau-Status konnte nicht geladen werden");
    setJobs(await response.json() as RebuildJob[]);
  }

  useEffect(() => { void loadTopics().catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen")); }, [language, search, page, pageSize]);
  useEffect(() => {
    void loadJobs().catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen"));
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
      if (!response.ok) throw new Error(body?.error ?? "KB-Thema konnte nicht angelegt werden");
      setNewTopic({ ...newTopic, topicKey: "", title: "", description: "" });
      await loadTopics();
    } catch (value) { setError(value instanceof Error ? value.message : "Anlegen fehlgeschlagen"); } finally { setWorking(false); }
  }

  async function saveTopic(topic: Topic) {
    setError(null);
    const response = await apiFetch(`/api/v1/admin/knowledge/topics/${encodeURIComponent(topic.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(topic) });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(body?.error ?? "KB-Thema konnte nicht gespeichert werden");
    await loadTopics();
  }

  async function deleteTopic(topic: Topic) {
    if (!window.confirm(`Thema „${topic.title}“ in ${topic.language} wirklich löschen?`)) return;
    setError(null);
    const response = await apiFetch(`/api/v1/admin/knowledge/topics/${encodeURIComponent(topic.id)}`, { method: "DELETE" });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) { setError(body?.error ?? "KB-Thema konnte nicht gelöscht werden"); return; }
    await loadTopics();
  }

  async function rebuildKnowledge() {
    if (!window.confirm("Die Knowledge Base wird aus den gespeicherten Texten, Transkripten und Metadaten neu aufgebaut. Medien werden nicht erneut verarbeitet. Fortfahren?")) return;
    setWorking(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/knowledge/topics/rebuild", { method: "POST" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "KB-Neuaufbau konnte nicht gestartet werden");
      await loadJobs();
    } catch (value) { setError(value instanceof Error ? value.message : "KB-Neuaufbau fehlgeschlagen"); } finally { setWorking(false); }
  }

  const latest = jobs[0];
  const progress = latest && latest.totalCount > 0 ? Math.min(100, Math.round(((latest.processedCount + latest.failedCount + latest.skippedCount) / latest.totalCount) * 100)) : 0;

  return <main className="shell adminPage">
    <header className="topbar"><div><p className="eyebrow">WAGI / ADMINISTRATION</p><h1>KB-Themenpflege</h1><p className="muted">Oberthemen, Sprachvarianten und der getrennte Knowledge-Base-Neuaufbau.</p></div><nav className="pageNav"><Link href="/">Dashboard</Link><Link href="/admin">Admin-Übersicht</Link><Link href="/admin/users">Benutzer</Link><Link href="/admin/ai-learning">Lernmodell</Link><Link className="pageNavActive" href="/admin/knowledge-topics">KB-Themen</Link></nav></header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel"><div className="panelHead"><div><h2>KB neu erstellen</h2><p className="muted">Die Verarbeitung läuft über einen separaten JetStream-Stream. Die aktuelle KB bleibt sichtbar, bis der neue Aufbau vollständig erfolgreich ist.</p></div><button className="primaryButton" type="button" disabled={working || latest?.status === "queued" || latest?.status === "running"} onClick={() => void rebuildKnowledge()}>{working ? "Starte …" : "KB neu erstellen"}</button></div>{latest && <div className="knowledgeRebuildStatus"><div><strong>{jobLabel(latest.status)}</strong><span>{latest.processedCount} von {latest.totalCount} Nachrichten · {latest.failedCount} Fehler · {latest.skippedCount} übersprungen</span></div><progress max="100" value={progress} /><small>{latest.error ?? `Zuletzt aktualisiert: ${formatDate(latest.updatedAt)}`}</small></div>}{jobs.length > 1 && <details><summary>Vorherige Neuaufbauten ({jobs.length - 1})</summary><div className="knowledgeRebuildHistory">{jobs.slice(1).map((job) => <div key={job.id}><span>{jobLabel(job.status)}</span><span>{job.processedCount}/{job.totalCount}</span><time>{formatDate(job.createdAt)}</time></div>)}</div></details>}</section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>Neues Thema anlegen</h2><p className="muted">Ein Thema wird pro Sprache separat gepflegt. Der Schlüssel verbindet die Sprachvarianten.</p></div></div><form className="learningCreateForm knowledgeTopicCreateForm" onSubmit={createTopic}><label><span>Sprache</span><select value={newTopic.language} onChange={(event) => setNewTopic({ ...newTopic, language: event.target.value as Language })}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Schlüssel</span><input required pattern="[a-z0-9][a-z0-9._-]{0,79}" value={newTopic.topicKey} onChange={(event) => setNewTopic({ ...newTopic, topicKey: event.target.value })} placeholder="z. B. health" /></label><label><span>Titel</span><input required value={newTopic.title} onChange={(event) => setNewTopic({ ...newTopic, title: event.target.value })} /></label><label><span>Beschreibung</span><input value={newTopic.description} onChange={(event) => setNewTopic({ ...newTopic, description: event.target.value })} /></label><label><span>Reihenfolge</span><input type="number" min="0" max="10000" value={newTopic.sortOrder} onChange={(event) => setNewTopic({ ...newTopic, sortOrder: event.target.value })} /></label><button className="primaryButton" disabled={working}>Anlegen</button></form></section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>{pageData.total} Themen</h2><p className="muted">Sprachvariante auswählen, suchen und kompakt bearbeiten.</p></div></div><form className="learningSearchForm" onSubmit={applySearch}><label className="learningSearchField"><span>Suche</span><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Schlüssel, Titel oder Beschreibung …" /></label><label><span>Sprache</span><select value={language} onChange={(event) => { setLanguage(event.target.value as Language); setPage(1); }}>{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Pro Seite</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><button className="primaryButton" type="submit">Suchen</button></form><div className="knowledgeTopicTable"><div className="knowledgeTopicHeader"><span>Schlüssel</span><span>Titel</span><span>Beschreibung</span><span>Aktiv</span><span>Aktionen</span></div>{pageData.items.map((topic) => <div className="knowledgeTopicRow" key={topic.id}><input aria-label="Themen-Schlüssel" value={topic.topicKey} onChange={(event) => changeTopic(topic.id, { topicKey: event.target.value })} /><input aria-label="Themen-Titel" value={topic.title} onChange={(event) => changeTopic(topic.id, { title: event.target.value })} /><input aria-label="Themen-Beschreibung" value={topic.description} onChange={(event) => changeTopic(topic.id, { description: event.target.value })} /><label className="knowledgeTopicEnabled"><input type="checkbox" checked={topic.enabled} onChange={(event) => changeTopic(topic.id, { enabled: event.target.checked })} /><span>{topic.enabled ? "Ja" : "Nein"}</span></label><span className="knowledgeTopicActions"><button className="textButton" type="button" onClick={() => void saveTopic(topic).catch((value) => setError(value instanceof Error ? value.message : "Speichern fehlgeschlagen"))}>Speichern</button><button className="dangerButton" type="button" onClick={() => void deleteTopic(topic)}>Löschen</button></span></div>)}{!pageData.items.length && <p className="adminEmpty">Keine Themen für diese Auswahl.</p>}</div><div className="learningPagination"><button className="textButton" type="button" disabled={pageData.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>← Zurück</button><span>Seite {pageData.page} / {Math.max(1, pageData.totalPages)}</span><button className="textButton" type="button" disabled={pageData.page >= pageData.totalPages} onClick={() => setPage((current) => current + 1)}>Weiter →</button></div></section>
  </main>;
}
