import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  proto,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { connect, StorageType, StringCodec, type JetStreamClient, type NatsConnection } from "nats";
import { Pool } from "pg";
import pino from "pino";
import { subjects, type EventEnvelope, type GroupDiscovered, type GroupSelectionChanged, type WhatsAppMessageReceived } from "@wagi/contracts";
import { acquireConnectorAccount, claimConnectorOnboardingRequest, type ConnectorAccountLease, type ConnectorSQLStore, type ConnectorOnboardingRequest } from "@wagi/connector-sdk";

const port = Number(process.env.PORT ?? 3001);
const databaseUrl = process.env.DATABASE_URL ?? "postgres://wagi_app:app@localhost:5432/app";
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
const authDir = process.env.WA_AUTH_DIR ?? "./data/wa-auth";
const mediaDir = process.env.MEDIA_DIR ?? "./data/media";
const syncHistory = (process.env.WA_SYNC_HISTORY ?? "false").toLowerCase() === "true";
const backfillDays = Math.max(1, Number(process.env.WA_BACKFILL_DAYS ?? 7));
const backfillThrottleMs = Math.max(0, Number(process.env.WA_BACKFILL_THROTTLE_MS ?? 250));
const backfillGroupDelayMs = Math.max(0, Number(process.env.WA_BACKFILL_GROUP_DELAY_MS ?? 1500));
const mediaDownloadTimeoutMs = Math.max(10_000, Number(process.env.WA_MEDIA_DOWNLOAD_TIMEOUT_MS ?? 30_000));
const mediaDownloadAttempts = Math.max(1, Number(process.env.WA_MEDIA_DOWNLOAD_ATTEMPTS ?? 3));
const mockMode = (process.env.WA_MOCK_MODE ?? "false").toLowerCase() === "true";
const groupRefreshIntervalMs = Math.max(30_000, Number(process.env.GROUP_REFRESH_INTERVAL_MS ?? 60_000));
const mediaCleanupToken = (process.env.MEDIA_CLEANUP_TOKEN ?? "").trim();
const allowlist = new Set((process.env.WA_GROUP_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const poolEnabled = (process.env.CONNECTOR_POOL_ENABLED ?? "false").toLowerCase() === "true";
const poolWorkerId = (process.env.CONNECTOR_WORKER_ID ?? "").trim() || `wa-${process.env.HOSTNAME ?? process.pid}`;
const poolLeaseSeconds = Math.max(30, Number(process.env.CONNECTOR_LEASE_SECONDS ?? 90));
const poolSlotSeconds = Math.max(0, Number(process.env.CONNECTOR_ACCOUNT_SLOT_SECONDS ?? 1800));
const connectorStartDelayMs = Math.max(0, Number(process.env.CONNECTOR_START_DELAY_MS ?? 0));
const poolRetryDelayMs = Math.max(5_000, Number(process.env.CONNECTOR_POOL_RETRY_DELAY_MS ?? 10_000));
const connectorRole = (process.env.CONNECTOR_ROLE ?? "processing").trim().toLowerCase();
const onboardingOnly = poolEnabled && connectorRole === "onboarding" && !mockMode;
const connectorPoolSize = Math.max(1, Number(process.env.WA_CONNECTOR_POOL_SIZE ?? process.env.CONNECTOR_POOL_SIZE ?? 1));
const connectorOnboardingSlots = Math.max(1, Number(process.env.WA_ONBOARDING_SLOTS ?? process.env.CONNECTOR_ONBOARDING_SLOTS ?? 1));
const connectorSyncIntervalSeconds = Math.max(30, Number(process.env.CONNECTOR_SYNC_INTERVAL_SECONDS ?? 300));
const historyPageSize = Math.min(50, Math.max(1, Number(process.env.WA_HISTORY_PAGE_SIZE ?? 50)));
const historyMaxPages = Math.max(1, Number(process.env.WA_HISTORY_MAX_PAGES ?? 20));
const historyWaitMs = Math.max(5_000, Number(process.env.WA_HISTORY_WAIT_MS ?? 20_000));

const pool = new Pool({ connectionString: databaseUrl });
const sc = StringCodec();
let nc: NatsConnection;
let js: JetStreamClient;
let latestQr: string | null = null;
let connected = false;
let lifecycleStatus: "starting" | "pairing" | "connecting" | "syncing" | "ready" | "degraded" | "error" | "reauth_required" | "stopped" = "starting";
let lastError: string | null = null;
let connectedAt: string | null = null;
let initialActivation = false;
let backfillCutoff = new Date(0);
const downloadLogger = pino({ level: "silent" });
let waSocket: ReturnType<typeof makeWASocket> | null = null;
const pendingHistory = new Map<string, WAMessage[]>();
const historyWaiters = new Map<string, Array<(messageCount: number) => void>>();
let authSnapshotWrite: Promise<void> = Promise.resolve();
type WhatsAppParticipant = { id?: string; lid?: string; jid?: string; name?: string; notify?: string; verifiedName?: string };
type WhatsAppSenderIdentity = { senderJid: string; senderName?: string };
const senderIdentityCache = new Map<string, { identity: WhatsAppSenderIdentity; expiresAt: number }>();
let groupRefreshTimer: NodeJS.Timeout | null = null;
let groupRefreshInProgress = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let connectInProgress = false;
let accountLease: ConnectorAccountLease | null = null;
let accountRotationTimer: NodeJS.Timeout | null = null;
let onboardingRequest: ConnectorOnboardingRequest | null = null;
let onboardingPollTimer: NodeJS.Timeout | null = null;
let processingPollTimer: NodeJS.Timeout | null = null;
let processingAcquireInProgress = false;
let onboardingAcquireInProgress = false;
let processingCycleFinished = false;
let authSnapshotTimer: NodeJS.Timeout | null = null;
let authSnapshotTimerDirectory: string | null = null;
let authSnapshotTimerAccountId: string | null = null;
const sqlStore = pool as unknown as ConnectorSQLStore;

async function stopAfterLeaseLoss(expectedLease: ConnectorAccountLease, error: unknown) {
  if (accountLease !== expectedLease) return;
  const accountId = expectedLease.account.accountId;
  connected = false;
  lifecycleStatus = "stopped";
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (accountRotationTimer) clearTimeout(accountRotationTimer);
  accountRotationTimer = null;
  try { (waSocket as any)?.end?.(); } catch { /* best effort */ }
  waSocket = null;
  await flushAuthSnapshot(join(authDir, accountId), accountId).catch((snapshotError) => console.warn("WhatsApp session snapshot after lease loss failed", snapshotError));
  accountLease = null;
  await expectedLease.release().catch((releaseError) => console.warn("WhatsApp lease release after loss failed", releaseError));
  console.warn("WhatsApp worker stopped after losing its account lease", error);
}

async function initializePoolLease() {
  if (!poolEnabled || mockMode) return true;
  const preferredAccountId = (process.env.CONNECTOR_ACCOUNT_ID ?? "").trim() || undefined;
  const lease = await acquireConnectorAccount(sqlStore, "whatsapp", poolWorkerId, preferredAccountId, poolLeaseSeconds, {
    leaseKind: "processing",
    poolSize: connectorPoolSize,
    onboardingSlots: connectorOnboardingSlots,
  });
  if (!lease) {
    await setStatus("degraded", "Kein freies WhatsApp-Connector-Konto; Worker wartet auf eine Lease");
    return false;
  }
  accountLease = lease;
  lease.startRenewal((error) => void stopAfterLeaseLoss(lease, error));
  if (poolSlotSeconds > 0) {
    if (accountRotationTimer) clearTimeout(accountRotationTimer);
    accountRotationTimer = setTimeout(() => void rotatePoolAccount(), poolSlotSeconds * 1000);
    accountRotationTimer.unref?.();
  }
  await lease.setStatus("connecting");
  processingCycleFinished = false;
  console.log(`WhatsApp worker ${poolWorkerId} leased account ${accountLease.account.accountId} for ${accountLease.account.label}`);
  return true;
}

async function initializeOnboardingLease() {
  if (!onboardingOnly || accountLease) return false;
  const request = await claimConnectorOnboardingRequest(sqlStore, "whatsapp", poolWorkerId);
  if (!request) return false;
  const lease = await acquireConnectorAccount(sqlStore, "whatsapp", poolWorkerId, request.accountId, poolLeaseSeconds, {
    leaseKind: "onboarding",
    poolSize: connectorPoolSize,
    onboardingSlots: connectorOnboardingSlots,
  });
  if (!lease) {
    await pool.query("UPDATE connector_onboarding_requests SET status='pending', worker_id=NULL, updated_at=NOW() WHERE id=$1::uuid", [request.id]);
    return false;
  }
  onboardingRequest = request;
  accountLease = lease;
  // A QR start is an explicit re-pair request. Remove only this account's
  // local auth snapshot so an expired session cannot suppress the QR event.
  await rm(join(authDir, request.accountId), { recursive: true, force: true });
  await accountLease.saveSession(Buffer.from("{}", "utf8"));
  lease.startRenewal((error) => {
    if (accountLease === lease) void finishOnboarding("failed", error);
  });
  await accountLease.updateOnboardingRequest("claimed", null, request.id);
  await accountLease.setStatus("pairing");
  console.log(`WhatsApp onboarding worker ${poolWorkerId} handles account ${request.accountId}`);
  return true;
}

async function finishOnboarding(status = "completed", error?: unknown) {
  const lease = accountLease;
  const request = onboardingRequest;
  if (!lease || !request) return;
  const message = error ? String(error) : null;
  const ownership = await pool.query<{ status: string }>(
    "SELECT status FROM connector_onboarding_requests WHERE id=$1::uuid AND worker_id=$2 AND status IN ('claimed','connected')",
    [request.id, poolWorkerId],
  );
  if (ownership.rows.length) {
    await lease.updateQR({ status: error ? "failed" : status, qrPayload: null, expiresAt: null, error: message });
    await lease.updateOnboardingRequest(error ? "failed" : status, message, request.id);
  }
  if (ownership.rows.length && !error) {
    await lease.setStatus("paused");
    // A newly paired account must be eligible for the next processing-pool
    // cycle immediately. Without this, a NULL/old next_sync_at can leave the
    // account paired successfully but silent in the message pipeline.
    await pool.query("UPDATE connector_accounts SET next_sync_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=$1::uuid", [lease.account.accountId]);
  }
  try { (waSocket as any)?.end?.(); } catch { /* best effort */ }
  waSocket = null;
  await flushAuthSnapshot(join(authDir, lease.account.accountId), lease.account.accountId).catch((snapshotError) => console.warn("WhatsApp onboarding session snapshot failed", snapshotError));
  accountLease = null;
  onboardingRequest = null;
  connected = false;
  lifecycleStatus = "stopped";
  latestQr = null;
  await lease.release().catch((releaseError) => console.warn("WhatsApp onboarding lease release failed", releaseError));
}

function startOnboardingPoller() {
  if (!onboardingOnly || onboardingPollTimer) return;
  const poll = () => {
    if (accountLease || onboardingAcquireInProgress) return;
    onboardingAcquireInProgress = true;
    void initializeOnboardingLease().then((claimed) => {
      if (claimed) return connectWhatsApp();
    }).catch((error) => console.warn("WhatsApp onboarding poll failed", error))
      .finally(() => { onboardingAcquireInProgress = false; });
  };
  onboardingPollTimer = setInterval(poll, Math.min(poolRetryDelayMs, 2_000));
  onboardingPollTimer.unref?.();
  poll();
}

function startProcessingPoller() {
  if (!poolEnabled || onboardingOnly || processingPollTimer) return;
  processingPollTimer = setInterval(() => {
    if (accountLease || connectInProgress || processingAcquireInProgress || lifecycleStatus === "pairing" || lifecycleStatus === "connecting" || lifecycleStatus === "syncing") return;
    processingAcquireInProgress = true;
    void initializePoolLease().then((ready) => {
      if (ready) return connectWhatsApp().catch((error) => scheduleWhatsAppReconnect(error));
      return undefined;
    }).catch((error) => console.warn("WhatsApp processing pool poll failed", error))
      .finally(() => { processingAcquireInProgress = false; });
  }, poolRetryDelayMs);
  processingPollTimer.unref?.();
}

async function rotatePoolAccount() {
  if (!poolEnabled || !accountLease || mockMode) return;
  const previousLease = accountLease;
  const accountId = previousLease.account.accountId;
  accountRotationTimer = null;
  lifecycleStatus = "stopped";
  connected = false;
  try { (waSocket as any)?.end?.(); } catch (error) { console.warn("WhatsApp socket rotation close failed", error); }
  waSocket = null;
  await flushAuthSnapshot(join(authDir, accountId), accountId).catch((snapshotError) => console.warn("WhatsApp rotated session snapshot failed", snapshotError));
  accountLease = null;
  await previousLease.setStatus("paused", null).catch(() => undefined);
  await previousLease.release().catch((error) => console.warn("WhatsApp account lease release failed", error));
  try {
    if (await initializePoolLease()) await connectWhatsApp();
  } catch (error) {
    console.warn("WhatsApp account rotation failed", error);
  }
}

async function finishProcessingCycle() {
  if (!poolEnabled || onboardingOnly || !accountLease || processingCycleFinished) return;
  processingCycleFinished = true;
  const lease = accountLease;
  lifecycleStatus = "stopped";
  connected = false;
  if (accountRotationTimer) clearTimeout(accountRotationTimer);
  accountRotationTimer = null;
  try { (waSocket as any)?.end?.(); } catch { /* best effort */ }
  waSocket = null;
  await flushAuthSnapshot(join(authDir, lease.account.accountId), lease.account.accountId).catch((snapshotError) => console.warn("WhatsApp processing session snapshot failed", snapshotError));
  await lease.completeSync(new Date(Date.now() + connectorSyncIntervalSeconds * 1000)).catch((error) => console.warn("WhatsApp sync completion persistence failed", error));
  accountLease = null;
  await lease.release().catch((error) => console.warn("WhatsApp processing lease release failed", error));
  console.log(`WhatsApp worker ${poolWorkerId} released account ${lease.account.accountId} after sync`);
}

async function restoreAuthSnapshot(directory: string) {
  if (!accountLease) return;
  // Pool workers share the named auth volume. If it already contains valid
  // credentials, keep its newest Signal files; the PostgreSQL copy is the
  // fallback for a fresh worker or a fresh volume.
  try {
    const localCredentials = JSON.parse((await readFile(join(directory, "creds.json"))).toString("utf8")) as Record<string, unknown>;
    if (localCredentials && typeof localCredentials === "object") return;
  } catch {
    // No usable local credentials; restore the durable PostgreSQL snapshot.
  }
  const snapshot = await accountLease.loadSession();
  if (!snapshot) return;
  const files = JSON.parse(snapshot.toString("utf8")) as Record<string, string>;
  await mkdir(directory, { recursive: true });
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), Buffer.from(value, "base64"));
}

async function persistAuthSnapshot(directory: string, expectedAccountId?: string) {
  const lease = accountLease;
  if (!lease || (expectedAccountId && lease.account.accountId !== expectedAccountId)) return;
  authSnapshotWrite = authSnapshotWrite.catch(() => undefined).then(async () => {
    const snapshot: Record<string, string> = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      try {
        const contents = await readFile(join(directory, entry.name));
        // Do not publish a file while Baileys is replacing it. A truncated
        // Signal JSON file would otherwise become a durable Bad-MAC snapshot.
        JSON.parse(contents.toString("utf8"));
        snapshot[entry.name] = contents.toString("base64");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (accountLease?.account.accountId !== lease.account.accountId) return;
    await lease.saveSession(Buffer.from(JSON.stringify(snapshot), "utf8"));
  });
  await authSnapshotWrite;
}

function scheduleAuthSnapshotPersist(directory: string, accountId: string) {
  if (authSnapshotTimer) clearTimeout(authSnapshotTimer);
  authSnapshotTimerDirectory = directory;
  authSnapshotTimerAccountId = accountId;
  authSnapshotTimer = setTimeout(() => {
    authSnapshotTimer = null;
    const targetDirectory = authSnapshotTimerDirectory;
    const targetAccountId = authSnapshotTimerAccountId;
    authSnapshotTimerDirectory = null;
    authSnapshotTimerAccountId = null;
    if (targetDirectory && targetAccountId) {
      void persistAuthSnapshot(targetDirectory, targetAccountId).catch((error) => console.warn("WhatsApp scheduled session snapshot failed", error));
    }
  }, 1_500);
  authSnapshotTimer.unref?.();
}

async function flushAuthSnapshot(directory: string, accountId: string) {
  if (authSnapshotTimer) clearTimeout(authSnapshotTimer);
  authSnapshotTimer = null;
  authSnapshotTimerDirectory = null;
  authSnapshotTimerAccountId = null;
  await persistAuthSnapshot(directory, accountId);
}

async function prepareInitialActivation() {
  const existing = await pool.query<{ initial_backfill_completed_at: string | null }>(
    "SELECT initial_backfill_completed_at FROM connector_states WHERE connector='whatsapp'",
  );
  initialActivation = !existing.rows[0] || !existing.rows[0].initial_backfill_completed_at;
  backfillCutoff = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000);
  if (initialActivation) {
    await pool.query(
      `INSERT INTO connector_states (connector, status, first_activated_at, initial_backfill_started_at, initial_backfill_days)
       VALUES ('whatsapp', 'starting', NOW(), NOW(), $1)
       ON CONFLICT (connector) DO UPDATE SET initial_backfill_started_at=COALESCE(connector_states.initial_backfill_started_at, NOW()), initial_backfill_days=$1, updated_at=NOW()`,
      [backfillDays],
    );
  }
}

async function completeInitialActivation() {
  if (!initialActivation) return;
  await pool.query("UPDATE connector_states SET initial_backfill_completed_at=NOW(), updated_at=NOW() WHERE connector='whatsapp'");
  initialActivation = false;
}

function backfillDelay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function waitForWhatsAppHistory(groupId: string) {
  let timer: NodeJS.Timeout | undefined;
  let resolvePromise: ((messageCount: number) => void) | undefined;
  const waiter = (messageCount: number) => {
    if (timer) clearTimeout(timer);
    resolvePromise?.(messageCount);
  };
  const promise = new Promise<number>((resolve) => {
    resolvePromise = resolve;
    const waiters = historyWaiters.get(groupId) ?? [];
    waiters.push(waiter);
    historyWaiters.set(groupId, waiters);
    timer = setTimeout(() => {
      const current = historyWaiters.get(groupId) ?? [];
      historyWaiters.set(groupId, current.filter((candidate) => candidate !== waiter));
      resolve(0);
    }, historyWaitMs);
  });
  return promise;
}

function notifyWhatsAppHistory(groupId: string, messageCount: number) {
  const waiters = historyWaiters.get(groupId);
  if (!waiters?.length) return;
  historyWaiters.delete(groupId);
  for (const waiter of waiters) waiter(messageCount);
}

async function setStatus(status: typeof lifecycleStatus, detail?: string, error?: unknown) {
  lifecycleStatus = status;
  lastError = error ? String(error) : (status === "error" || status === "reauth_required" ? lastError : null);
  if (accountLease) await accountLease.setStatus(status, lastError).catch((dbError) => console.warn("connector account status persistence failed", dbError));
  await pool.query(
    `INSERT INTO connector_states (connector, status, detail, last_error, qr, connected_at)
     VALUES ('whatsapp', $1, $2, $3, $4, $5)
     ON CONFLICT (connector) DO UPDATE SET status=EXCLUDED.status, detail=EXCLUDED.detail,
       last_error=EXCLUDED.last_error, qr=EXCLUDED.qr, connected_at=EXCLUDED.connected_at, updated_at=NOW()`,
    [status, detail ?? null, lastError, latestQr, connectedAt],
  ).catch((dbError) => console.warn("connector status persistence failed", dbError));
  if (js) await publish(subjects.connectorStatus, subjects.connectorStatus, { connector: "whatsapp", status, detail, lastError: lastError ?? undefined, qr: latestQr ?? undefined, connectedAt: connectedAt ?? undefined });
}

function envelope<T>(type: EventEnvelope<T>["type"], data: T): EventEnvelope<T> {
  return { id: randomUUID(), type, occurredAt: new Date().toISOString(), source: "wa-connector", data };
}

async function publish<T>(subject: string, type: EventEnvelope<T>["type"], data: T) {
  await js.publish(subject, sc.encode(JSON.stringify(envelope(type, data))));
}

async function cleanupRemovedGroups(platform: "whatsapp" | "telegram", groupIds: string[]) {
  const uniqueIds = [...new Set(groupIds.filter(Boolean))];
  if (!uniqueIds.length) return;
  if (!mediaCleanupToken) throw new Error("MEDIA_CLEANUP_TOKEN fehlt; Gruppenbereinigung wird abgebrochen");
  const response = await nc.request(
    "internal.groups.cleanup.requested",
    sc.encode(JSON.stringify({ token: mediaCleanupToken, platform, groupIds: uniqueIds })),
    { timeout: 30_000 },
  );
  const result = JSON.parse(sc.decode(response.data)) as { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(result.error ?? "Medienbereinigung fehlgeschlagen");
  const ownerUserId = accountLease?.account.userId;
  if (ownerUserId) {
    await pool.query("DELETE FROM user_group_access WHERE user_id=$1::uuid AND group_id=ANY($2::text[])", [ownerUserId, uniqueIds]);
    await pool.query("DELETE FROM wa_groups g WHERE g.platform=$1 AND g.id=ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.group_id=g.id)", [platform, uniqueIds]);
  } else {
    await pool.query("DELETE FROM wa_groups WHERE platform=$1 AND id=ANY($2::text[])", [platform, uniqueIds]);
  }
  console.log(`Removed ${uniqueIds.length} departed ${platform} group(s) and related data`);
}

async function ensureEventStream() {
  js = nc.jetstream();
  const manager = await nc.jetstreamManager();
  try {
    const stream = await manager.streams.info("WAGI_EVENTS");
    if (!(stream.config.subjects ?? []).includes("connector.>")) {
      await manager.streams.update(stream.config.name, { ...stream.config, subjects: [...(stream.config.subjects ?? []), "connector.>"] });
    }
  } catch {
    try {
      await manager.streams.add({ name: "WAGI_EVENTS", subjects: ["wa.>", "media.>", "ai.>", "connector.>"], storage: StorageType.File, max_msgs: -1 });
    } catch (error) {
      await manager.streams.info("WAGI_EVENTS").catch(() => { throw error; });
    }
  }
}

async function upsertGroup(group: GroupDiscovered) {
	const subject = group.subject?.trim() || group.groupId;
	const ownerUserId = accountLease?.account.userId ?? null;
	await pool.query(
		`INSERT INTO wa_groups (id, subject, owner_jid, participant_count, is_selected, platform, chat_type, external_chat_id, owner_user_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $1, $8)
		 ON CONFLICT (id) DO UPDATE SET subject = CASE WHEN EXCLUDED.subject = EXCLUDED.id THEN wa_groups.subject ELSE EXCLUDED.subject END, owner_jid = EXCLUDED.owner_jid,
		   participant_count = EXCLUDED.participant_count, platform = EXCLUDED.platform, chat_type = EXCLUDED.chat_type,
		   external_chat_id = EXCLUDED.external_chat_id, owner_user_id = COALESCE(wa_groups.owner_user_id, EXCLUDED.owner_user_id), updated_at = NOW()`,
		[group.groupId, subject, group.ownerJid ?? null, group.participantCount ?? 0, group.isSelected, group.platform ?? "whatsapp", group.chatType ?? "group", ownerUserId],
	);
	if (ownerUserId) {
		await pool.query(`INSERT INTO user_group_access (user_id, group_id, can_read, can_manage, is_selected)
			VALUES ($1::uuid,$2,TRUE,TRUE,$3) ON CONFLICT (user_id,group_id) DO NOTHING`, [ownerUserId, group.groupId, group.isSelected]);
	}
	const result = await pool.query<{ is_selected: boolean }>(`SELECT COALESCE(uga.is_selected,g.is_selected) AS is_selected
		FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, [group.groupId, ownerUserId]);
	await publish(subjects.groupDiscovered, subjects.groupDiscovered, { ...group, subject, isSelected: result.rows[0]?.is_selected ?? group.isSelected });
}

function isPlaceholderGroupSubject(groupId: string, subject?: string | null) {
	const normalized = subject?.trim();
	return !normalized || normalized === groupId;
}

async function refreshGroupName(socket: ReturnType<typeof makeWASocket>, groupId: string, currentSubject?: string | null) {
	if (!isPlaceholderGroupSubject(groupId, currentSubject)) return;
	try {
		const metadata = await socket.groupMetadata(groupId);
		const subject = metadata.subject?.trim();
		if (!subject || isPlaceholderGroupSubject(groupId, subject)) return;
		await pool.query(
			`UPDATE wa_groups SET subject=$1, participant_count=CASE WHEN $2 > 0 THEN $2 ELSE participant_count END, updated_at=NOW()
			 WHERE id=$3 AND platform='whatsapp'`,
			[subject, metadata.participants?.length ?? 0, groupId],
		);
	} catch {
		// Some groups can temporarily be unavailable during reconnect/history sync.
	}
}

async function refreshPlaceholderGroupNames(socket: ReturnType<typeof makeWASocket>) {
	const rows = await pool.query<{ id: string; subject: string }>(
		"SELECT id, subject FROM wa_groups WHERE platform='whatsapp' AND (subject IS NULL OR subject = id) ORDER BY id",
	);
	for (const row of rows.rows) {
		await refreshGroupName(socket, row.id, row.subject);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

async function refreshAllWhatsAppGroupNames(socket: ReturnType<typeof makeWASocket>) {
  if (groupRefreshInProgress) return;
  groupRefreshInProgress = true;
  try {
    const participating = await socket.groupFetchAllParticipating();
    const presentIds = Object.keys(participating).filter((groupId) => groupId.endsWith("@g.us"));
    for (const [groupId, metadata] of Object.entries(participating)) {
      if (!groupId.endsWith("@g.us")) continue;
      if (metadata.participants?.length) await persistWhatsAppContacts(metadata.participants as WhatsAppParticipant[]);
      const subject = metadata.subject?.trim();
      await upsertGroup({ groupId, subject: subject || groupId, participantCount: metadata.participants?.length ?? 0, isSelected: allowlistedGroup(groupId), platform: "whatsapp", chatType: "group" });
    }
		await repairStoredWhatsAppSenderNames();
		const stored = await pool.query<{ id: string }>("SELECT id FROM wa_groups WHERE platform='whatsapp' AND ($1::uuid IS NULL OR owner_user_id=$1::uuid)", [accountLease?.account.userId ?? null]);
    const stale = stored.rows.map((row) => row.id).filter((id) => !presentIds.includes(id));
    await cleanupRemovedGroups("whatsapp", stale);
  } catch {
    await refreshPlaceholderGroupNames(socket);
  } finally {
    groupRefreshInProgress = false;
  }
}

function startGroupRefreshTimer() {
  if (groupRefreshTimer) return;
  groupRefreshTimer = setInterval(() => {
    if (connected && waSocket) void refreshAllWhatsAppGroupNames(waSocket);
  }, groupRefreshIntervalMs);
  groupRefreshTimer.unref?.();
}

function allowlistedGroup(groupId: string) {
  return allowlist.has(groupId);
}

function messageKind(message: WAMessage): WhatsAppMessageReceived["kind"] {
  const content = message.message ?? {};
  if (content.conversation || content.extendedTextMessage) return "text";
  if (content.audioMessage) return "audio";
  if (content.imageMessage) return "image";
  if (content.videoMessage) return "video";
  if (content.documentMessage) return "document";
  if (content.locationMessage) return "location";
  return "system";
}

function messageText(message: WAMessage): string | undefined {
  const content = message.message;
  if (content?.locationMessage) {
    const location = content.locationMessage;
    return [location.name, location.address].filter(Boolean).join(" — ") || "Geteilter Ort";
  }
  return content?.conversation ?? content?.extendedTextMessage?.text ?? content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? undefined;
}

function replyToWaMessageId(message: WAMessage): string | undefined {
  const content = message.message;
  return content?.extendedTextMessage?.contextInfo?.stanzaId
    ?? content?.imageMessage?.contextInfo?.stanzaId
    ?? content?.audioMessage?.contextInfo?.stanzaId
    ?? content?.videoMessage?.contextInfo?.stanzaId
    ?? undefined;
}

function mediaMimeFor(message: WAMessage, kind: WhatsAppMessageReceived["kind"]) {
  if (kind === "audio") return message.message?.audioMessage?.mimetype ?? undefined;
  if (kind === "image") return message.message?.imageMessage?.mimetype ?? undefined;
  if (kind === "video") return message.message?.videoMessage?.mimetype ?? undefined;
  if (kind === "document") return message.message?.documentMessage?.mimetype ?? undefined;
  return undefined;
}

async function withTimeout<T>(operation: Promise<T>, milliseconds: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`WhatsApp media download timeout after ${milliseconds} ms`)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function downloadWhatsAppMedia(message: WAMessage, socket: ReturnType<typeof makeWASocket>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= mediaDownloadAttempts; attempt += 1) {
    try {
      return await withTimeout(
        downloadMediaMessage(message, "buffer", {}, {
          logger: downloadLogger,
          reuploadRequest: async (sourceMessage) => socket.updateMediaMessage(sourceMessage),
        }),
        mediaDownloadTimeoutMs,
      );
    } catch (error) {
      lastError = error;
      console.warn(`WhatsApp media download attempt ${attempt}/${mediaDownloadAttempts} failed`, message.key.id, error);
      if (attempt < mediaDownloadAttempts) await backfillDelay(1_000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function persistWhatsAppContacts(contacts: WhatsAppParticipant[]) {
  const accountId = accountLease?.account.accountId;
  if (!accountId) return;
  for (const contact of contacts) {
    const identityJid = contact.lid?.trim() || contact.id?.trim() || contact.jid?.trim();
    if (!identityJid) continue;
    const phoneJid = contact.jid?.trim() || (contact.id?.endsWith("@s.whatsapp.net") ? contact.id.trim() : null);
    await pool.query(
      `INSERT INTO whatsapp_contacts (account_id,identity_jid,phone_jid,display_name,notify_name,verified_name)
       VALUES ($1::uuid,$2,$3,$4,$5,$6)
       ON CONFLICT (account_id,identity_jid) DO UPDATE SET
         phone_jid=COALESCE(EXCLUDED.phone_jid,whatsapp_contacts.phone_jid),
         display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),whatsapp_contacts.display_name),
         notify_name=COALESCE(NULLIF(EXCLUDED.notify_name,''),whatsapp_contacts.notify_name),
         verified_name=COALESCE(NULLIF(EXCLUDED.verified_name,''),whatsapp_contacts.verified_name),
         updated_at=NOW()`,
      [accountId, identityJid, phoneJid, contact.name?.trim() || null, contact.notify?.trim() || null, contact.verifiedName?.trim() || null],
    );
  }
}

async function repairStoredWhatsAppSenderNames() {
  const accountId = accountLease?.account.accountId;
  if (!accountId) return;
  await pool.query(
    `UPDATE messages m SET sender_name=NULLIF(m.raw->>'pushName','')
     WHERE m.platform='whatsapp' AND (m.sender_name IS NULL OR btrim(m.sender_name)='')
       AND NULLIF(m.raw->>'pushName','') IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM connector_accounts ca
         LEFT JOIN wa_groups og ON og.owner_user_id=ca.user_id AND og.id=m.group_id
         LEFT JOIN user_group_access uga ON uga.user_id=ca.user_id AND uga.group_id=m.group_id
         WHERE ca.id=$1::uuid AND (og.id IS NOT NULL OR uga.group_id IS NOT NULL)
       )`,
    [accountId],
  );
  await pool.query(
    `UPDATE messages m SET
       sender_jid=COALESCE(NULLIF(c.phone_jid,''),m.sender_jid),
       sender_name=COALESCE(NULLIF(m.sender_name,''),NULLIF(c.display_name,''),NULLIF(c.notify_name,''),NULLIF(c.verified_name,''))
     FROM whatsapp_contacts c
     WHERE c.account_id=$1::uuid AND m.platform='whatsapp'
       AND (c.identity_jid=m.sender_jid OR c.phone_jid=m.sender_jid)
       AND (m.sender_jid LIKE '%@lid' OR NULLIF(m.sender_name,'') IS NULL)`,
    [accountId],
  );
}

function participantAliases(message: WAMessage) {
  return Array.from(new Set([
    message.key.participant,
    message.key.participantLid,
    message.key.participantPn,
    message.key.senderLid,
    message.key.senderPn,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function participantCacheKey(groupId: string, participant: string) {
  return `${accountLease?.account.accountId ?? "unassigned"}:${groupId}:${participant}`;
}

function displayNameForParticipant(participant?: WhatsAppParticipant | null) {
  return participant?.name?.trim() || participant?.notify?.trim() || participant?.verifiedName?.trim() || undefined;
}

function cacheSenderIdentity(groupId: string, aliases: string[], identity: WhatsAppSenderIdentity, ttlMs: number) {
  const entry = { identity, expiresAt: Date.now() + ttlMs };
  for (const alias of aliases) senderIdentityCache.set(participantCacheKey(groupId, alias), entry);
}

async function resolveWhatsAppSender(message: WAMessage, socket: ReturnType<typeof makeWASocket> | null): Promise<{ identity: WhatsAppSenderIdentity; aliases: string[] }> {
  const groupId = message.key.remoteJid ?? "";
  const aliases = participantAliases(message);
  const participantPn = message.key.participantPn?.trim() || message.key.senderPn?.trim();
  const fallbackJid = participantPn || message.key.participant?.trim() || message.key.participantLid?.trim() || "unknown";
  const pushName = message.pushName?.trim();
  if (pushName) {
    const identity = { senderJid: fallbackJid, senderName: pushName };
    cacheSenderIdentity(groupId, aliases, identity, 60 * 60 * 1000);
    return { identity, aliases };
  }

  for (const alias of aliases) {
    const cached = senderIdentityCache.get(participantCacheKey(groupId, alias));
    if (cached && cached.expiresAt > Date.now()) return { identity: cached.identity, aliases };
  }

  const accountId = accountLease?.account.accountId;
  if (accountId && aliases.length) {
    const contact = await pool.query<{ identity_jid: string; phone_jid: string | null; display_name: string | null; notify_name: string | null; verified_name: string | null }>(
      `SELECT identity_jid, phone_jid, display_name, notify_name, verified_name
       FROM whatsapp_contacts
       WHERE account_id=$1::uuid AND (identity_jid=ANY($2::text[]) OR phone_jid=ANY($2::text[]))
       ORDER BY CASE WHEN display_name IS NOT NULL OR notify_name IS NOT NULL OR verified_name IS NOT NULL THEN 0 ELSE 1 END,
                updated_at DESC LIMIT 1`,
      [accountId, aliases],
    );
    const row = contact.rows[0];
    if (row) {
      const identity = {
        senderJid: row.phone_jid || row.identity_jid || fallbackJid,
        senderName: row.display_name?.trim() || row.notify_name?.trim() || row.verified_name?.trim() || undefined,
      };
      cacheSenderIdentity(groupId, aliases, identity, identity.senderName ? 60 * 60 * 1000 : 5 * 60 * 1000);
      return { identity, aliases };
    }
  }

  let matched: WhatsAppParticipant | undefined;
  try {
    const metadata = socket ? await socket.groupMetadata(groupId) : null;
    if (metadata?.participants?.length) await persistWhatsAppContacts(metadata.participants as WhatsAppParticipant[]);
    matched = metadata?.participants?.find((candidate: WhatsAppParticipant) => {
      const candidateAliases = [candidate.id, candidate.lid, candidate.jid].filter((value): value is string => Boolean(value));
      return candidateAliases.some((candidateAlias) => aliases.includes(candidateAlias))
        || Boolean(participantPn && candidate.jid === participantPn);
    });
  } catch {
    // Group metadata can be temporarily unavailable during reconnect/history sync.
  }
  const identity = {
    senderJid: participantPn || matched?.jid || fallbackJid,
    senderName: displayNameForParticipant(matched),
  };
  cacheSenderIdentity(groupId, aliases, identity, identity.senderName ? 60 * 60 * 1000 : 5 * 60 * 1000);
  return { identity, aliases };
}

async function persistResolvedSenderName(groupId: string, identity: WhatsAppSenderIdentity, aliases: string[]) {
  if (!identity.senderJid || !aliases.length) return;
  await pool.query(
    `UPDATE messages SET sender_jid=CASE WHEN sender_jid=ANY($2::text[]) THEN $3 ELSE sender_jid END,
       sender_name=COALESCE(NULLIF(sender_name,''),$4)
     WHERE group_id=$1 AND sender_jid=ANY($2::text[])`,
    [groupId, aliases, identity.senderJid, identity.senderName],
  );
}

async function persistMessage(message: WAMessage) {
  if (onboardingOnly) return;
  const groupId = message.key.remoteJid;
  const waMessageId = message.key.id;
  if (!groupId?.endsWith("@g.us") || !waMessageId) return;

  const selected = await pool.query<{ is_selected: boolean }>(`SELECT (g.is_selected OR COALESCE(uga.is_selected,FALSE)) AS is_selected
    FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, [groupId, accountLease?.account.userId ?? null]);
  if (!selected.rows[0]?.is_selected) return;

  const kind = messageKind(message);
  const hasMedia = kind === "audio" || kind === "image" || kind === "video" || kind === "document";
  const mediaMime = mediaMimeFor(message, kind);
  const { identity: sender, aliases: senderAliases } = await resolveWhatsAppSender(message, waSocket);
  const timestamp = Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000));
  // The cutoff is reset at every process start. This keeps delayed history
  // events bounded to the requested restart window as well as live updates.
  if (new Date(timestamp * 1000) < backfillCutoff) return;
  const raw = JSON.parse(JSON.stringify(message, (_, value) => typeof value === "bigint" ? Number(value) : value));
  const text = messageText(message);
  const contentHash = createHash("sha256").update(JSON.stringify({ groupId, waMessageId, kind, text, raw })).digest("hex");
  const previous = await pool.query<{ id: string; content_hash: string | null; deleted_at: string | null; media_object_path: string | null }>(
    `SELECT m.id, m.content_hash, m.deleted_at,
            (SELECT mo.object_path FROM media_objects mo WHERE mo.message_id=m.id AND mo.status='completed' AND mo.object_path IS NOT NULL ORDER BY mo.updated_at DESC LIMIT 1) AS media_object_path
     FROM messages m WHERE m.group_id = $1 AND m.wa_message_id = $2`, [groupId, waMessageId],
  );
  const mediaAlreadyStored = !hasMedia || Boolean(previous.rows[0]?.media_object_path);
  if (previous.rows[0]?.content_hash === contentHash && !previous.rows[0]?.deleted_at && mediaAlreadyStored) {
    await persistResolvedSenderName(groupId, sender, senderAliases);
    return;
  }
  let objectPath: string | undefined;
  const mediaKey = hasMedia ? `${groupId}/${waMessageId}` : undefined;
  if (hasMedia && !mockMode && waSocket) {
    try {
      const media = await downloadWhatsAppMedia(message, waSocket);
      const safeName = waMessageId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const extension = mediaMime?.split("/")[1]?.split(";")[0] ?? kind;
      objectPath = join(mediaDir, "incoming", `${safeName}.${extension}`);
      await mkdir(join(mediaDir, "incoming"), { recursive: true });
      await writeFile(objectPath, media);
    } catch (error) {
      console.warn("WhatsApp media download failed after retries", waMessageId, error);
    }
  }
  const mediaStatus = !hasMedia ? "none" : objectPath ? "completed" : "pending";
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, wa_message_id, platform, external_chat_id, sender_jid, sender_name, kind, text, received_at, has_media, media_key, media_mime, raw, content_hash, sequence_no, media_status, edited_at, deleted_at)
     VALUES ($1,$2,'whatsapp',$1,$3,$4,$5,$6,to_timestamp($7),$8,$9,$10,$11,$12,$7,$13,CASE WHEN $14 THEN NOW() ELSE NULL END,NULL)
     ON CONFLICT (group_id, wa_message_id) DO UPDATE SET sender_jid = EXCLUDED.sender_jid,
       sender_name = COALESCE(NULLIF(EXCLUDED.sender_name,''), messages.sender_name), kind = EXCLUDED.kind, text = EXCLUDED.text,
       received_at = EXCLUDED.received_at, has_media = EXCLUDED.has_media,
       media_key = EXCLUDED.media_key, media_mime = EXCLUDED.media_mime, raw = EXCLUDED.raw,
       content_hash = EXCLUDED.content_hash, sequence_no = EXCLUDED.sequence_no,
       media_status = EXCLUDED.media_status,
       edited_at = CASE WHEN messages.content_hash IS NOT NULL THEN NOW() ELSE messages.edited_at END
     RETURNING id`,
    [groupId, waMessageId, sender.senderJid, sender.senderName ?? null, kind, text ?? null,
      timestamp, hasMedia, mediaKey ?? null, mediaMime ?? null, raw, contentHash, mediaStatus, Boolean(previous.rows[0])],
  );
  await persistResolvedSenderName(groupId, sender, senderAliases);
  const messageId = result.rows[0].id;
  const revisionCount = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM message_revisions WHERE message_id = $1", [messageId]);
  await pool.query(
    "INSERT INTO message_revisions (message_id, revision_no, change_type, text, raw) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [messageId, Number(revisionCount.rows[0]?.count ?? 0) + 1, previous.rows[0] ? "updated" : "created", text ?? null, raw],
  );
  const data: WhatsAppMessageReceived = {
    messageId, waMessageId, groupId, platform: "whatsapp", chatType: "group", externalChatId: groupId,
    senderJid: sender.senderJid, senderName: sender.senderName,
    kind, text: messageText(message), receivedAt: new Date(timestamp * 1000).toISOString(), hasMedia,
    mediaKey, mediaMime, mediaObjectPath: objectPath, raw,
    replyToWaMessageId: replyToWaMessageId(message),
    changeType: previous.rows[0] ? "updated" : "created", sequenceNo: timestamp,
  };
  await publish(subjects.messageReceived, subjects.messageReceived, data);
  if (objectPath && mediaKey) {
    await publish(subjects.mediaRequested, subjects.mediaRequested, { messageId, mediaKey, objectPath, mediaMime, platform: "whatsapp" });
  }
  if (kind === "audio") {
    const existing = await pool.query<{ id: string }>("SELECT id FROM audio_jobs WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1", [data.messageId]);
    const jobId = existing.rows[0]?.id ?? randomUUID();
    if (!existing.rows[0]) {
      await pool.query("INSERT INTO audio_jobs (id, message_id, media_key, media_mime, object_path) VALUES ($1,$2,$3,$4,$5)", [jobId, data.messageId, data.mediaKey, data.mediaMime ?? null, objectPath ?? null]);
    }
    await publish(subjects.audioRequested, subjects.audioRequested, { jobId, messageId: data.messageId, mediaKey: data.mediaKey!, mediaMime: data.mediaMime, objectPath });
  }
  if (accountLease) await accountLease.saveCursor(groupId, { externalMessageId: waMessageId, receivedAt: data.receivedAt, sequenceNo: timestamp });
}

async function queueOrPersistHistory(message: WAMessage) {
  if (onboardingOnly) return;
  const groupId = message.key.remoteJid;
  if (!groupId?.endsWith("@g.us")) return;
  const timestamp = Number(message.messageTimestamp ?? 0);
  if (!timestamp || new Date(timestamp * 1000) < backfillCutoff) return;
  const selected = await pool.query<{ is_selected: boolean }>(`SELECT (g.is_selected OR COALESCE(uga.is_selected,FALSE)) AS is_selected
    FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, [groupId, accountLease?.account.userId ?? null]);
  if (selected.rows[0]?.is_selected) {
    await persistMessage(message);
    return;
  }
  const messages = pendingHistory.get(groupId) ?? [];
  messages.push(message);
  pendingHistory.set(groupId, messages);
}

async function requestWhatsAppHistory(socket: ReturnType<typeof makeWASocket>, groupId: string) {
  if (!connected || waSocket !== socket) return;
  let lastOldestID: string | undefined;
  for (let page = 0; page < historyMaxPages; page += 1) {
    if (!connected || waSocket !== socket) return;
    const oldest = await pool.query<{ wa_message_id: string; received_at: Date; from_me: boolean; participant: string | null }>(
      `SELECT wa_message_id, received_at,
              CASE WHEN raw->'key'->>'fromMe'='true' THEN TRUE ELSE FALSE END AS from_me,
              raw->'key'->>'participant' AS participant
       FROM messages WHERE group_id=$1 ORDER BY received_at ASC LIMIT 1`,
      [groupId],
    );
    const oldestMessage = oldest.rows[0];
    if (oldestMessage && oldestMessage.received_at.getTime() <= backfillCutoff.getTime()) return;
    if (oldestMessage?.wa_message_id === lastOldestID) return;
    lastOldestID = oldestMessage?.wa_message_id;
    const oldestKey = {
      remoteJid: groupId,
      fromMe: oldestMessage?.from_me ?? false,
      id: oldestMessage?.wa_message_id ?? "0",
      ...(oldestMessage?.participant ? { participant: oldestMessage.participant } : {}),
    };
    const historyResult = waitForWhatsAppHistory(groupId);
    try {
      await socket.fetchMessageHistory(
        historyPageSize,
        oldestKey,
        oldestMessage?.received_at?.getTime() ?? backfillCutoff.getTime(),
      );
      const receivedCount = await historyResult;
      console.log(`WhatsApp history page ${page + 1}/${historyMaxPages} received for ${groupId}: ${receivedCount} message(s)`);
      if (receivedCount === 0) return;
      await backfillDelay(Math.max(500, backfillThrottleMs));
    } catch (error) {
      historyWaiters.delete(groupId);
      console.warn("WhatsApp selected-group history request failed", groupId, error);
      return;
    }
  }
}

async function backfillSelectedWhatsAppGroups(socket: ReturnType<typeof makeWASocket>) {
  const selected = await pool.query<{ id: string }>(
    "SELECT g.id FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid WHERE g.platform='whatsapp' AND (g.is_selected=TRUE OR uga.is_selected=TRUE) ORDER BY g.subject",
    [accountLease?.account.userId ?? null],
  );
  for (const [index, group] of selected.rows.entries()) {
    if (index > 0) await backfillDelay(backfillGroupDelayMs);
    await requestWhatsAppHistory(socket, group.id);
  }
}

async function retryMissingWhatsAppMedia(socket: ReturnType<typeof makeWASocket>) {
  const rows = await pool.query<{ id: string; raw: WAMessage }>(
    `SELECT m.id, m.raw
     FROM messages m
     JOIN wa_groups g ON g.id = m.group_id AND g.platform='whatsapp'
     LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid
     LEFT JOIN LATERAL (
       SELECT mo.message_id
       FROM media_objects mo
       WHERE mo.message_id = m.id AND mo.status='completed' AND mo.object_path IS NOT NULL
       LIMIT 1
     ) stored ON TRUE
     WHERE m.platform='whatsapp' AND m.has_media=TRUE AND m.kind IN ('image','video')
       AND m.received_at >= $1 AND stored.message_id IS NULL
     ORDER BY m.received_at DESC`,
    [backfillCutoff, accountLease?.account.userId ?? null],
  );
  if (!rows.rows.length) return;
  console.log(`Retrying ${rows.rows.length} missing WhatsApp image/video file(s)`);
  for (const row of rows.rows) {
    if (!connected || waSocket !== socket) return;
    try {
      await persistMessage(row.raw);
    } catch (error) {
      console.warn("WhatsApp pending media retry failed", row.id, error);
    }
    await backfillDelay(backfillThrottleMs);
  }
}

async function handleGroupSelection(data: GroupSelectionChanged) {
  if (data.platform && data.platform !== "whatsapp") return;
  const groupId = data.groupId;
  if (!groupId.endsWith("@g.us")) return;
  await pool.query("UPDATE user_group_access SET is_selected=$1 WHERE user_id=$3::uuid AND group_id=$2", [data.selected, groupId, accountLease?.account.userId ?? null]);
  if (!data.selected) {
    pendingHistory.delete(groupId);
    return;
  }
  const pending = pendingHistory.get(groupId) ?? [];
  pendingHistory.delete(groupId);
  for (const message of pending) {
    await persistMessage(message);
    await backfillDelay(backfillThrottleMs);
  }
  if (waSocket) await requestWhatsAppHistory(waSocket, groupId);
}

function subscribeGroupSelections() {
  const subscription = nc.subscribe(subjects.groupSelectionChanged);
  void (async () => {
    for await (const message of subscription) {
      try {
        const envelope = JSON.parse(sc.decode(message.data)) as { data?: GroupSelectionChanged };
        if (envelope.data) await handleGroupSelection(envelope.data);
      } catch (error) {
        console.warn("WhatsApp group selection event failed", error);
      }
    }
  })();
}

function scheduleWhatsAppReconnect(reason?: unknown) {
  if (mockMode || onboardingOnly || !accountLease || reconnectTimer || lifecycleStatus === "reauth_required" || lifecycleStatus === "stopped") return;
  connected = false;
  waSocket = null;
  reconnectAttempts = Math.min(reconnectAttempts + 1, 10);
  const delayMs = Math.min(30_000, 3_000 * 2 ** (reconnectAttempts - 1));
  void setStatus("degraded", `Verbindung unterbrochen; erneuter Versuch in ${Math.ceil(delayMs / 1000)} s`, reason).catch((error) => console.warn("WhatsApp reconnect status failed", error));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectWhatsApp().catch((error) => scheduleWhatsAppReconnect(error));
  }, delayMs);
  reconnectTimer.unref?.();
}

async function connectWhatsApp() {
  if (connectInProgress || mockMode) return;
  connectInProgress = true;
  try {
    await setStatus("connecting", `Baileys wird verbunden; ${initialActivation ? "Erst-" : "Neustart-"}Backfill: ${backfillDays} Tage`);
    const activeAuthDir = accountLease ? join(authDir, accountLease.account.accountId) : authDir;
    await mkdir(activeAuthDir, { recursive: true });
    await restoreAuthSnapshot(activeAuthDir);
    const { state, saveCreds } = await useMultiFileAuthState(activeAuthDir);
    const activeAccountId = accountLease?.account.accountId;
    const originalKeySet = state.keys.set.bind(state.keys);
    state.keys.set = async (data) => {
      await originalKeySet(data);
      if (activeAccountId) scheduleAuthSnapshotPersist(activeAuthDir, activeAccountId);
    };
    // WhatsApp currently terminates Baileys sessions that advertise the
    // macOS/DARWIN desktop sub-platform before sending the QR event. Use the
    // browser profile so fresh linked-device registration reaches pair-device.
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      // Do not request Baileys' global full-history/app-state sync here. It
      // can fail on large linked-device accounts before selected groups are
      // available. The controlled per-group fetch below is the authoritative
      // backfill path and keeps the configured time window intact.
      syncFullHistory: false,
      // Still process explicit fetchMessageHistory responses. Initial RECENT
      // and FULL notifications stay disabled, so Baileys does not trigger a
      // global app-state sync for the account.
      shouldSyncHistoryMessage: (history) => history.syncType === proto.Message.HistorySyncNotification.HistorySyncType.ON_DEMAND,
      // This connector is read-only. Baileys' optional props/blocklist/privacy
      // init queries can time out on an otherwise healthy linked-device socket;
      // skipping them avoids a noisy 60-second error without affecting group
      // discovery, message reception, or media downloads.
      fireInitQueries: false,
      // Status updates and direct device-to-device chats are not part of the
      // selected WhatsApp group data. They can arrive encrypted for a device
      // whose Signal session is unavailable here and otherwise cause repeated
      // retry/Bad-MAC noise. Group JIDs (@g.us) remain fully enabled.
      shouldIgnoreJid: (jid) => jid === "status@broadcast"
        || Boolean(jid?.endsWith("@lid"))
        || Boolean(jid?.endsWith("@s.whatsapp.net"))
        || Boolean(jid?.endsWith("@c.us")),
    });
    waSocket = socket;
    socket.ev.on("creds.update", async () => {
      await saveCreds();
      await persistAuthSnapshot(activeAuthDir).catch((error) => console.warn("WhatsApp session snapshot failed", error));
    });
    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQr = qr;
      void setStatus("pairing", "QR-Code zur erneuten Anmeldung scannen");
      if (onboardingOnly && accountLease) void accountLease.updateQR({ status: "qr", qrPayload: qr, expiresAt: new Date(Date.now() + 60_000), workerId: poolWorkerId });
    }
    connected = connection === "open";
    if (connection === "connecting") void setStatus("connecting", "WhatsApp-Verbindung wird aufgebaut");
    if (connection === "open") {
      if (onboardingOnly && !socket.user) return;
      reconnectAttempts = 0;
      connectedAt = new Date().toISOString();
      latestQr = null;
      if (onboardingOnly && accountLease) void accountLease.updateQR({ status: "connected", qrPayload: null, expiresAt: null, workerId: poolWorkerId });
      void setStatus("syncing", `${initialActivation ? "Erst-" : "Neustart-"}Backfill der letzten ${backfillDays} Tage läuft`);
      startGroupRefreshTimer();
      void (async () => {
        await refreshAllWhatsAppGroupNames(socket);
        if (onboardingOnly) {
          if (accountLease) await accountLease.updateOnboardingRequest("connected", null, onboardingRequest?.id);
          await backfillDelay(500);
          await finishOnboarding();
          return;
        }
        await backfillSelectedWhatsAppGroups(socket);
        void retryMissingWhatsAppMedia(socket)
          .catch((error) => console.warn("WhatsApp missing-media repair failed", error));
        await setStatus("ready", `WhatsApp verbunden; ${backfillDays}-Tage-Backfill eingeplant, Medienreparatur läuft im Hintergrund`);
        await finishProcessingCycle();
      })().catch((error) => void setStatus("degraded", "WhatsApp-Backfill konnte nicht vollständig gestartet werden", error));
    }
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        if (onboardingOnly) void finishOnboarding("failed", new Error("WhatsApp session logged out"));
        else void setStatus("reauth_required", "Session abgemeldet; erneutes QR-Pairing erforderlich");
      } else if (onboardingOnly) void finishOnboarding("failed", lastDisconnect?.error ?? new Error("WhatsApp onboarding connection closed"));
      else scheduleWhatsAppReconnect(lastDisconnect?.error);
    }
  });
    socket.ev.on("groups.upsert", async (groups) => {
      try {
        for (const group of groups) {
          if (group.participants?.length) await persistWhatsAppContacts(group.participants as WhatsAppParticipant[]);
          const subject = group.subject?.trim() || group.id;
          await upsertGroup({ groupId: group.id, subject, ownerJid: group.owner ?? undefined, participantCount: group.participants?.length ?? 0, isSelected: allowlistedGroup(group.id), platform: "whatsapp", chatType: "group" });
          await refreshGroupName(socket, group.id, subject);
        }
      } catch (error) {
        console.warn("WhatsApp group update failed", error);
      }
    });
    socket.ev.on("messages.upsert", async ({ messages }) => {
      if (onboardingOnly) return;
      for (const message of messages) {
        try { await persistMessage(message); }
        catch (error) { console.warn("WhatsApp message persistence failed", message.key.id, error); }
      }
    });
    (socket.ev as any).on("contacts.upsert", async (contacts: WhatsAppParticipant[]) => {
      try { await persistWhatsAppContacts(contacts); }
      catch (error) { console.warn("WhatsApp contact persistence failed", error); }
    });
    (socket.ev as any).on("contacts.update", async (contacts: WhatsAppParticipant[]) => {
      try {
        await persistWhatsAppContacts(contacts);
        await repairStoredWhatsAppSenderNames();
      } catch (error) { console.warn("WhatsApp contact update persistence failed", error); }
    });
    (socket.ev as any).on("messaging-history.set", async (history: { messages?: WAMessage[]; contacts?: WhatsAppParticipant[]; chats?: Array<{ id: string; name?: string; subject?: string; participants?: unknown[] }> }) => {
      try {
        void setStatus("syncing", "WhatsApp-History wird kontrolliert übernommen");
        const historyGroupIds = new Set<string>([
          ...(history.chats ?? []).map((chat) => chat.id),
          ...(history.messages ?? []).map((message) => message.key.remoteJid ?? ""),
        ].filter((groupId) => groupId.endsWith("@g.us")));
        if (history.contacts?.length) {
          await persistWhatsAppContacts(history.contacts);
          await repairStoredWhatsAppSenderNames();
        }
        for (const chat of history.chats ?? []) {
          if (chat.id.endsWith("@g.us")) {
            const subject = chat.name?.trim() || chat.subject?.trim() || chat.id;
            await upsertGroup({ groupId: chat.id, subject, participantCount: chat.participants?.length ?? 0, isSelected: allowlistedGroup(chat.id), platform: "whatsapp", chatType: "group" });
            await refreshGroupName(socket, chat.id, subject);
          }
        }
        if (onboardingOnly) return;
        for (const message of history.messages ?? []) {
          try { await queueOrPersistHistory(message); }
          catch (error) { console.warn("WhatsApp history message failed", message.key.id, error); }
          await backfillDelay(backfillThrottleMs);
        }
        for (const groupId of historyGroupIds) {
          notifyWhatsAppHistory(groupId, (history.messages ?? []).filter((message) => message.key.remoteJid === groupId).length);
        }
        if (initialActivation) {
          await completeInitialActivation();
          if (connected) await setStatus("ready", `Erst-Backfill der letzten ${backfillDays} Tage abgeschlossen`);
        } else if (connected) void setStatus("ready", "History Sync abgeschlossen");
      } catch (error) {
        await setStatus("degraded", "WhatsApp-History konnte nicht vollständig verarbeitet werden", error);
      }
    });
    (socket.ev as any).on("messages.update", async (updates: Array<{ key: WAMessage["key"]; update?: { message?: WAMessage["message"] } }>) => {
      if (onboardingOnly) return;
      for (const update of updates) {
        try {
          if (update.update?.message) await persistMessage({ key: update.key, message: update.update.message } as WAMessage);
        } catch (error) { console.warn("WhatsApp message update failed", update.key.id, error); }
      }
    });
    (socket.ev as any).on("messages.delete", async (payload: { keys?: WAMessage["key"][] }) => {
      if (onboardingOnly) return;
      try {
        for (const key of payload.keys ?? []) {
          if (!key.remoteJid || !key.id) continue;
          const result = await pool.query<{ id: string }>("UPDATE messages SET deleted_at=NOW(), media_status='deleted' WHERE group_id=$1 AND wa_message_id=$2 RETURNING id", [key.remoteJid, key.id]);
          if (result.rows[0]) await pool.query("INSERT INTO message_revisions (message_id, revision_no, change_type, text) SELECT $1, COALESCE(MAX(revision_no),0)+1, 'deleted', NULL FROM message_revisions WHERE message_id=$1", [result.rows[0].id]);
        }
      } catch (error) { console.warn("WhatsApp delete event failed", error); }
    });
  } finally {
    connectInProgress = false;
  }
}

type MockReply = { waMessageId: string; participant: string; quotedText: string };

function mockMessage(
  groupId: string,
  waMessageId: string,
  participant: string,
  senderName: string,
  timestamp: number,
  message: WAMessage["message"],
  replyTo?: MockReply,
): WAMessage {
  const nextMessage = replyTo && message?.extendedTextMessage
    ? {
        ...message,
        extendedTextMessage: {
          ...message.extendedTextMessage,
          contextInfo: {
            ...message.extendedTextMessage.contextInfo,
            stanzaId: replyTo.waMessageId,
            participant: replyTo.participant,
            quotedMessage: { conversation: replyTo.quotedText },
          },
        },
      }
    : message;
  return {
    key: { remoteJid: groupId, id: waMessageId, participant },
    pushName: senderName,
    messageTimestamp: timestamp,
    message: nextMessage,
  };
}

async function seedMockData() {
  const baseTimestamp = Math.floor(Date.now() / 1000) - 3600;
  const alex = "491701234567@s.whatsapp.net";
  const sam = "491709876543@s.whatsapp.net";
  const lena = "491761112233@s.whatsapp.net";
  const marc = "34600123456@s.whatsapp.net";
  const julia = "33612345678@s.whatsapp.net";
  const groups: Array<{ groupId: string; subject: string; participantCount: number; messages: WAMessage[] }> = [
    {
      groupId: "120363mock@g.us",
      subject: "Barcelona Wochenende",
      participantCount: 6,
      messages: [
        mockMessage("120363mock@g.us", "mock-text-1", alex, "Alex", baseTimestamp + 60, { conversation: "Treffen wir uns Samstag um 10 Uhr für die Wanderung?" }),
        mockMessage("120363mock@g.us", "mock-reply-1", sam, "Sam", baseTimestamp + 120, { extendedTextMessage: { text: "Passt für mich, ich bringe Kaffee und Wasser mit." } }, { waMessageId: "mock-text-1", participant: alex, quotedText: "Treffen wir uns Samstag um 10 Uhr für die Wanderung?" }),
        mockMessage("120363mock@g.us", "mock-image-1", lena, "Lena", baseTimestamp + 180, { imageMessage: { mimetype: "image/jpeg", caption: "Die aktuelle Routenkarte für den Montserrat-Aufstieg.", width: 1280, height: 960, fileLength: 245000 } }),
        mockMessage("120363mock@g.us", "mock-location-1", alex, "Alex", baseTimestamp + 240, { locationMessage: { degreesLatitude: 41.5933, degreesLongitude: 1.8372, name: "Kloster Montserrat", address: "08199 Monistrol de Montserrat, Barcelona" } }),
        mockMessage("120363mock@g.us", "mock-audio-1", sam, "Sam", baseTimestamp + 300, { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 18, ptt: true, fileLength: 18000 } }),
        mockMessage("120363mock@g.us", "mock-text-2", marc, "Marc", baseTimestamp + 360, { conversation: "Die Zugtickets sind reserviert, Abfahrt um 08:42 Uhr ab Barcelona Sants." }),
        mockMessage("120363mock@g.us", "mock-reply-2", julia, "Julia", baseTimestamp + 420, { extendedTextMessage: { text: "Super, dann sollten wir spätestens um 08:20 am Bahnhof sein." } }, { waMessageId: "mock-text-2", participant: marc, quotedText: "Die Zugtickets sind reserviert, Abfahrt um 08:42 Uhr ab Barcelona Sants." }),
        mockMessage("120363mock@g.us", "mock-image-2", lena, "Lena", baseTimestamp + 480, { imageMessage: { mimetype: "image/jpeg", caption: "Picknick-Checkliste — die Decken sind schon eingepackt.", width: 1024, height: 768, fileLength: 198000 } }),
        mockMessage("120363mock@g.us", "mock-audio-2", alex, "Alex", baseTimestamp + 540, { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 9, ptt: true, fileLength: 9000 } }),
        mockMessage("120363mock@g.us", "mock-reply-3", sam, "Sam", baseTimestamp + 600, { extendedTextMessage: { text: "Danke, ich höre die Sprachnachricht gleich im Zug." } }, { waMessageId: "mock-audio-2", participant: alex, quotedText: "Sprachnachricht (9 Sekunden)" }),
      ],
    },
    {
      groupId: "120363mock2@g.us",
      subject: "Familie Costa Brava",
      participantCount: 5,
      messages: [
        mockMessage("120363mock2@g.us", "mock2-text-1", marc, "Marc", baseTimestamp + 90, { conversation: "Am Sonntag wollen wir an die Costa Brava fahren. Wer kommt mit?" }),
        mockMessage("120363mock2@g.us", "mock2-reply-1", julia, "Julia", baseTimestamp + 150, { extendedTextMessage: { text: "Wir sind zu dritt dabei, aber nur wenn wir früh losfahren." } }, { waMessageId: "mock2-text-1", participant: marc, quotedText: "Am Sonntag wollen wir an die Costa Brava fahren. Wer kommt mit?" }),
        mockMessage("120363mock2@g.us", "mock2-location-1", lena, "Lena", baseTimestamp + 210, { locationMessage: { degreesLatitude: 41.7904, degreesLongitude: 3.04873, name: "Platja de Sant Pol", address: "S'Agaró, Girona" } }),
        mockMessage("120363mock2@g.us", "mock2-image-1", sam, "Sam", baseTimestamp + 270, { imageMessage: { mimetype: "image/jpeg", caption: "So leer war der Strand im letzten Juni.", width: 1200, height: 900, fileLength: 278000 } }),
        mockMessage("120363mock2@g.us", "mock2-audio-1", julia, "Julia", baseTimestamp + 330, { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 24, ptt: true, fileLength: 24000 } }),
        mockMessage("120363mock2@g.us", "mock2-text-2", alex, "Alex", baseTimestamp + 390, { conversation: "Ich reserviere einen Tisch für fünf Personen zum Mittagessen." }),
        mockMessage("120363mock2@g.us", "mock2-reply-2", marc, "Marc", baseTimestamp + 450, { extendedTextMessage: { text: "Bitte ohne Meeresfrüchte für mich, danke!" } }, { waMessageId: "mock2-text-2", participant: alex, quotedText: "Ich reserviere einen Tisch für fünf Personen zum Mittagessen." }),
        mockMessage("120363mock2@g.us", "mock2-image-2", lena, "Lena", baseTimestamp + 510, { imageMessage: { mimetype: "image/jpeg", caption: "Die Kinder haben ihre Schwimmsachen bereitgelegt.", width: 900, height: 1200, fileLength: 221000 } }),
        mockMessage("120363mock2@g.us", "mock2-location-2", alex, "Alex", baseTimestamp + 570, { locationMessage: { degreesLatitude: 41.96035, degreesLongitude: 3.22928, name: "Parkplatz Cala Sa Tuna", address: "Begur, Girona" } }),
        mockMessage("120363mock2@g.us", "mock2-reply-3", julia, "Julia", baseTimestamp + 630, { extendedTextMessage: { text: "Der zweite Ort ist besser, dort gibt es Schatten und Toiletten." } }, { waMessageId: "mock2-location-2", participant: alex, quotedText: "Parkplatz Cala Sa Tuna, Begur" }),
      ],
    },
    {
      groupId: "120363mock3@g.us",
      subject: "Remote Team Europa",
      participantCount: 8,
      messages: [
        mockMessage("120363mock3@g.us", "mock3-text-1", julia, "Julia", baseTimestamp + 30, { conversation: "Reminder: Das Produktmeeting beginnt morgen um 09:30 Uhr." }),
        mockMessage("120363mock3@g.us", "mock3-reply-1", alex, "Alex", baseTimestamp + 75, { extendedTextMessage: { text: "Ich bringe die Auswertung und die offenen Risiken mit." } }, { waMessageId: "mock3-text-1", participant: julia, quotedText: "Das Produktmeeting beginnt morgen um 09:30 Uhr." }),
        mockMessage("120363mock3@g.us", "mock3-image-1", lena, "Lena", baseTimestamp + 135, { imageMessage: { mimetype: "image/png", caption: "Entwurf für das neue Dashboard — Feedback willkommen.", width: 1440, height: 900, fileLength: 312000 } }),
        mockMessage("120363mock3@g.us", "mock3-audio-1", marc, "Marc", baseTimestamp + 195, { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 31, ptt: true, fileLength: 31000 } }),
        mockMessage("120363mock3@g.us", "mock3-location-1", julia, "Julia", baseTimestamp + 255, { locationMessage: { degreesLatitude: 48.86917, degreesLongitude: 2.33139, name: "Paris Office", address: "12 Rue de la Paix, 75002 Paris" } }),
        mockMessage("120363mock3@g.us", "mock3-text-2", sam, "Sam", baseTimestamp + 315, { conversation: "Für das Team-Event im Juni habe ich den Freitag im Kalender blockiert." }),
        mockMessage("120363mock3@g.us", "mock3-reply-2", marc, "Marc", baseTimestamp + 375, { extendedTextMessage: { text: "Katalonien wäre für mich ideal, ich suche gleich zwei Vorschläge heraus." } }, { waMessageId: "mock3-text-2", participant: sam, quotedText: "Für das Team-Event im Juni habe ich den Freitag im Kalender blockiert." }),
        mockMessage("120363mock3@g.us", "mock3-image-2", alex, "Alex", baseTimestamp + 435, { imageMessage: { mimetype: "image/jpeg", caption: "Foto vom letzten Offsite in Girona.", width: 1280, height: 853, fileLength: 256000 } }),
        mockMessage("120363mock3@g.us", "mock3-audio-2", lena, "Lena", baseTimestamp + 495, { audioMessage: { mimetype: "audio/ogg; codecs=opus", seconds: 14, ptt: true, fileLength: 14000 } }),
        mockMessage("120363mock3@g.us", "mock3-reply-3", julia, "Julia", baseTimestamp + 555, { extendedTextMessage: { text: "Die Sprachnachricht fasst die Prioritäten gut zusammen — ich aktualisiere das Protokoll." } }, { waMessageId: "mock3-audio-2", participant: lena, quotedText: "Sprachnachricht (14 Sekunden)" }),
      ],
    },
  ];

  for (const group of groups) {
    await upsertGroup({ groupId: group.groupId, subject: group.subject, participantCount: group.participantCount, isSelected: allowlistedGroup(group.groupId), platform: "whatsapp", chatType: "group" });
    for (const message of group.messages) await queueOrPersistHistory(message);
  }
}

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function respond(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") { response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,PUT,OPTIONS", "access-control-allow-headers": "content-type" }); return response.end(); }
    if (request.url === "/healthz") return respond(response, 200, { status: "ok", service: "wa-connector" });
    if (request.url === "/readyz") return respond(response, lifecycleStatus === "ready" || mockMode ? 200 : 503, { status: lifecycleStatus, mode: mockMode ? "mock" : "baileys", lastError });
    if (request.url === "/status" || request.url === "/pairing") {
      return respond(response, 200, { connector: "whatsapp", status: lifecycleStatus, connected, connectedAt, lastError, mode: mockMode ? "mock" : "baileys", historySync: syncHistory || initialActivation, initialBackfillActive: initialActivation, backfillDays, backfillThrottleMs, backfillGroupDelayMs, qrRouting: "api-account" });
    }
    if (request.method === "GET" && request.url === "/groups") {
      const groups = await pool.query("SELECT id, subject, participant_count, is_selected, discovered_at FROM wa_groups ORDER BY subject");
      return respond(response, 200, groups.rows);
    }
    const match = request.url?.match(/^\/groups\/([^/]+)\/select$/);
    if (request.method === "PUT" && match) {
      const body = await jsonBody(request);
      const result = await pool.query("UPDATE wa_groups SET is_selected = $1, updated_at = NOW() WHERE id = $2 RETURNING id, subject, is_selected", [Boolean(body.selected), decodeURIComponent(match[1])]);
      return respond(response, result.rowCount ? 200 : 404, result.rows[0] ?? { error: "group not found" });
    }
    return respond(response, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    return respond(response, 500, { error: "internal error" });
  }
});

async function main() {
  if (connectorStartDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, connectorStartDelayMs));
  nc = await connect({ servers: natsUrl });
  await ensureEventStream();
  subscribeGroupSelections();
  await pool.query("SELECT 1");
  if (!onboardingOnly) await prepareInitialActivation();
  let poolReady = onboardingOnly ? false : true;
  if (!onboardingOnly) {
    try {
      poolReady = await initializePoolLease();
    } catch (error) {
      poolReady = false;
      console.error("WhatsApp connector pool initialization failed", error);
      await setStatus("error", "Connector-Pool konnte nicht initialisiert werden", error);
    }
  }
  if (onboardingOnly) await setStatus("starting", "WhatsApp-Onboarding wartet auf eine QR-Anforderung");
  server.listen(port, () => console.log(`wa-connector listening on :${port} (${mockMode ? "mock" : "baileys"})`));
  if (mockMode) { connected = true; connectedAt = new Date().toISOString(); await setStatus("syncing", initialActivation ? `Mock-Backfill der letzten ${backfillDays} Tage läuft` : "Mock-Daten aktiv"); await seedMockData(); await completeInitialActivation(); await setStatus("ready", "Mock-Daten aktiv"); }
  else if (onboardingOnly) {
    startOnboardingPoller();
  } else if (poolReady) {
    try {
      await connectWhatsApp();
    } catch (error) {
      console.error("Initial WhatsApp connection failed", error);
      scheduleWhatsAppReconnect(error);
    }
  } else if (poolEnabled) {
    console.warn("WhatsApp connector is paused because no account lease is available");
  }
  if (poolEnabled && !onboardingOnly) startProcessingPoller();
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
