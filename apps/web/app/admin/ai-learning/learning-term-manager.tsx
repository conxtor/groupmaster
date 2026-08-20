"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, useAppLocale } from "../../auth";
import { adminCategoryDescription, adminCategoryName, adminTranslate } from "../admin-i18n";
import { Category, Language, categoryDescriptions, categoryNames, languageNames } from "./learning-shared";

type RelevanceLevel = "high" | "medium" | "low";
type SignalRole = "strong" | "supporting" | "generic" | "provisional";
type Group = { id: string; subject: string; platform?: string; chatType?: string; language?: Language };
type LearningTerm = { id: string; groupId?: string; groupSubject?: string; groupPlatform?: string; groupChatType?: string; groupLanguage?: Language; language: Language; category: Category; topicKey?: string; term: string; weight: number; relevanceLevel?: RelevanceLevel; signalRole: SignalRole; enabled: boolean; source: string; positiveCount: number; negativeCount: number; updatedAt: string };
type LearningPage = { items: LearningTerm[]; page: number; pageSize: number; total: number; totalPages: number };
type KnowledgeTopicDefinition = { id: string; language: Language; topicKey: string; title: string; enabled: boolean };
type KnowledgeTopicPage = { items: KnowledgeTopicDefinition[]; totalPages: number };

const categories = Object.keys(categoryNames) as Category[];

function formatDate(value?: string) { return value ? new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "–"; }

export default function LearningTermManager({ category, initialLanguage = "de" }: { category: Category; initialLanguage?: Language }) {
  const { locale } = useAppLocale();
  const at = (key: Parameters<typeof adminTranslate>[1], values?: Record<string, string | number>) => adminTranslate(locale, key, values);
  const [termPage, setTermPage] = useState<LearningPage>({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
  const [groups, setGroups] = useState<Group[]>([]);
  const [knowledgeTopics, setKnowledgeTopics] = useState<KnowledgeTopicDefinition[]>([]);
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sortWeight, setSortWeight] = useState(false);
  const [weightDirection, setWeightDirection] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<string[]>([]);
  const [newTerm, setNewTerm] = useState({ groupId: "", topicKey: "", term: "", weight: category === "exclusion" ? "-0.12" : "0.12", relevanceLevel: "medium" as RelevanceLevel, signalRole: "strong" as SignalRole });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [bulkWorking, setBulkWorking] = useState(false);

  async function load() {
    const query = new URLSearchParams({ language, category, page: String(page), pageSize: String(pageSize) });
    if (search) query.set("search", search);
    if (groupId) query.set("groupId", groupId);
    if (sortWeight) {
      query.set("sort", "weight");
      query.set("sortDirection", weightDirection);
    }
    const responses = await Promise.all([
      apiFetch(`/api/v1/admin/ai-learning?${query.toString()}`),
      apiFetch("/api/v1/groups"),
      category === "keyword" ? apiFetch(`/api/v1/admin/knowledge/topics?language=${language}&pageSize=100`) : Promise.resolve(null),
    ]);
    const [termsResponse, groupsResponse, topicsResponse] = responses;
    if (!termsResponse.ok || !groupsResponse.ok || (topicsResponse && !topicsResponse.ok)) throw new Error(at("loadFailed"));
    setTermPage(await termsResponse.json() as LearningPage);
    setGroups(await groupsResponse.json() as Group[]);
    if (topicsResponse) setKnowledgeTopics((await topicsResponse.json() as KnowledgeTopicPage).items.filter((topic) => topic.enabled));
    setSelected([]);
  }
  useEffect(() => { void load().catch((value) => setError(value instanceof Error ? value.message : at("loadFailed"))); }, [category, language, search, groupId, page, pageSize, sortWeight, weightDirection]);

  const pageIDs = useMemo(() => termPage.items.map((term) => term.id), [termPage.items]);
  const allSelected = pageIDs.length > 0 && pageIDs.every((id) => selected.includes(id));
  function resetPage() { setPage(1); setSelected([]); }
  function toggleWeightSort() {
    if (!sortWeight) {
      setSortWeight(true);
      setWeightDirection("desc");
    } else {
      setWeightDirection((current) => current === "desc" ? "asc" : "desc");
    }
    resetPage();
  }
  function applySearch(event: FormEvent) { event.preventDefault(); setSearch(searchInput.trim()); resetPage(); }
  function toggleOne(id: string) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function toggleAll() { setSelected(allSelected ? selected.filter((id) => !pageIDs.includes(id)) : Array.from(new Set([...selected, ...pageIDs]))); }

  async function createTerm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/ai-learning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: newTerm.groupId, language, category, topicKey: category === "keyword" ? newTerm.topicKey : "", term: newTerm.term, weight: Number(newTerm.weight), relevanceLevel: category === "relevance" ? newTerm.relevanceLevel : "", signalRole: category === "keyword" ? newTerm.signalRole : "supporting", enabled: true }) });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? at("create"));
      setNewTerm({ ...newTerm, term: "", topicKey: "" }); await load();
    } catch (value) { setError(value instanceof Error ? value.message : at("create")); } finally { setSaving(false); }
  }

  function changeTerm(id: string, patch: Partial<LearningTerm>) { setTermPage((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, ...patch } : item) })); }
  async function updateTerm(term: LearningTerm) {
    const response = await apiFetch(`/api/v1/admin/ai-learning/${encodeURIComponent(term.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: term.groupId ?? "", language: term.language, category, topicKey: term.topicKey ?? "", term: term.term, weight: Number(term.weight), relevanceLevel: category === "relevance" ? term.relevanceLevel ?? "medium" : "", signalRole: category === "keyword" ? term.signalRole : "supporting", enabled: term.enabled }) });
    if (!response.ok) throw new Error(at("save"));
    await load();
  }
  async function bulk(action: "delete" | "enable" | "disable") {
    if (!selected.length) return;
    if (action === "delete" && !window.confirm(`${selected.length} ${at("term")} · ${at("delete")}?`)) return;
    setBulkWorking(true); setError(null);
    try {
      const response = await apiFetch("/api/v1/admin/ai-learning/bulk", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: selected, action }) });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? at("bulkDelete"));
      await load();
    } catch (value) { setError(value instanceof Error ? value.message : at("bulkDelete")); } finally { setBulkWorking(false); }
  }

  async function deleteOne(term: LearningTerm) {
    if (!window.confirm(`${at("delete")} „${term.term}“?`)) return;
    setError(null);
    try {
      const response = await apiFetch(`/api/v1/admin/ai-learning/${encodeURIComponent(term.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? at("delete"));
      await load();
    } catch (value) { setError(value instanceof Error ? value.message : at("delete")); }
  }

  const topicOptions = Array.from(new Map([
    ...knowledgeTopics.map((topic) => [topic.topicKey, topic] as const),
    ...termPage.items.filter((term) => term.topicKey).map((term) => [term.topicKey as string, { id: `legacy-${term.topicKey}`, language, topicKey: term.topicKey as string, title: term.topicKey as string, enabled: true }] as const),
  ]).values());

  const columnLabels = category === "keyword"
    ? ["Auswahl", "Thema / Begriff", "Gruppe", "Gewicht", "Keyword-Rolle", "Geändert", "Aktionen"]
    : category === "relevance"
      ? ["Auswahl", "Begriff", "Gruppe", "Gewicht", "Relevanzstufe", "Geändert", "Aktionen"]
      : ["Auswahl", "Begriff", "Gruppe", "Gewicht", "Kategorie", "Geändert", "Aktionen"];

  const tableHeaders = category === "keyword"
    ? [at("select"), `${at("topicSelect")} / ${at("term")}`, at("group"), at("weight"), at("keywordRole"), at("changed"), at("actions")]
    : category === "relevance"
      ? [at("select"), at("term"), at("group"), at("weight"), at("relevanceLevel"), at("changed"), at("actions")]
      : [at("select"), at("term"), at("group"), at("weight"), adminCategoryName(locale, category), at("changed"), at("actions")];

  return <main className="shell adminPage"><header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{adminCategoryName(locale, category)}</h1><p className="muted">{adminCategoryDescription(locale, category)}</p></div></header>{error && <div className="notice">{error}</div>}
    <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("search")} &amp; {at("filter")}</h2><p className="muted">{at("search")} · {at("group")} · {at("language")}</p></div></div><form className="learningSearchForm" onSubmit={applySearch}><label className="learningSearchField"><span>{at("search")}</span><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={`${at("term")}, ${at("group")} …`} /></label><label><span>{at("language")}</span><select value={language} onChange={(event) => { setLanguage(event.target.value as Language); resetPage(); }}>{Object.entries(languageNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>{at("group")}</span><select value={groupId} onChange={(event) => { setGroupId(event.target.value); resetPage(); }}><option value="">{at("allGroups")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select></label><label><span>{at("perPage")}</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); resetPage(); }}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><button className="primaryButton" type="submit">{at("search")}</button></form></section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("create")} {at("term")}</h2><p className="muted">{adminCategoryDescription(locale, category)}</p></div></div><form className="learningCreateForm learningCategoryCreateForm" onSubmit={createTerm}>{category === "keyword" && <select aria-label={at("topicSelect")} required value={newTerm.topicKey} onChange={(event) => setNewTerm({ ...newTerm, topicKey: event.target.value })}><option value="">{at("topicSelect")}</option>{topicOptions.map((topic) => <option key={topic.topicKey} value={topic.topicKey}>{topic.title} ({topic.topicKey})</option>)}</select>}<select aria-label={at("group")} value={newTerm.groupId} onChange={(event) => setNewTerm({ ...newTerm, groupId: event.target.value })}><option value="">{at("globalGroups")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select><input aria-label={at("term")} placeholder={at("term")} required value={newTerm.term} onChange={(event) => setNewTerm({ ...newTerm, term: event.target.value })} /><input aria-label={at("weight")} type="number" step="0.01" min="-10" max="10" value={newTerm.weight} onChange={(event) => setNewTerm({ ...newTerm, weight: event.target.value })} />{category === "keyword" && <select aria-label={at("keywordRole")} value={newTerm.signalRole} onChange={(event) => setNewTerm({ ...newTerm, signalRole: event.target.value as SignalRole })}><option value="strong">{at("signalStrong")}</option><option value="supporting">{at("signalSupporting")}</option><option value="generic">{at("signalGeneric")}</option></select>}{category === "relevance" && <select aria-label={at("relevanceLevel")} value={newTerm.relevanceLevel} onChange={(event) => setNewTerm({ ...newTerm, relevanceLevel: event.target.value as RelevanceLevel })}><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option></select>}<button className="primaryButton" disabled={saving}>{saving ? "…" : at("create")}</button></form></section>
    <section className="panel adminPanel"><div className="panelHead"><div><h2>{termPage.total} {at("term")}</h2><p className="muted">{at("pageOf", { page: termPage.page, total: Math.max(1, termPage.totalPages) })} · {selected.length} {at("select")}</p></div><div className="learningBulkActions"><button className="textButton" type="button" disabled={!selected.length || bulkWorking} onClick={() => void bulk("enable")}>{at("enable")}</button><button className="textButton" type="button" disabled={!selected.length || bulkWorking} onClick={() => void bulk("disable")}>{at("disable")}</button><button className="dangerButton" type="button" disabled={!selected.length || bulkWorking} onClick={() => void bulk("delete")}>{at("bulkDelete")}</button></div></div><div className="learningSelectAll"><label><input type="checkbox" checked={allSelected} onChange={toggleAll} /> {at("allOnPage")}</label></div><div className="learningTermList"><div className="learningTermHeader">{tableHeaders.map((label, index) => <span key={label}>{index === 3 ? <button className="learningSortButton" type="button" onClick={toggleWeightSort} aria-label={at("weight")} aria-pressed={sortWeight}>{label} {sortWeight ? (weightDirection === "desc" ? "↓" : "↑") : "↕"}</button> : label}</span>)}</div>{termPage.items.map((term) => <div className={`learningTermRow ${selected.includes(term.id) ? "learningTermSelected" : ""}`} key={term.id}><label className="learningTermCheck"><input type="checkbox" checked={selected.includes(term.id)} onChange={() => toggleOne(term.id)} aria-label={`${term.term} ${at("select")}`} /></label><div className="learningTermMain">{category === "keyword" && <select aria-label={at("topicSelect")} value={term.topicKey ?? ""} onChange={(event) => changeTerm(term.id, { topicKey: event.target.value })}><option value="">{at("topicSelect")}</option>{topicOptions.map((topic) => <option key={topic.topicKey} value={topic.topicKey}>{topic.title} ({topic.topicKey})</option>)}{term.topicKey && !topicOptions.some((topic) => topic.topicKey === term.topicKey) && <option value={term.topicKey}>{term.topicKey}</option>}</select>}<input aria-label={at("term")} value={term.term} onChange={(event) => changeTerm(term.id, { term: event.target.value })} /><small>{term.groupSubject ?? at("globalGroups")} · {term.groupPlatform ?? "all"} · {term.source} · +{term.positiveCount} / −{term.negativeCount}</small></div><select aria-label={at("group")} value={term.groupId ?? ""} onChange={(event) => changeTerm(term.id, { groupId: event.target.value || undefined })}><option value="">{at("globalGroups")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select><input aria-label={at("weight")} type="number" step="0.01" min="-10" max="10" value={term.weight} onChange={(event) => changeTerm(term.id, { weight: Number(event.target.value) })} />{category === "relevance" ? <select aria-label={at("relevanceLevel")} value={term.relevanceLevel ?? "medium"} onChange={(event) => changeTerm(term.id, { relevanceLevel: event.target.value as RelevanceLevel })}><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option></select> : category === "keyword" ? <select aria-label={at("keywordRole")} value={term.signalRole ?? "supporting"} onChange={(event) => changeTerm(term.id, { signalRole: event.target.value as SignalRole })}><option value="strong">{at("signalStrong")}</option><option value="supporting">{at("signalSupporting")}</option><option value="generic">{at("signalGeneric")}</option><option value="provisional">{at("signalProvisional")}</option></select> : <span className="learningFieldPlaceholder">{adminCategoryName(locale, category)}</span>}<span className="learningTermUpdated">{formatDate(term.updatedAt)}</span><span className="learningTermActions"><button className="textButton" type="button" onClick={() => void updateTerm(term).catch((value) => setError(value instanceof Error ? value.message : at("save")))}>{at("save")}</button><button className="dangerButton" type="button" onClick={() => void deleteOne(term)}>{at("delete")}</button></span></div>)}{!termPage.items.length && <p className="adminEmpty">{at("noTerms")}</p>}</div><div className="learningPagination"><button className="textButton" type="button" disabled={termPage.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>{at("previous")}</button><span>{at("pageOf", { page: termPage.page, total: Math.max(1, termPage.totalPages) })}</span><button className="textButton" type="button" disabled={termPage.page >= termPage.totalPages} onClick={() => setPage((current) => current + 1)}>{at("next")}</button></div></section>
  </main>;

  return <main className="shell adminPage"><header className="topbar"><div><p className="eyebrow">WAGI / KI-LERNMODELL</p><h1>{categoryNames[category]}</h1><p className="muted">{categoryDescriptions[category]}</p></div><nav className="pageNav"><Link href="/admin/ai-learning">Übersicht</Link>{category === "keyword" && <Link href="/admin/knowledge-topics">KB-Themen</Link>}<Link href="/admin">Admin</Link></nav></header>{error && <div className="notice">{error}</div>}<section className="panel adminPanel"><div className="panelHead"><div><h2>Filter und Suche</h2><p className="muted">Suche nach Begriff, Thema, Gruppe, Plattform oder Quelle.</p></div></div><form className="learningSearchForm" onSubmit={applySearch}><label className="learningSearchField"><span>Suche</span><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Begriff, Gruppe, Quelle …" /></label><label><span>Sprache</span><select value={language} onChange={(event) => { setLanguage(event.target.value as Language); resetPage(); }}>{Object.entries(languageNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span>Gruppe</span><select value={groupId} onChange={(event) => { setGroupId(event.target.value); resetPage(); }}><option value="">Alle Gruppen</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select></label><label><span>Pro Seite</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); resetPage(); }}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label><button className="primaryButton" type="submit">Suchen</button></form></section><section className="panel adminPanel"><div className="panelHead"><div><h2>Neuen Begriff anlegen</h2><p className="muted">Kategorie: {categoryNames[category]}. Felder ohne Bedeutung für diese Kategorie werden ausgeblendet.</p></div>{category === "keyword" && <Link className="secondaryButton" href="/admin/knowledge-topics">Themen verwalten</Link>}</div><form className="learningCreateForm learningCategoryCreateForm" onSubmit={createTerm}>{category === "keyword" && <select aria-label="Thema" required value={newTerm.topicKey} onChange={(event) => setNewTerm({ ...newTerm, topicKey: event.target.value })}><option value="">Thema auswählen …</option>{topicOptions.map((topic) => <option key={topic.topicKey} value={topic.topicKey}>{topic.title} ({topic.topicKey})</option>)}</select>}<select aria-label="Gruppe" value={newTerm.groupId} onChange={(event) => setNewTerm({ ...newTerm, groupId: event.target.value })}><option value="">Global / alle Gruppen</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select><input aria-label="Begriff" placeholder="Begriff oder Wortstamm" required value={newTerm.term} onChange={(event) => setNewTerm({ ...newTerm, term: event.target.value })} /><input aria-label="Gewicht" type="number" step="0.01" min="-10" max="10" value={newTerm.weight} onChange={(event) => setNewTerm({ ...newTerm, weight: event.target.value })} />{category === "relevance" && <select aria-label="Relevanzstufe" value={newTerm.relevanceLevel} onChange={(event) => setNewTerm({ ...newTerm, relevanceLevel: event.target.value as RelevanceLevel })}><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option></select>}<button className="primaryButton" disabled={saving}>{saving ? "Speichert …" : "Anlegen"}</button></form></section><section className="panel adminPanel"><div className="panelHead"><div><h2>{termPage.total} Begriffe</h2><p className="muted">Seite {termPage.page} von {Math.max(1, termPage.totalPages)} · markiert: {selected.length}</p></div><div className="learningBulkActions"><button className="textButton" type="button" disabled={!selected.length || bulkWorking} onClick={() => void bulk("enable")}>Aktivieren</button><button className="textButton" type="button" disabled={!selected.length || bulkWorking} onClick={() => void bulk("disable")}>Deaktivieren</button><button className="dangerButton" type="button" disabled={!selected.length || bulkWorking} onClick={() => void bulk("delete")}>Löschen</button></div></div><div className="learningSelectAll"><label><input type="checkbox" checked={allSelected} onChange={toggleAll} /> Alle auf dieser Seite auswählen</label></div><div className="learningTermList"><div className="learningTermHeader" aria-hidden="true">{columnLabels.map((label) => <span key={label}>{label}</span>)}</div>{termPage.items.map((term) => <div className={`learningTermRow ${selected.includes(term.id) ? "learningTermSelected" : ""}`} key={term.id}><label className="learningTermCheck"><input type="checkbox" checked={selected.includes(term.id)} onChange={() => toggleOne(term.id)} aria-label={`${term.term} auswählen`} /></label><div className="learningTermMain">{category === "keyword" && <select aria-label="Thema" value={term.topicKey ?? ""} onChange={(event) => changeTerm(term.id, { topicKey: event.target.value })}><option value="">Thema auswählen …</option>{topicOptions.map((topic) => <option key={topic.topicKey} value={topic.topicKey}>{topic.title} ({topic.topicKey})</option>)}{term.topicKey && !topicOptions.some((topic) => topic.topicKey === term.topicKey) && <option value={term.topicKey}>{term.topicKey}</option>}</select>}<input aria-label="Begriff" value={term.term} onChange={(event) => changeTerm(term.id, { term: event.target.value })} /><small>{term.groupSubject ?? "Global"} · {term.groupPlatform ?? "alle Plattformen"} · {term.source} · +{term.positiveCount} / −{term.negativeCount}</small></div><select aria-label="Gruppe" value={term.groupId ?? ""} onChange={(event) => changeTerm(term.id, { groupId: event.target.value || undefined })}><option value="">Global</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.subject}</option>)}</select><input aria-label="Gewicht" type="number" step="0.01" min="-10" max="10" value={term.weight} onChange={(event) => changeTerm(term.id, { weight: Number(event.target.value) })} />{category === "relevance" ? <select aria-label="Stufe" value={term.relevanceLevel ?? "medium"} onChange={(event) => changeTerm(term.id, { relevanceLevel: event.target.value as RelevanceLevel })}><option value="high">Hoch</option><option value="medium">Mittel</option><option value="low">Niedrig</option></select> : <span className="learningFieldPlaceholder">{category === "keyword" ? term.topicKey ?? "Thema fehlt" : categoryNames[category]}</span>}<span className="learningTermUpdated">{formatDate(term.updatedAt)}</span><span className="learningTermActions"><button className="textButton" type="button" onClick={() => void updateTerm(term).catch((value) => setError(value instanceof Error ? value.message : "Speichern fehlgeschlagen"))}>Speichern</button><button className="dangerButton" type="button" onClick={() => void deleteOne(term)}>Löschen</button></span></div>)}{!termPage.items.length && <p className="adminEmpty">Keine Begriffe für diese Auswahl.</p>}</div><div className="learningPagination"><button className="textButton" type="button" disabled={termPage.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>← Zurück</button><span>Seite {termPage.page} / {Math.max(1, termPage.totalPages)}</span><button className="textButton" type="button" disabled={termPage.page >= termPage.totalPages} onClick={() => setPage((current) => current + 1)}>Weiter →</button></div></section></main>;
}

export function isLearningCategory(value: string): value is Category { return categories.includes(value as Category); }
