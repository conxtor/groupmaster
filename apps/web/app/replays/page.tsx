"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch, useAppLocale } from "../auth";
import { buildGroupHierarchy, type GroupHierarchyNode } from "../group-hierarchy";
import {
  type Locale,
  type TranslationKey,
  type TranslationValues,
} from "../i18n";

type Group = { id: string; subject: string; isSelected: boolean; platform?: string; chatType?: string };
type ReplayJob = {
  id: string;
  groupIds: string[];
  from: string;
  to: string;
  includeMedia: boolean;
  status: string;
  totalCount: number;
  processedCount: number;
  failedCount: number;
  createdAt: string;
};
type Translator = (key: TranslationKey, values?: TranslationValues) => string;

function dateDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function nextDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function GroupBranch({ node, selected, onToggle, depth = 0 }: { node: GroupHierarchyNode<Group>; selected: Set<string>; onToggle: (id: string) => void; depth?: number }) {
  const group = node.group;
  return <div className={depth > 0 ? "selectionChild" : ""}>
    <label className="selectionRow replayGroupRow">
      <span className="selectionIdentity"><span className="avatar">{group.subject.slice(0, 1).toUpperCase()}</span><span><strong>{group.subject}</strong><small>{group.platform === "telegram" ? "Telegram" : "WhatsApp"} · {group.chatType ?? "group"}</small></span></span>
      <input type="checkbox" checked={selected.has(group.id)} onChange={() => onToggle(group.id)} />
    </label>
    {node.children.map((child) => <GroupBranch key={child.group.id} node={child} selected={selected} onToggle={onToggle} depth={depth + 1} />)}
  </div>;
}

export default function ReplaysPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [jobs, setJobs] = useState<ReplayJob[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState(dateDaysAgo(7));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [includeMedia, setIncludeMedia] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { locale, t } = useAppLocale();

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [groupsResponse, jobsResponse] = await Promise.all([apiFetch("/api/v1/groups"), apiFetch("/api/v1/replays")]);
        if (!groupsResponse.ok || !jobsResponse.ok) throw new Error(t("replayError"));
        const nextGroups = await groupsResponse.json() as Group[];
        const nextJobs = await jobsResponse.json() as ReplayJob[];
        if (!active) return;
        setGroups(nextGroups);
        setJobs(nextJobs);
        setSelected((current) => current.size ? new Set([...current].filter((id) => nextGroups.some((group) => group.id === id && group.isSelected))) : new Set(nextGroups.filter((group) => group.isSelected).map((group) => group.id)));
        setError(null);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : t("replayError"));
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [locale]);

  const hierarchy = useMemo(() => buildGroupHierarchy(groups.filter((group) => group.isSelected)), [groups]);

  function toggleGroup(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const response = await apiFetch("/api/v1/replays", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupIds: [...selected], from: `${from}T00:00:00Z`, to: `${nextDay(to)}T00:00:00Z`, includeMedia }) });
      if (!response.ok) throw new Error(t("replayError"));
      const job = await response.json() as ReplayJob;
      setJobs((current) => [job, ...current]);
      setNotice(t("replaySubmitted"));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("replayError"));
    } finally {
      setBusy(false);
    }
  }

  return <AuthGate><main className="shell">
    <header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{t("replayBackfillTitle")}</h1></div></header>
    {notice && <div className="notice">{notice}</div>}{error && <div className="notice">{error}</div>}
    <form className="panel" onSubmit={submit}><div className="panelHead"><div><h2>{t("replayBackfillTitle")}</h2><p className="muted">{t("replayBackfillHint")}</p></div></div><div className="filterGrid"><label><span>{t("replayFrom")}</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label><label><span>{t("replayTo")}</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></label><label className="filterCheck"><input type="checkbox" checked={includeMedia} onChange={(event) => setIncludeMedia(event.target.checked)} /><span>{t("replayIncludeMedia")}</span></label></div><h3>{t("replayGroups")}</h3><div className="selectionList">{hierarchy.map((node) => <GroupBranch key={node.group.id} node={node} selected={selected} onToggle={toggleGroup} />)}</div><button className="primaryButton" type="submit" disabled={busy || selected.size === 0}>{busy ? "…" : t("startReplay")}</button></form>
    <section className="panel"><div className="panelHead"><h2>{t("replayJobs")}</h2></div>{jobs.length === 0 ? <p className="muted">{t("replayNoJobs")}</p> : <div className="jobList">{jobs.map((job) => <article className="jobRow" key={job.id}><div><strong>{job.status}</strong><small>{new Date(job.from).toLocaleDateString(locale)} – {new Date(job.to).toLocaleDateString(locale)}</small></div><span>{t("replayProgress", { processed: job.processedCount, total: job.totalCount, failed: job.failedCount })}</span></article>)}</div>}</section>
    <footer><span>{t("footer")}</span><Link href="/">{t("openDashboard")}</Link></footer>
  </main></AuthGate>;
}
