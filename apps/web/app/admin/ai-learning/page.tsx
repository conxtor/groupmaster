"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch } from "../../auth";

type Language = "de" | "es" | "ca" | "en" | "fr";
type Category = "relevance" | "event" | "place" | "keyword" | "exclusion";
type Group = { id: string; subject: string; platform?: string; language?: Language };
type LearningTerm = {
  id: string;
  groupId?: string;
  groupSubject?: string;
  language: Language;
  category: Category;
  topicKey?: string;
  term: string;
  weight: number;
  relevanceLevel?: "high" | "medium" | "low";
  enabled: boolean;
  source: string;
  positiveCount: number;
  negativeCount: number;
};

const languageNames: Record<Language, string> = { de: "Deutsch", es: "Español", ca: "Català", en: "English", fr: "Français" };
const categoryNames: Record<Category, string> = { relevance: "Relevanz", event: "Events", place: "Orte", keyword: "Knowledge-Schlüsselwort", exclusion: "Ausschlusswort" };

function AdminAILearningContent() {
  const [terms, setTerms] = useState<LearningTerm[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [language, setLanguage] = useState<Language>("de");
  const [category, setCategory] = useState<Category | "all">("all");
  const [newTerm, setNewTerm] = useState({ groupId: "", category: "relevance" as Category, topicKey: "", term: "", weight: "0.12", relevanceLevel: "medium" as "high" | "medium" | "low" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    const query = new URLSearchParams({ language });
    if (category !== "all") query.set("category", category);
    const [termsResponse, groupsResponse] = await Promise.all([apiFetch(`/api/v1/admin/ai-learning?${query.toString()}`), apiFetch("/api/v1/groups")]);
    if (!termsResponse.ok || !groupsResponse.ok) throw new Error("Lernmodell konnte nicht geladen werden");
    setTerms(await termsResponse.json() as LearningTerm[]);
    setGroups(await groupsResponse.json() as Group[]);
  }

  useEffect(() => { void load().catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen")); }, [language, category]);

  const shownTerms = useMemo(() => terms.filter((term) => term.language === language), [terms, language]);

  async function createTerm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/ai-learning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...newTerm, language, weight: Number(newTerm.weight), enabled: true }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "Lernbegriff konnte nicht gespeichert werden");
      setNewTerm({ ...newTerm, term: "", topicKey: "" });
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  async function updateTerm(term: LearningTerm) {
    const response = await apiFetch(`/api/v1/admin/ai-learning/${encodeURIComponent(term.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId: term.groupId ?? "", language: term.language, category: term.category, topicKey: term.topicKey ?? "", term: term.term, weight: Number(term.weight), relevanceLevel: term.relevanceLevel ?? "", enabled: term.enabled }),
    });
    if (!response.ok) throw new Error("Lernbegriff konnte nicht aktualisiert werden");
  }

  async function deleteTerm(term: LearningTerm) {
    if (!window.confirm(`„${term.term}“ wirklich löschen?`)) return;
    const response = await apiFetch(`/api/v1/admin/ai-learning/${encodeURIComponent(term.id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Lernbegriff konnte nicht gelöscht werden");
    setTerms((current) => current.filter((item) => item.id !== term.id));
  }

  function changeTerm(id: string, patch: Partial<LearningTerm>) {
    setTerms((current) => current.map((term) => term.id === id ? { ...term, ...patch } : term));
  }

  return <main className="shell adminPage">
    <header className="topbar"><div><p className="eyebrow">WAGI / ADMINISTRATION</p><h1>KI-Lernmodell</h1><p className="muted">Sprachabhängige Schlüsselwörter, Ausschlüsse und gruppenbezogene Feedback-Gewichte.</p></div><nav className="pageNav"><Link href="/">Dashboard</Link><Link href="/admin">Admin-Übersicht</Link><Link href="/admin/users">Benutzer</Link><Link className="pageNavActive" href="/admin/ai-learning">Lernmodell</Link></nav></header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel"><div className="panelHead"><div><h2>Sprache und Bereich</h2><p className="muted">Globale Begriffe gelten als Defaults. Begriffe mit Gruppe wirken dort zusätzlich und stärker.</p></div></div><div className="learningToolbar"><label><span>Sprache</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)}>{Object.entries(languageNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Bereich</span><select value={category} onChange={(event) => setCategory(event.target.value as Category | "all")}><option value="all">Alle Bereiche</option>{Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>Neuen Lernbegriff anlegen</h2><p className="muted">Ein leerer Gruppenwert legt einen globalen Sprachbegriff an.</p></div></div><form className="learningCreateForm" onSubmit={createTerm}><select aria-label="Bereich" value={newTerm.category} onChange={(event) => setNewTerm({ ...newTerm, category: event.target.value as Category })}>{Object.entries(categoryNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Gruppe" value={newTerm.groupId} onChange={(event) => setNewTerm({ ...newTerm, groupId: event.target.value })}><option value="">Alle Gruppen</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select><input aria-label="Thema" placeholder="Thema (nur Schlüsselwort)" value={newTerm.topicKey} onChange={(event) => setNewTerm({ ...newTerm, topicKey: event.target.value })} /><input aria-label="Begriff" placeholder="Begriff oder Wortstamm" required value={newTerm.term} onChange={(event) => setNewTerm({ ...newTerm, term: event.target.value })} /><input aria-label="Gewicht" type="number" step="0.01" min="-10" max="10" value={newTerm.weight} onChange={(event) => setNewTerm({ ...newTerm, weight: event.target.value })} /><select aria-label="Relevanzstufe" value={newTerm.relevanceLevel} onChange={(event) => setNewTerm({ ...newTerm, relevanceLevel: event.target.value as "high" | "medium" | "low" })}><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option></select><button className="primaryButton" disabled={saving}>{saving ? "Speichert …" : "Anlegen"}</button></form></section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>Begriffe für {languageNames[language]}</h2><p className="muted">Systembegriffe sind editierbar. Feedback-Einträge zeigen ihre positiven und negativen Lernsignale.</p></div><span className="count">{shownTerms.length}</span></div><div className="learningTermList">{shownTerms.map((term) => <div className="learningTermRow" key={term.id}><div className="learningTermMain"><input aria-label="Begriff" value={term.term} onChange={(event) => changeTerm(term.id, { term: event.target.value })} /><small>{categoryNames[term.category]} · {term.groupSubject ?? "global"} · {term.source} · +{term.positiveCount} / −{term.negativeCount}</small></div><input aria-label="Gewicht" type="number" step="0.01" min="-10" max="10" value={term.weight} onChange={(event) => changeTerm(term.id, { weight: Number(event.target.value) })} /><select aria-label="Stufe" value={term.relevanceLevel ?? "medium"} disabled={term.category !== "relevance"} onChange={(event) => changeTerm(term.id, { relevanceLevel: event.target.value as "high" | "medium" | "low" })}><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option></select><label className="learningEnabled"><input type="checkbox" checked={term.enabled} onChange={(event) => changeTerm(term.id, { enabled: event.target.checked })} /> aktiv</label><button className="textButton" type="button" onClick={() => void updateTerm(term).catch((value) => setError(value instanceof Error ? value.message : "Aktualisierung fehlgeschlagen"))}>Speichern</button><button className="textButton dangerButton" type="button" onClick={() => void deleteTerm(term).catch((value) => setError(value instanceof Error ? value.message : "Löschen fehlgeschlagen"))}>Löschen</button></div>)}{!shownTerms.length && <p className="adminEmpty">Keine Begriffe für diese Auswahl.</p>}</div></section>
  </main>;
}

export default function AdminAILearningPage() {
  return <AuthGate><AdminAILearningContent /></AuthGate>;
}
