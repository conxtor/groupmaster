"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch } from "../auth";

type AdminUser = { id: string; email: string; name: string; status: "active" | "disabled"; roles: string[]; createdAt: string };
type LabelCount = { label: string; count: number };
type Observability = {
  generatedAt: string;
  summary: {
    users: number; activeUsers: number; disabledUsers: number; adminUsers: number;
    groups: number; selectedGroups: number; messages: number; recentMessages: number;
    relevantMessages: number; processingFailures: number; lastMessageAt?: string;
    groupsByPlatform: LabelCount[]; messagesByKind: LabelCount[];
  };
  processingLoops: Array<{ name: string; total: number; queued: number; processing: number; completed: number; failed: number; retry: number; oldestWaitSeconds: number }>;
  queues: Array<{ platform: string; kind: string; waiting: number; oldestWaitSeconds: number; capacity: number; active: number }>;
  connectorPools: Array<{ platform: string; processingCapacity: number; onboardingCapacity: number; activeProcessing: number; activeOnboarding: number; availableProcessing: number; availableOnboarding: number; processingWaiting: number; processingWaitSeconds: number; onboardingWaiting: number; onboardingWaitSeconds: number }>;
  activeLeases: Array<{ accountId: string; platform: string; leaseKind: string; workerId: string; leaseUntil: string; remainingSeconds: number; userId: string; userName: string; userEmail: string; accountStatus: string }>;
  recentLeases: Array<{ id: string; accountId: string; platform: string; leaseKind: string; workerId: string; userId: string; userName: string; userEmail: string; accountStatus: string; startedAt: string; leaseUntil: string; endedAt?: string; durationSeconds: number; state: string; endReason?: string }>;
  aiProcessingHistory: Array<{ id: string; messageId: string; mediaType: string; status: string; attempts: number; model?: string; groupSubject?: string; createdAt: string; updatedAt: string; durationSeconds: number; error?: string }>;
  nats: { connected: boolean; servers: string[]; inMessages: number; outMessages: number; inBytes: number; outBytes: number; reconnects: number };
  streams: Array<{ name: string; status: string; subjects: string[]; storage: string; messages: number; bytes: number; firstSequence: number; lastSequence: number; error?: string; consumers: Array<{ name: string; filterSubject: string; pending: number; ackPending: number; redelivered: number; waiting: number; maxDeliver: number }> }>;
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatWait(seconds: number) {
  if (!seconds || seconds < 1) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function platformLabel(platform: string) {
  return platform === "whatsapp" ? "WhatsApp" : platform === "telegram" ? "Telegram" : platform;
}

function kindLabel(kind: string) {
  return kind === "processing" ? "Verarbeitung" : kind === "onboarding" ? "Einrichtung" : kind;
}

function AdminContent() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [observability, setObservability] = useState<Observability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function loadUsers() {
    const response = await apiFetch("/api/v1/admin/users");
    if (!response.ok) throw new Error("Nutzer konnten nicht geladen werden");
    setUsers(await response.json() as AdminUser[]);
  }

  async function loadObservability(showLoading = false) {
    if (showLoading) setRefreshing(true);
    try {
      const response = await apiFetch("/api/v1/admin/observability");
      if (!response.ok) throw new Error("Betriebsdaten konnten nicht geladen werden");
      setObservability(await response.json() as Observability);
      setError(null);
    } finally {
      if (showLoading) setRefreshing(false);
    }
  }

  useEffect(() => {
    void Promise.all([loadUsers(), loadObservability(true)]).catch((value) => setError(value instanceof Error ? value.message : "Laden fehlgeschlagen"));
    const interval = window.setInterval(() => { void loadObservability().catch((value) => setError(value instanceof Error ? value.message : "Aktualisierung fehlgeschlagen")); }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  async function updateUser(user: AdminUser, patch: Partial<Pick<AdminUser, "roles" | "status">>) {
    const role = patch.roles?.[0] ?? user.roles[0] ?? "user";
    const status = patch.status ?? user.status;
    const response = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, status }) });
    if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error ?? "Nutzer konnte nicht aktualisiert werden"); }
    await loadUsers();
  }

  const summary = observability?.summary;
  const streamMessages = observability?.streams.reduce((total, stream) => total + stream.messages, 0) ?? 0;

  return <main className="shell adminPage">
    <header className="topbar"><div><p className="eyebrow">WAGI / ADMINISTRATION</p><h1>Betriebsübersicht</h1><p className="adminRefresh">{observability ? `Live-Daten: ${new Date(observability.generatedAt).toLocaleTimeString()}` : "Betriebsdaten werden geladen …"}{refreshing && " · aktualisiere …"}</p></div><nav className="pageNav"><Link href="/">Dashboard</Link><Link href="/groups">Gruppen</Link><Link href="/connectors">Konnektoren</Link><Link className="pageNavActive" href="/admin">Admin</Link></nav></header>
    {error && <div className="notice">{error}</div>}

    {summary && <section className="adminMetricsGrid">
      <article className="panel adminMetric"><small>Nachrichten</small><strong>{summary.messages.toLocaleString()}</strong><span>{summary.recentMessages.toLocaleString()} in den letzten 24 Stunden</span></article>
      <article className="panel adminMetric"><small>Nutzer</small><strong>{summary.activeUsers.toLocaleString()}</strong><span>{summary.adminUsers} Administratoren · {summary.disabledUsers} deaktiviert</span></article>
      <article className="panel adminMetric"><small>Gruppen</small><strong>{summary.groups.toLocaleString()}</strong><span>{summary.selectedGroups.toLocaleString()} ausgewählt und verarbeitet</span></article>
      <article className="panel adminMetric"><small>Verarbeitungsfehler</small><strong className={summary.processingFailures ? "metricWarning" : ""}>{summary.processingFailures.toLocaleString()}</strong><span>offene Einträge in der Fehlerablage</span></article>
      <article className="panel adminMetric"><small>Relevante Nachrichten</small><strong>{summary.relevantMessages.toLocaleString()}</strong><span>{summary.messages ? `${Math.round((summary.relevantMessages / summary.messages) * 100)} %` : "0 %"} aller Nachrichten</span></article>
      <article className="panel adminMetric"><small>JetStream-Ereignisse</small><strong>{streamMessages.toLocaleString()}</strong><span>{observability?.streams.length ?? 0} Streams überwacht</span></article>
      <article className="panel adminMetric"><small>NATS-Verbindung</small><strong className={observability?.nats.connected ? "metricGood" : "metricWarning"}>{observability?.nats.connected ? "Online" : "Offline"}</strong><span>{observability?.nats.servers.length ?? 0} Server · {observability?.nats.reconnects ?? 0} Reconnects</span></article>
      <article className="panel adminMetric"><small>Letzte Nachricht</small><strong>{summary.lastMessageAt ? new Date(summary.lastMessageAt).toLocaleDateString() : "—"}</strong><span>{summary.lastMessageAt ? new Date(summary.lastMessageAt).toLocaleTimeString() : "Noch keine Nachricht"}</span></article>
    </section>}

    {observability && <>
      <section className="panel adminPanel"><div className="panelHead"><div><h2>Verarbeitungsschleifen</h2><p className="muted">Status der Audio-, Medien-, KI-, Inbox- und Replay-Verarbeitung.</p></div></div><div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>Schleife</th><th>Gesamt</th><th>Wartend</th><th>Aktiv</th><th>Erledigt</th><th>Fehler</th><th>Retry</th><th>Älteste Wartezeit</th></tr></thead><tbody>{observability.processingLoops.map((loop) => <tr key={loop.name}><td><strong>{loop.name}</strong></td><td>{loop.total.toLocaleString()}</td><td>{loop.queued.toLocaleString()}</td><td>{loop.processing.toLocaleString()}</td><td>{loop.completed.toLocaleString()}</td><td className={loop.failed ? "metricWarning" : ""}>{loop.failed.toLocaleString()}</td><td>{loop.retry.toLocaleString()}</td><td>{formatWait(loop.oldestWaitSeconds)}</td></tr>)}</tbody></table></div></section>

      <div className="observabilityGrid poolQueueGrid">
        <section className="panel adminPanel"><div className="panelHead"><div><h2>Konnektor-Pools</h2><p className="muted">Kapazität, aktive Nutzer und Wartezeiten pro Pool.</p></div></div><div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>Pool</th><th>Verarbeitung</th><th>Einrichtung</th><th>Warteschlange</th><th>Freie Slots</th></tr></thead><tbody>{observability.connectorPools.map((pool) => <tr key={pool.platform}><td><strong>{platformLabel(pool.platform)}</strong></td><td>{pool.activeProcessing}/{pool.processingCapacity} aktiv</td><td>{pool.activeOnboarding}/{pool.onboardingCapacity} aktiv</td><td>{pool.processingWaiting} · {formatWait(pool.processingWaitSeconds)}<br /><small>Setup: {pool.onboardingWaiting} · {formatWait(pool.onboardingWaitSeconds)}</small></td><td>{pool.availableProcessing} / {pool.availableOnboarding}</td></tr>)}</tbody></table></div></section>
        <section className="panel adminPanel"><div className="panelHead"><div><h2>Warteschlangen</h2><p className="muted">Aktuelle Belegung und Wartepositionen.</p></div></div><div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>Connector</th><th>Typ</th><th>Wartend</th><th>Aktiv</th><th>Kapazität</th><th>Wartezeit</th></tr></thead><tbody>{observability.queues.map((queue) => <tr key={`${queue.platform}-${queue.kind}`}><td>{platformLabel(queue.platform)}</td><td>{kindLabel(queue.kind)}</td><td className={queue.waiting ? "metricWarning" : ""}>{queue.waiting}</td><td>{queue.active}</td><td>{queue.capacity}</td><td>{formatWait(queue.oldestWaitSeconds)}</td></tr>)}</tbody></table></div></section>
      </div>

      <section className="panel adminPanel"><div className="panelHead"><div><h2>Aktive Nutzer in den Connector-Prozessen</h2><p className="muted">Diese Leases zeigen, welcher Nutzer aktuell einen Pool-Slot belegt.</p></div><span className="count">{observability.activeLeases.length}</span></div>{observability.activeLeases.length ? <div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>Nutzer</th><th>Connector</th><th>Prozess</th><th>Worker</th><th>Lease endet</th><th>Restzeit</th></tr></thead><tbody>{observability.activeLeases.map((lease) => <tr key={`${lease.accountId}-${lease.leaseKind}`}><td><strong>{lease.userName}</strong><br /><small>{lease.userEmail}</small></td><td>{platformLabel(lease.platform)}</td><td>{kindLabel(lease.leaseKind)}</td><td className="mono">{lease.workerId}</td><td>{new Date(lease.leaseUntil).toLocaleTimeString()}</td><td>{formatWait(lease.remainingSeconds)}</td></tr>)}</tbody></table></div> : <p className="adminEmpty">Aktuell belegt kein Nutzer einen Connector-Slot.</p>}</section>

      <section className="panel adminPanel"><div className="panelHead"><div><h2>Letzte 10 Nutzer in den Connector-Prozessen</h2><p className="muted">Historische Pool-Belegungen seit Aktivierung der Lease-Historie.</p></div><span className="count">{observability.recentLeases.length}</span></div>{observability.recentLeases.length ? <div className="observabilityTableWrap"><table className="observabilityTable historyTable"><thead><tr><th>Start</th><th>Nutzer</th><th>Connector</th><th>Worker / Lease</th><th>Dauer</th><th>Status</th><th>Ende</th></tr></thead><tbody>{observability.recentLeases.map((lease) => <tr key={lease.id}><td>{new Date(lease.startedAt).toLocaleString()}</td><td><strong>{lease.userName}</strong><br /><small>{lease.userEmail}</small></td><td>{platformLabel(lease.platform)}<br /><small>{kindLabel(lease.leaseKind)} · {lease.accountStatus}</small></td><td className="mono">{lease.workerId}<br /><small>{lease.accountId}</small></td><td>{formatWait(lease.durationSeconds)}</td><td className={lease.state === "expired" ? "metricWarning" : lease.state === "active" ? "metricGood" : ""}>{lease.state}</td><td>{lease.endedAt ? new Date(lease.endedAt).toLocaleString() : `bis ${new Date(lease.leaseUntil).toLocaleString()}`}{lease.endReason && <><br /><small>{lease.endReason}</small></>}</td></tr>)}</tbody></table></div> : <p className="adminEmpty">Noch keine historischen Connector-Leases vorhanden.</p>}</section>

      {observability.aiProcessingHistory.length > 0 && <section className="panel adminPanel"><div className="panelHead"><div><h2>Letzte 20 KI-Verarbeitungen</h2><p className="muted">Nur vorhandene KI-Jobs mit Medientyp und gemessener Laufzeit.</p></div><span className="count">{observability.aiProcessingHistory.length}</span></div><div className="observabilityTableWrap"><table className="observabilityTable historyTable"><thead><tr><th>Abgeschlossen / geändert</th><th>Medientyp</th><th>Gruppe</th><th>Modell</th><th>Versuche</th><th>Verarbeitungsdauer</th><th>Status</th></tr></thead><tbody>{observability.aiProcessingHistory.map((job) => <tr key={job.id}><td>{new Date(job.updatedAt).toLocaleString()}</td><td><strong>{job.mediaType}</strong><br /><small>{job.messageId}</small></td><td>{job.groupSubject || "—"}</td><td>{job.model || "—"}</td><td>{job.attempts}</td><td>{formatWait(job.durationSeconds)}</td><td className={job.status === "failed" ? "metricWarning" : job.status === "completed" ? "metricGood" : ""}>{job.status}{job.error && <><br /><small className="metricWarning">{job.error}</small></>}</td></tr>)}</tbody></table></div></section>}

      <div className="observabilityGrid">
        <section className="panel adminPanel"><div className="panelHead"><div><h2>NATS</h2><p className="muted">Verbindungs- und Durchsatzdaten seit dem Start des API-Prozesses.</p></div></div><div className="natsStats"><div><small>Status</small><strong className={observability.nats.connected ? "metricGood" : "metricWarning"}>{observability.nats.connected ? "Verbunden" : "Getrennt"}</strong></div><div><small>Server</small><strong>{observability.nats.servers.join(", ") || "—"}</strong></div><div><small>Eingehend</small><strong>{observability.nats.inMessages.toLocaleString()} Nachrichten</strong><span>{formatBytes(observability.nats.inBytes)}</span></div><div><small>Ausgehend</small><strong>{observability.nats.outMessages.toLocaleString()} Nachrichten</strong><span>{formatBytes(observability.nats.outBytes)}</span></div></div></section>
        <section className="panel adminPanel"><div className="panelHead"><div><h2>Datenbestand</h2><p className="muted">Weitere Kennzahlen aus PostgreSQL.</p></div></div><div className="adminBreakdown"><div><small>Gruppen nach Plattform</small><p>{summary?.groupsByPlatform.map((item) => `${platformLabel(item.label)}: ${item.count}`).join(" · ") || "—"}</p></div><div><small>Nachrichten nach Typ</small><p>{summary?.messagesByKind.map((item) => `${item.label}: ${item.count}`).join(" · ") || "—"}</p></div></div></section>
      </div>

      <section className="panel adminPanel"><div className="panelHead"><div><h2>NATS / JetStream Streams</h2><p className="muted">Streamstatus, gespeicherte Nachrichten und Zustände der dauerhaften Consumer.</p></div></div><div className="streamList">{observability.streams.map((stream) => <article className="streamCard" key={stream.name}><div className="streamHead"><div><strong>{stream.name}</strong><small>{stream.subjects.join(", ") || "keine Subjects"}</small></div><span className={stream.status === "ready" ? "streamStatus ready" : "streamStatus"}>{stream.status}</span></div>{stream.error ? <p className="streamError">{stream.error}</p> : <><div className="streamFacts"><span><small>Nachrichten</small><strong>{stream.messages.toLocaleString()}</strong></span><span><small>Speicher</small><strong>{formatBytes(stream.bytes)}</strong></span><span><small>Sequenz</small><strong>{stream.firstSequence} – {stream.lastSequence}</strong></span><span><small>Storage</small><strong>{stream.storage}</strong></span></div>{stream.consumers.length > 0 && <div className="streamConsumerList">{stream.consumers.map((consumer) => <div className="streamConsumer" key={consumer.name}><strong>{consumer.name}</strong><span>{consumer.filterSubject || "alle Subjects"}</span><span>Pending {consumer.pending} · Ack {consumer.ackPending} · Redelivered {consumer.redelivered}</span><span>Wartend {consumer.waiting} · max. {consumer.maxDeliver} Zustellungen</span></div>)}</div>}</>}</article>)}</div></section>
    </>}

    <section className="panel adminPanel"><div className="panelHead"><div><h2>Benutzerverwaltung</h2><p className="muted">Gruppen und Connectoren verwaltet jeder Nutzer selbst im persönlichen Bereich.</p></div><span className="count">{users.length}</span></div><div className="adminUserList">{users.map((user) => <div className="adminUserRow" key={user.id}><div><strong>{user.name}</strong><small>{user.email}</small></div><select value={user.roles[0] ?? "user"} onChange={(event) => void updateUser(user, { roles: [event.target.value] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="user">Nutzer</option><option value="admin">Administrator</option></select><select value={user.status} onChange={(event) => void updateUser(user, { status: event.target.value as AdminUser["status"] }).catch((value) => setError(value instanceof Error ? value.message : "Nutzer konnte nicht aktualisiert werden"))}><option value="active">Aktiv</option><option value="disabled">Deaktiviert</option></select></div>)}</div></section>
    <footer><span>Observability aktualisiert automatisch alle 5 Sekunden.</span><span>Letzter Nachrichtenstand: {summary?.lastMessageAt ? new Date(summary.lastMessageAt).toLocaleString() : "—"}</span></footer>
  </main>;
}

export default function AdminPage() {
  return <AuthGate><AdminContent /></AuthGate>;
}
