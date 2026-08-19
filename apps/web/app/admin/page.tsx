"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthGate, apiFetch, useAppLocale } from "../auth";
import { adminTranslate } from "./admin-i18n";

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
  aiProcessingHistory: Array<{ id: string; messageId: string; mediaType: string; status: string; attempts: number; model?: string; groupSubject?: string; createdAt: string; updatedAt: string; durationMilliseconds: number; durationSeconds: number; error?: string }>;
  aiProcessingPage: number;
  aiProcessingPageSize: number;
  aiProcessingTotal: number;
  aiProcessingTotalPages: number;
  hermes: {
    last24Hours: { logicalRequests: number; httpAttempts: number; remoteCandidates: number; skippedCandidates: number; errors: number };
    usage: Array<{ bucketStart: string; trigger: string; operation: string; outcome: string; candidateCount: number; logicalRequests: number; httpAttempts: number; errorCount: number }>;
  };
  nats: { connected: boolean; servers: string[]; inMessages: number; outMessages: number; inBytes: number; outBytes: number; reconnects: number };
  minio: { endpoint: string; bucket: string; connected: boolean; bucketExists: boolean; objectCount: number; totalBytes: number; lastModified?: string; error?: string; buckets: Array<{ bucket: string; connected: boolean; bucketExists: boolean; objectCount: number; totalBytes: number; lastModified?: string; error?: string }> };
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

function formatProcessingDuration(milliseconds: number) {
  if (!milliseconds || milliseconds < 1) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`;
  const totalSeconds = Math.round(milliseconds / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function platformLabel(platform: string) {
  return platform === "whatsapp" ? "WhatsApp" : platform === "telegram" ? "Telegram" : platform;
}

function kindLabel(kind: string, locale: import("../i18n").Locale = "de") {
  return kind === "processing" ? adminTranslate(locale, "processing") : kind === "onboarding" ? adminTranslate(locale, "setup") : kind;
}

function hermesOutcomeLabel(outcome: string, locale: import("../i18n").Locale) {
  if (outcome === "remote") return adminTranslate(locale, "hermesRemote");
  if (outcome === "local-gate") return adminTranslate(locale, "hermesLocalGate");
  if (outcome === "skipped") return adminTranslate(locale, "hermesSkipped");
  if (outcome === "cooldown") return adminTranslate(locale, "hermesCooldown");
  if (outcome === "failed") return adminTranslate(locale, "hermesFailed");
  return outcome;
}

function AdminContent() {
  const { locale } = useAppLocale();
  const at = (key: Parameters<typeof adminTranslate>[1], values?: Record<string, string | number>) => adminTranslate(locale, key, values);
  const [observability, setObservability] = useState<Observability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [aiPage, setAiPage] = useState(1);

  async function loadObservability(showLoading = false, page = aiPage) {
    if (showLoading) setRefreshing(true);
    try {
      const response = await apiFetch(`/api/v1/admin/observability?aiPage=${page}&aiPageSize=20`);
      if (!response.ok) throw new Error(at("loadingData"));
      const body = await response.json() as Observability;
      setObservability(body);
      if (body.aiProcessingPage && body.aiProcessingPage !== page) setAiPage(body.aiProcessingPage);
      setError(null);
    } finally {
      if (showLoading) setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadObservability(true).catch((value) => setError(value instanceof Error ? value.message : at("loadFailed")));
    const interval = window.setInterval(() => { void loadObservability().catch((value) => setError(value instanceof Error ? value.message : at("refreshing"))); }, 5000);
    return () => window.clearInterval(interval);
  }, [aiPage]);

  const summary = observability?.summary;
  const streamMessages = observability?.streams.reduce((total, stream) => total + stream.messages, 0) ?? 0;

  return <main className="shell adminPage">
    <header className="pageHeading"><div><p className="eyebrow">CONXTOR</p><h1>{at("operationsTitle")}</h1><p className="adminRefresh">{observability ? at("liveData", { time: new Date(observability.generatedAt).toLocaleTimeString(locale) }) : at("loadingData")}{refreshing && ` · ${at("refreshing")}`}</p></div></header>
    {error && <div className="notice">{error}</div>}
    <section className="panel adminPanel adminSubpageLink"><div><h2>{at("usersManagement")}</h2><p className="muted">{at("usersManagementHint")}</p></div><Link className="secondaryButton" href="/admin/users">{at("manageUsers")}</Link></section>
    <section className="panel adminPanel adminSubpageLink"><div><h2>{at("topicsManagement")}</h2><p className="muted">{at("topicsManagementHint")}</p></div><Link className="secondaryButton" href="/admin/knowledge-topics">{at("manageTopics")}</Link></section>


    {summary && <section className="adminMetricsGrid">
      <article className="panel adminMetric"><small>{at("messages")}</small><strong>{summary.messages.toLocaleString(locale)}</strong><span>{summary.recentMessages.toLocaleString(locale)} {at("recentMessages")}</span></article>
      <article className="panel adminMetric"><small>{at("users")}</small><strong>{summary.activeUsers.toLocaleString(locale)}</strong><span>{summary.adminUsers} {at("administrators")} · {summary.disabledUsers} {at("disabled")}</span></article>
      <article className="panel adminMetric"><small>{at("groups")}</small><strong>{summary.groups.toLocaleString(locale)}</strong><span>{summary.selectedGroups.toLocaleString(locale)} {at("selectedAndProcessed")}</span></article>
      <article className="panel adminMetric"><small>{at("processingFailures")}</small><strong className={summary.processingFailures ? "metricWarning" : ""}>{summary.processingFailures.toLocaleString(locale)}</strong><span>{at("openFailureEntries")}</span></article>
      <article className="panel adminMetric"><small>{at("relevantMessages")}</small><strong>{summary.relevantMessages.toLocaleString(locale)}</strong><span>{summary.messages ? `${Math.round((summary.relevantMessages / summary.messages) * 100)} %` : "0 %"} {at("allMessages")}</span></article>
      <article className="panel adminMetric"><small>{at("jetstreamEvents")}</small><strong>{streamMessages.toLocaleString(locale)}</strong><span>{observability?.streams.length ?? 0} {at("streamsMonitored")}</span></article>
      <article className="panel adminMetric"><small>{at("natsConnection")}</small><strong className={observability?.nats.connected ? "metricGood" : "metricWarning"}>{observability?.nats.connected ? at("online") : at("offline")}</strong><span>{at("serversReconnects", { servers: observability?.nats.servers.length ?? 0, reconnects: observability?.nats.reconnects ?? 0 })}</span></article>
      <article className="panel adminMetric"><small>{at("lastMessage")}</small><strong>{summary.lastMessageAt ? new Date(summary.lastMessageAt).toLocaleDateString(locale) : "—"}</strong><span>{summary.lastMessageAt ? new Date(summary.lastMessageAt).toLocaleTimeString(locale) : at("noMessageYet")}</span></article>
    </section>}

    {observability && <>
      <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("processingLoops")}</h2><p className="muted">{at("processingLoopsHint")}</p></div></div><div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>{at("loop")}</th><th>{at("total")}</th><th>{at("waiting")}</th><th>{at("active")}</th><th>{at("completed")}</th><th>{at("errors")}</th><th>{at("retry")}</th><th>{at("oldestWait")}</th></tr></thead><tbody>{observability.processingLoops.map((loop) => <tr key={loop.name}><td><strong>{loop.name}</strong></td><td>{loop.total.toLocaleString(locale)}</td><td>{loop.queued.toLocaleString(locale)}</td><td>{loop.processing.toLocaleString(locale)}</td><td>{loop.completed.toLocaleString(locale)}</td><td className={loop.failed ? "metricWarning" : ""}>{loop.failed.toLocaleString(locale)}</td><td>{loop.retry.toLocaleString(locale)}</td><td>{formatWait(loop.oldestWaitSeconds)}</td></tr>)}</tbody></table></div></section>

      <div className="observabilityGrid poolQueueGrid">
        <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("connectorPools")}</h2><p className="muted">{at("connectorPoolsHint")}</p></div></div><div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>{at("pool")}</th><th>{at("processing")}</th><th>{at("setup")}</th><th>{at("queue")}</th><th>{at("freeSlots")}</th></tr></thead><tbody>{observability.connectorPools.map((pool) => <tr key={pool.platform}><td><strong>{platformLabel(pool.platform)}</strong></td><td>{pool.activeProcessing}/{pool.processingCapacity} {at("activeLabel")}</td><td>{pool.activeOnboarding}/{pool.onboardingCapacity} {at("activeLabel")}</td><td>{pool.processingWaiting} · {formatWait(pool.processingWaitSeconds)}<br /><small>{at("setupLabel")}: {pool.onboardingWaiting} · {formatWait(pool.onboardingWaitSeconds)}</small></td><td>{pool.availableProcessing} / {pool.availableOnboarding}</td></tr>)}</tbody></table></div></section>
        <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("queues")}</h2><p className="muted">{at("queuesHint")}</p></div></div><div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>{at("connector")}</th><th>{at("type")}</th><th>{at("waiting")}</th><th>{at("active")}</th><th>{at("capacity")}</th><th>{at("waitTime")}</th></tr></thead><tbody>{observability.queues.map((queue) => <tr key={`${queue.platform}-${queue.kind}`}><td>{platformLabel(queue.platform)}</td><td>{kindLabel(queue.kind, locale)}</td><td className={queue.waiting ? "metricWarning" : ""}>{queue.waiting}</td><td>{queue.active}</td><td>{queue.capacity}</td><td>{formatWait(queue.oldestWaitSeconds)}</td></tr>)}</tbody></table></div></section>
      </div>

      <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("activeUsers")}</h2><p className="muted">{at("activeUsersHint")}</p></div><span className="count">{observability.activeLeases.length}</span></div>{observability.activeLeases.length ? <div className="observabilityTableWrap"><table className="observabilityTable"><thead><tr><th>{at("users")}</th><th>{at("connector")}</th><th>{at("type")}</th><th>Worker</th><th>Lease endet</th><th>Restzeit</th></tr></thead><tbody>{observability.activeLeases.map((lease) => <tr key={`${lease.accountId}-${lease.leaseKind}`}><td><strong>{lease.userName}</strong><br /><small>{lease.userEmail}</small></td><td>{platformLabel(lease.platform)}</td><td>{kindLabel(lease.leaseKind)}</td><td className="mono">{lease.workerId}</td><td>{new Date(lease.leaseUntil).toLocaleTimeString(locale)}</td><td>{formatWait(lease.remainingSeconds)}</td></tr>)}</tbody></table></div> : <p className="adminEmpty">{at("noActiveUsers")}</p>}</section>

      <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("recentLeases")}</h2><p className="muted">{at("recentLeasesHint")}</p></div><span className="count">{observability.recentLeases.length}</span></div>{observability.recentLeases.length ? <div className="observabilityTableWrap"><table className="observabilityTable historyTable"><thead><tr><th>{at("start")}</th><th>{at("users")}</th><th>{at("connector")}</th><th>{at("workerLease")}</th><th>{at("duration")}</th><th>{at("status")}</th><th>{at("end")}</th></tr></thead><tbody>{observability.recentLeases.map((lease) => <tr key={lease.id}><td>{new Date(lease.startedAt).toLocaleString(locale)}</td><td><strong>{lease.userName}</strong><br /><small>{lease.userEmail}</small></td><td>{platformLabel(lease.platform)}<br /><small>{kindLabel(lease.leaseKind)} · {lease.accountStatus}</small></td><td className="mono">{lease.workerId}<br /><small>{lease.accountId}</small></td><td>{formatWait(lease.durationSeconds)}</td><td className={lease.state === "expired" ? "metricWarning" : lease.state === "active" ? "metricGood" : ""}>{lease.state}</td><td>{lease.endedAt ? new Date(lease.endedAt).toLocaleString(locale) : `bis ${new Date(lease.leaseUntil).toLocaleString(locale)}`}{lease.endReason && <><br /><small>{lease.endReason}</small></>}</td></tr>)}</tbody></table></div> : <p className="adminEmpty">{at("noLeaseHistory")}</p>}</section>

      {observability.aiProcessingTotal > 0 && <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("latestAi")}</h2><p className="muted">{at("latestAiHint")}</p></div><span className="count">{observability.aiProcessingTotal.toLocaleString(locale)}</span></div><div className="observabilityTableWrap"><table className="observabilityTable historyTable"><thead><tr><th>{at("changedAt")}</th><th>{at("mediaType")}</th><th>{at("group")}</th><th>{at("model")}</th><th>{at("attempts")}</th><th>{at("processingDuration")}</th><th>{at("status")}</th></tr></thead><tbody>{observability.aiProcessingHistory.map((job) => <tr key={job.id}><td>{new Date(job.updatedAt).toLocaleString(locale)}</td><td><strong>{job.mediaType}</strong><br /><small>{job.messageId}</small></td><td>{job.groupSubject || "—"}</td><td>{job.model || "—"}</td><td>{job.attempts}</td><td>{formatProcessingDuration(job.durationMilliseconds)}</td><td className={job.status === "failed" ? "metricWarning" : job.status === "completed" ? "metricGood" : ""}>{job.status}{job.error && <><br /><small className="metricWarning">{job.error}</small></>}</td></tr>)}</tbody></table></div><div className="paginationControls"><button className="textButton" type="button" disabled={observability.aiProcessingPage <= 1} onClick={() => setAiPage((page) => Math.max(1, page - 1))}>{at("newer")}</button><span>{at("pageOf", { page: observability.aiProcessingPage, total: observability.aiProcessingTotalPages })}</span><button className="textButton" type="button" disabled={observability.aiProcessingPage >= observability.aiProcessingTotalPages} onClick={() => setAiPage((page) => Math.min(observability.aiProcessingTotalPages, page + 1))}>{at("older")}</button></div></section>}

      <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("hermesUsage")}</h2><p className="muted">{at("hermesUsageHint")}</p></div><span className="count">{observability.hermes.last24Hours.logicalRequests.toLocaleString(locale)}</span></div><div className="natsStats"><div><small>{at("hermesRequests")}</small><strong>{observability.hermes.last24Hours.logicalRequests.toLocaleString(locale)}</strong></div><div><small>{at("hermesAttempts")}</small><strong>{observability.hermes.last24Hours.httpAttempts.toLocaleString(locale)}</strong></div><div><small>{at("hermesRemoteCandidates")}</small><strong>{observability.hermes.last24Hours.remoteCandidates.toLocaleString(locale)}</strong></div><div><small>{at("hermesSkippedCandidates")}</small><strong>{observability.hermes.last24Hours.skippedCandidates.toLocaleString(locale)}</strong></div><div><small>{at("hermesErrors")}</small><strong className={observability.hermes.last24Hours.errors ? "metricWarning" : "metricGood"}>{observability.hermes.last24Hours.errors.toLocaleString(locale)}</strong></div></div>{observability.hermes.usage.length ? <div className="observabilityTableWrap"><table className="observabilityTable historyTable"><thead><tr><th>{at("changedAt")}</th><th>{at("hermesTrigger")}</th><th>{at("hermesOperation")}</th><th>{at("hermesOutcome")}</th><th>{at("hermesCandidates")}</th><th>{at("hermesRequests")}</th><th>{at("hermesAttempts")}</th></tr></thead><tbody>{observability.hermes.usage.map((item) => <tr key={`${item.bucketStart}-${item.trigger}-${item.operation}-${item.outcome}`}><td>{new Date(item.bucketStart).toLocaleString(locale)}</td><td className="mono">{item.trigger}</td><td>{item.operation}</td><td className={item.outcome === "failed" ? "metricWarning" : item.outcome === "remote" ? "metricGood" : ""}>{hermesOutcomeLabel(item.outcome, locale)}</td><td>{item.candidateCount.toLocaleString(locale)}</td><td>{item.logicalRequests.toLocaleString(locale)}</td><td>{item.httpAttempts.toLocaleString(locale)}</td></tr>)}</tbody></table></div> : <p className="adminEmpty">{at("hermesNoUsage")}</p>}</section>

      <div className="observabilityGrid">
        <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("nats")}</h2><p className="muted">{at("natsHint")}</p></div></div><div className="natsStats"><div><small>{at("status")}</small><strong className={observability.nats.connected ? "metricGood" : "metricWarning"}>{observability.nats.connected ? at("connected") : at("disconnected")}</strong></div><div><small>{at("server")}</small><strong>{observability.nats.servers.join(", ") || "—"}</strong></div><div><small>{at("incoming")}</small><strong>{observability.nats.inMessages.toLocaleString(locale)} {at("messagesUnit")}</strong><span>{formatBytes(observability.nats.inBytes)}</span></div><div><small>{at("outgoing")}</small><strong>{observability.nats.outMessages.toLocaleString(locale)} {at("messagesUnit")}</strong><span>{formatBytes(observability.nats.outBytes)}</span></div></div></section>
        <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("databaseInventory")}</h2><p className="muted">{at("databaseHint")}</p></div></div><div className="adminBreakdown"><div><small>{at("groupsByPlatform")}</small><p>{summary?.groupsByPlatform.map((item) => `${platformLabel(item.label)}: ${item.count}`).join(" · ") || "—"}</p></div><div><small>{at("messagesByType")}</small><p>{summary?.messagesByKind.map((item) => `${item.label}: ${item.count}`).join(" · ") || "—"}</p></div></div></section>
      </div>

      <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("minio")}</h2><p className="muted">{at("minioHint")}</p></div><span className={observability.minio.connected ? "streamStatus ready" : "streamStatus"}>{observability.minio.connected ? at("reachable") : at("notReachable")}</span></div><div className="natsStats"><div><small>{at("status")}</small><strong className={observability.minio.connected ? "metricGood" : "metricWarning"}>{observability.minio.connected ? at("connected") : at("notReachable")}</strong><span>{observability.minio.bucketExists ? at("bucketReachable") : at("bucketNotConfirmed")}</span></div><div><small>{at("bucketEndpoint")}</small><strong>{observability.minio.bucket || "—"}</strong><span>{observability.minio.endpoint || "—"}</span></div><div><small>{at("totalObjects")}</small><strong>{observability.minio.objectCount.toLocaleString(locale)}</strong><span>{at("storedMedia")}</span></div><div><small>{at("totalStorage")}</small><strong>{formatBytes(observability.minio.totalBytes)}</strong><span>{observability.minio.lastModified ? at("lastObject", { time: new Date(observability.minio.lastModified).toLocaleString(locale) }) : at("noObject")}</span></div></div><div className="minioBucketList"><div className="minioBucketHeader"><strong>{at("mediaBuckets")}</strong><span>{at("bucketsCount", { count: observability.minio.buckets.length })}</span></div>{observability.minio.buckets.map((bucket) => <div className="minioBucketRow" key={bucket.bucket}><div className="minioBucketName"><strong>{bucket.bucket}</strong><small>{bucket.error || (bucket.bucketExists ? at("bucketReachable") : at("bucketNotConfirmed"))}</small></div><span>{bucket.objectCount.toLocaleString(locale)} {at("objects")}</span><span>{formatBytes(bucket.totalBytes)}</span><span>{bucket.lastModified ? new Date(bucket.lastModified).toLocaleString(locale) : "—"}</span></div>)}</div>{observability.minio.error && <p className="streamError" style={{ margin: "0 19px 18px" }}>{observability.minio.error}</p>}</section>

      <section className="panel adminPanel"><div className="panelHead"><div><h2>{at("streams")}</h2><p className="muted">{at("streamsHint")}</p></div></div><div className="streamList">{observability.streams.map((stream) => <article className="streamCard" key={stream.name}><div className="streamHead"><div><strong>{stream.name}</strong><small>{stream.subjects.join(", ") || at("noSubjects")}</small></div><span className={stream.status === "ready" ? "streamStatus ready" : "streamStatus"}>{stream.status}</span></div>{stream.error ? <p className="streamError">{stream.error}</p> : <><div className="streamFacts"><span><small>{at("messages")}</small><strong>{stream.messages.toLocaleString(locale)}</strong></span><span><small>{at("storage")}</small><strong>{formatBytes(stream.bytes)}</strong></span><span><small>{at("sequence")}</small><strong>{stream.firstSequence} – {stream.lastSequence}</strong></span><span><small>Storage</small><strong>{stream.storage}</strong></span></div>{stream.consumers.length > 0 && <div className="streamConsumerList">{stream.consumers.map((consumer) => <div className="streamConsumer" key={consumer.name}><strong>{consumer.name}</strong><span>{consumer.filterSubject || at("noSubjects")}</span><span>{at("pending")} {consumer.pending} · {at("ackPending")} {consumer.ackPending} · {at("redelivered")} {consumer.redelivered}</span><span>{at("waiting") } {consumer.waiting} · {at("maxDeliveries")} {consumer.maxDeliver}</span></div>)}</div>}</>}</article>)}</div></section>
    </>}

    <footer><span>Observability aktualisiert automatisch alle 5 Sekunden.</span><span>{at("lastMessage")}: {summary?.lastMessageAt ? new Date(summary.lastMessageAt).toLocaleString(locale) : "—"}</span></footer>
  </main>;
}

export default function AdminPage() {
  return <AuthGate><AdminContent /></AuthGate>;
}
