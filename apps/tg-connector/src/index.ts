import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { connect, StorageType, StringCodec, type JetStreamClient, type NatsConnection } from "nats";
import { Pool } from "pg";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import { subjects, type ConnectorLifecycleStatus, type EventEnvelope, type GroupDiscovered, type GroupSelectionChanged, type WhatsAppMessageReceived } from "@wagi/contracts";
import { acquireConnectorAccount, claimConnectorOnboardingRequest, type ConnectorAccountLease, type ConnectorSQLStore, type ConnectorOnboardingRequest } from "@wagi/connector-sdk";

const port = Number(process.env.TG_PORT ?? process.env.PORT ?? 3002);
const databaseUrl = process.env.DATABASE_URL ?? "postgres://wagi_app:app@localhost:5432/app";
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
const botToken = (process.env.TG_BOT_TOKEN ?? "").trim();
const apiId = Number(process.env.TG_API_ID ?? 0);
const apiHash = (process.env.TG_API_HASH ?? "").trim();
let directPhone = (process.env.TG_PHONE ?? "").trim();
const directSession = (process.env.TG_SESSION ?? "").trim();
const stateDir = process.env.TG_STATE_DIR ?? "./data/tg-state";
const directSessionPath = join(stateDir, "direct-session.txt");
const mediaDir = process.env.MEDIA_DIR ?? "./data/media";
const offsetPath = join(stateDir, "offset.json");
const pollTimeout = Math.max(1, Math.min(50, Number(process.env.TG_POLL_TIMEOUT ?? 25)));
const backfillDays = Math.max(1, Number(process.env.TG_BACKFILL_DAYS ?? 7));
const backfillThrottleMs = Math.max(0, Number(process.env.TG_BACKFILL_THROTTLE_MS ?? 500));
const backfillGroupDelayMs = Math.max(0, Number(process.env.TG_BACKFILL_GROUP_DELAY_MS ?? 2000));
const connectionRetries = Math.max(5, Number(process.env.TG_CONNECTION_RETRIES ?? 12));
const requestRetries = Math.max(3, Number(process.env.TG_REQUEST_RETRIES ?? 8));
const downloadRetries = Math.max(3, Number(process.env.TG_DOWNLOAD_RETRIES ?? 8));
const retryDelay = Math.max(500, Number(process.env.TG_RETRY_DELAY_MS ?? 2000));
const mediaRetryAttempts = Math.max(1, Number(process.env.TG_MEDIA_RETRY_ATTEMPTS ?? 4));
const groupRefreshIntervalMs = Math.max(30_000, Number(process.env.GROUP_REFRESH_INTERVAL_MS ?? 60_000));
const mediaCleanupToken = (process.env.MEDIA_CLEANUP_TOKEN ?? "").trim();
const allowlist = new Set((process.env.TG_GROUP_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const directMode = apiId > 0 && Boolean(apiHash);
const poolEnabled = (process.env.CONNECTOR_POOL_ENABLED ?? "false").toLowerCase() === "true";
const poolWorkerId = (process.env.CONNECTOR_WORKER_ID ?? "").trim() || `tg-${process.env.HOSTNAME ?? process.pid}`;
const poolLeaseSeconds = Math.max(30, Number(process.env.CONNECTOR_LEASE_SECONDS ?? 90));
const poolSlotSeconds = Math.max(0, Number(process.env.CONNECTOR_ACCOUNT_SLOT_SECONDS ?? 1800));
const connectorStartDelayMs = Math.max(0, Number(process.env.CONNECTOR_START_DELAY_MS ?? 0));
const poolRetryDelayMs = Math.max(5_000, Number(process.env.CONNECTOR_POOL_RETRY_DELAY_MS ?? 10_000));
const connectorRole = (process.env.CONNECTOR_ROLE ?? "processing").trim().toLowerCase();
const onboardingOnly = poolEnabled && connectorRole === "onboarding" && directMode;
const connectorPoolSize = Math.max(1, Number(process.env.TG_CONNECTOR_POOL_SIZE ?? process.env.CONNECTOR_POOL_SIZE ?? 1));
const connectorOnboardingSlots = Math.max(1, Number(process.env.TG_ONBOARDING_SLOTS ?? process.env.CONNECTOR_ONBOARDING_SLOTS ?? 1));
const connectorSyncIntervalSeconds = Math.max(30, Number(process.env.CONNECTOR_SYNC_INTERVAL_SECONDS ?? 300));

const pool = new Pool({ connectionString: databaseUrl });
const sc = StringCodec();
let nc: NatsConnection;
let js: JetStreamClient;
let botInfo: TelegramUser | null = null;
let polling = false;
let lifecycleStatus: ConnectorLifecycleStatus = "starting";
let lastError: string | null = null;
let connectedAt: string | null = null;
let initialActivation = false;
let backfillCutoff = new Date(0);
let directClient: TelegramClient | null = null;
let directRuntimeStarted = false;
let directQr: string | null = null;
let directQrExpiresAt: number | null = null;
let directQrAuthPromise: Promise<void> | null = null;
const mediaRetryCounts = new Map<string, number>();
const directTopicGroups = new Map<string, Map<number, { groupId: string; title: string; topMessage: number }>>();
let groupRefreshTimer: NodeJS.Timeout | null = null;
let groupRefreshInProgress = false;
let accountLease: ConnectorAccountLease | null = null;
let logoutAccountId: string | null = null;
let accountRotationTimer: NodeJS.Timeout | null = null;
let onboardingRequest: ConnectorOnboardingRequest | null = null;
let onboardingPollTimer: NodeJS.Timeout | null = null;
let processingPollTimer: NodeJS.Timeout | null = null;
let processingAcquireInProgress = false;
let onboardingAcquireInProgress = false;
let accountUserIsAdmin = false;
let processingCycleFinished = false;
const sqlStore = pool as unknown as ConnectorSQLStore;

async function loadAccountRole(lease: ConnectorAccountLease) {
  const result = await pool.query<{ is_admin: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_roles
       WHERE user_id=$1::uuid AND role_name='admin'
     ) AS is_admin`,
    [lease.account.userId],
  );
  accountUserIsAdmin = Boolean(result.rows[0]?.is_admin);
}

async function destroyDirectClient() {
  const client = directClient;
  directClient = null;
  directRuntimeStarted = false;
  if (!client) return;
  try {
    // GramJS' disconnect() leaves its background update loop alive. A pool
    // cycle must destroy the client so its ping loop cannot reconnect after
    // the account lease was released and emit repeated TIMEOUT errors.
    await client.destroy();
  } catch (error) {
    console.warn("Telegram client shutdown failed", summarizeTelegramError(error));
  }
}

async function stopAfterLeaseLoss(expectedLease: ConnectorAccountLease, error: unknown) {
  if (accountLease !== expectedLease) return;
  accountLease = null;
  accountUserIsAdmin = false;
  directRuntimeStarted = false;
  directQrAuthPromise = null;
  if (accountRotationTimer) clearTimeout(accountRotationTimer);
  accountRotationTimer = null;
  await destroyDirectClient();
  await expectedLease.release().catch((releaseError) => console.warn("Telegram lease release after loss failed", releaseError));
  console.warn("Telegram worker stopped after losing its account lease", summarizeTelegramError(error));
}

async function initializePoolLease() {
  if (!poolEnabled || !directMode) return true;
  const preferredAccountId = (process.env.CONNECTOR_ACCOUNT_ID ?? "").trim() || undefined;
  const lease = await acquireConnectorAccount(sqlStore, "telegram", poolWorkerId, preferredAccountId, poolLeaseSeconds, {
    leaseKind: "processing",
    poolSize: connectorPoolSize,
    onboardingSlots: connectorOnboardingSlots,
  });
  if (!lease) {
    await setStatus("degraded", "Kein freies Telegram-Connector-Konto; Worker wartet auf eine Lease");
    return false;
  }
  accountLease = lease;
  logoutAccountId = null;
  await loadAccountRole(lease);
  lease.startRenewal((error) => void stopAfterLeaseLoss(lease, error));
  if (poolSlotSeconds > 0) {
    if (accountRotationTimer) clearTimeout(accountRotationTimer);
    accountRotationTimer = setTimeout(() => void rotatePoolAccount(), poolSlotSeconds * 1000);
    accountRotationTimer.unref?.();
  }
  await lease.setStatus("connecting");
  processingCycleFinished = false;
  console.log(`Telegram worker ${poolWorkerId} leased account ${lease.account.accountId} for ${lease.account.label}`);
  return true;
}

async function initializeOnboardingLease() {
  if (!onboardingOnly || !directMode || accountLease) return false;
  const request = await claimConnectorOnboardingRequest(sqlStore, "telegram", poolWorkerId);
  if (!request) return false;
  const lease = await acquireConnectorAccount(sqlStore, "telegram", poolWorkerId, request.accountId, poolLeaseSeconds, {
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
  logoutAccountId = null;
  await loadAccountRole(lease);
  // A user explicitly requested a new QR, so do not let an expired MTProto
  // session bypass the QR callback.
  await lease.saveSession(Buffer.from("", "utf8"));
  lease.startRenewal((error) => {
    if (accountLease === lease) void finishOnboarding("failed", error);
  });
  await lease.updateOnboardingRequest("claimed", null, request.id);
  await lease.setStatus("pairing");
  console.log(`Telegram onboarding worker ${poolWorkerId} handles account ${request.accountId}`);
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
    // Make the newly paired account eligible for the next processing-pool
    // cycle immediately instead of waiting on an old/null schedule value.
    await pool.query("UPDATE connector_accounts SET next_sync_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=$1::uuid", [lease.account.accountId]);
  }
  await destroyDirectClient();
  accountLease = null;
  accountUserIsAdmin = false;
  onboardingRequest = null;
  directQr = null;
  directQrExpiresAt = null;
  await lease.release().catch((releaseError) => console.warn("Telegram onboarding lease release failed", releaseError));
}

function startOnboardingPoller() {
  if (!onboardingOnly || onboardingPollTimer) return;
  const poll = () => {
    if (accountLease || onboardingAcquireInProgress) return;
    onboardingAcquireInProgress = true;
    void initializeOnboardingLease().then((claimed) => {
      if (claimed) return startDirectConnector();
    }).catch((error) => console.warn("Telegram onboarding poll failed", summarizeTelegramError(error)))
      .finally(() => { onboardingAcquireInProgress = false; });
  };
  onboardingPollTimer = setInterval(poll, Math.min(poolRetryDelayMs, 2_000));
  onboardingPollTimer.unref?.();
  poll();
}

function startProcessingPoller() {
  if (!poolEnabled || onboardingOnly || !directMode || processingPollTimer) return;
  processingPollTimer = setInterval(() => {
    if (accountLease || directRuntimeStarted || directQrAuthPromise || processingAcquireInProgress) return;
    processingAcquireInProgress = true;
    void initializePoolLease().then((ready) => {
      if (ready) return startDirectConnector().catch((error) => void setStatus("error", "Direct Telegram Initialisierung fehlgeschlagen", error));
      return undefined;
    }).catch((error) => console.warn("Telegram processing pool poll failed", summarizeTelegramError(error)))
      .finally(() => { processingAcquireInProgress = false; });
  }, poolRetryDelayMs);
  processingPollTimer.unref?.();
}

async function finishProcessingCycle() {
  if (!poolEnabled || onboardingOnly || !accountLease || processingCycleFinished) return;
  processingCycleFinished = true;
  const lease = accountLease;
  if (accountRotationTimer) clearTimeout(accountRotationTimer);
  accountRotationTimer = null;
  await lease.completeSync(new Date(Date.now() + connectorSyncIntervalSeconds * 1000)).catch((error) => console.warn("Telegram sync completion persistence failed", error));
  await destroyDirectClient();
  accountLease = null;
  accountUserIsAdmin = false;
  await lease.release().catch((error) => console.warn("Telegram processing lease release failed", error));
  console.log(`Telegram worker ${poolWorkerId} released account ${lease.account.accountId} after sync`);
}

async function rotatePoolAccount() {
  if (!poolEnabled || !accountLease || !directMode) return;
  const previousLease = accountLease;
  accountRotationTimer = null;
  lifecycleStatus = "stopped";
  await destroyDirectClient();
  accountLease = null;
  accountUserIsAdmin = false;
  await previousLease.setStatus("paused", null).catch(() => undefined);
  await previousLease.release().catch((error) => console.warn("Telegram account lease release failed", error));
  try {
    if (await initializePoolLease()) await startDirectConnector();
  } catch (error) {
    console.warn("Telegram account rotation failed", error);
  }
}

async function prepareInitialActivation() {
  const existing = await pool.query<{ initial_backfill_completed_at: string | null }>(
    "SELECT initial_backfill_completed_at FROM connector_states WHERE connector='telegram'",
  );
  initialActivation = !existing.rows[0] || !existing.rows[0].initial_backfill_completed_at;
  backfillCutoff = new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000);
  if (initialActivation) {
    await pool.query(
      `INSERT INTO connector_states (connector, status, first_activated_at, initial_backfill_started_at, initial_backfill_days)
       VALUES ('telegram', 'starting', NOW(), NOW(), $1)
       ON CONFLICT (connector) DO UPDATE SET initial_backfill_started_at=COALESCE(connector_states.initial_backfill_started_at, NOW()), initial_backfill_days=$1, updated_at=NOW()`,
      [backfillDays],
    );
  }
}

async function completeInitialActivation() {
  if (!initialActivation) return;
  await pool.query("UPDATE connector_states SET initial_backfill_completed_at=NOW(), updated_at=NOW() WHERE connector='telegram'");
  initialActivation = false;
}

async function setStatus(status: ConnectorLifecycleStatus, detail?: string, error?: unknown) {
  lifecycleStatus = status;
  lastError = error ? String(error) : (status === "error" || status === "reauth_required" ? lastError : null);
  if (accountLease) await accountLease.setStatus(status, lastError).catch((dbError) => console.warn("connector account status persistence failed", dbError));
  await pool.query(
    `INSERT INTO connector_states (connector, status, detail, last_error, connected_at)
     VALUES ('telegram', $1, $2, $3, $4)
     ON CONFLICT (connector) DO UPDATE SET status=EXCLUDED.status, detail=EXCLUDED.detail,
       last_error=EXCLUDED.last_error, connected_at=EXCLUDED.connected_at, updated_at=NOW()`,
    [status, detail ?? null, lastError, connectedAt],
  ).catch((dbError) => console.warn("connector status persistence failed", dbError));
  if (js) await publish(subjects.connectorStatus, subjects.connectorStatus, { connector: "telegram", status, detail, lastError: lastError ?? undefined, connectedAt: connectedAt ?? undefined });
}

type TelegramChatType = "private" | "group" | "supergroup" | "channel";

type TelegramChat = {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

type TelegramPhotoSize = { file_id: string; width: number; height: number; file_size?: number };
type TelegramAudio = { file_id: string; duration: number; mime_type?: string; file_size?: number };
type TelegramVoice = { file_id: string; duration: number; mime_type?: string; file_size?: number };
type TelegramDocument = { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
type TelegramVideo = { file_id: string; width: number; height: number; duration: number; mime_type?: string; file_size?: number };

type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  caption?: string;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  photo?: TelegramPhotoSize[];
  video?: TelegramVideo;
  document?: TelegramDocument;
  location?: { latitude: number; longitude: number; horizontal_accuracy?: number; live_period?: number };
  reply_to_message?: TelegramMessage;
  new_chat_title?: string;
  left_chat_member?: TelegramUser;
  new_chat_member?: TelegramUser;
};

type TelegramChatMemberUpdate = { chat: TelegramChat; from: TelegramUser; date: number; new_chat_member?: { status: string; is_member?: boolean; user: TelegramUser } };
type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdate;
  chat_member?: TelegramChatMemberUpdate;
};

type TelegramResponse<T> = { ok: boolean; result: T; description?: string; error_code?: number };

function envelope<T>(type: EventEnvelope<T>["type"], data: T): EventEnvelope<T> {
  return { id: randomUUID(), type, occurredAt: new Date().toISOString(), source: "tg-connector", data };
}

async function publish<T>(subject: string, type: EventEnvelope<T>["type"], data: T) {
  await js.publish(subject, sc.encode(JSON.stringify(envelope(type, data))));
}

async function cleanupDetachedEventRecords(groupIds: string[]) {
  if (!groupIds.length) return;
  const messages = await pool.query<{ id: string }>(
    "SELECT id::text FROM messages WHERE group_id=ANY($1::text[])",
    [groupIds],
  );
  const messageIds = messages.rows.map((row) => row.id);
  const eventScope = `
    (payload #>> '{data,groupId}') = ANY($1::text[])
    OR (payload #>> '{data,group_id}') = ANY($1::text[])
    OR (payload #>> '{data,event,data,groupId}') = ANY($1::text[])
    OR (payload #>> '{data,event,data,group_id}') = ANY($1::text[])
    OR (payload #>> '{data,messageId}') = ANY($2::text[])
    OR (payload #>> '{data,message_id}') = ANY($2::text[])
    OR (payload #>> '{data,event,data,messageId}') = ANY($2::text[])
    OR (payload #>> '{data,event,data,message_id}') = ANY($2::text[])`;
  await pool.query(`DELETE FROM event_inbox WHERE ${eventScope}`, [groupIds, messageIds]);
  await pool.query(`DELETE FROM event_failures WHERE ${eventScope}`, [groupIds, messageIds]);
}

async function cleanupRemovedGroups(platform: "whatsapp" | "telegram", groupIds: string[]) {
  const uniqueIds = [...new Set(groupIds.filter(Boolean))];
  if (!uniqueIds.length) return;
  const ownerUserId = accountLease?.account.userId;
  if (ownerUserId) {
    const deletable = await pool.query<{ id: string }>(
      `SELECT g.id
       FROM wa_groups g
       WHERE g.platform=$1 AND g.id=ANY($2::text[])
         AND NOT EXISTS (
           SELECT 1 FROM user_group_access other
           WHERE other.group_id=g.id AND other.user_id<>$3::uuid
         )`,
      [platform, uniqueIds, ownerUserId],
    );
    const deletableIds = deletable.rows.map((row) => row.id);
    if (deletableIds.length) {
      if (!mediaCleanupToken) throw new Error("MEDIA_CLEANUP_TOKEN fehlt; Gruppenbereinigung wird abgebrochen");
      const response = await nc.request(
        "internal.groups.cleanup.requested",
        sc.encode(JSON.stringify({ token: mediaCleanupToken, platform, groupIds: deletableIds })),
        { timeout: 30_000 },
      );
      const result = JSON.parse(sc.decode(response.data)) as { ok?: boolean; error?: string };
      if (!result.ok) throw new Error(result.error ?? "Medienbereinigung fehlgeschlagen");
    }
    await cleanupDetachedEventRecords(deletableIds);
    await pool.query("DELETE FROM user_group_access WHERE user_id=$1::uuid AND group_id=ANY($2::text[])", [ownerUserId, uniqueIds]);
    await pool.query("DELETE FROM connector_cursors WHERE account_id=$1::uuid AND group_id=ANY($2::text[])", [accountLease?.account.accountId, uniqueIds]);
    await pool.query("DELETE FROM wa_groups g WHERE g.platform=$1 AND g.id=ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM user_group_access uga WHERE uga.group_id=g.id)", [platform, uniqueIds]);
  } else {
    if (!mediaCleanupToken) throw new Error("MEDIA_CLEANUP_TOKEN fehlt; Gruppenbereinigung wird abgebrochen");
    const response = await nc.request(
      "internal.groups.cleanup.requested",
      sc.encode(JSON.stringify({ token: mediaCleanupToken, platform, groupIds: uniqueIds })),
      { timeout: 30_000 },
    );
    const result = JSON.parse(sc.decode(response.data)) as { ok?: boolean; error?: string };
    if (!result.ok) throw new Error(result.error ?? "Medienbereinigung fehlgeschlagen");
    await cleanupDetachedEventRecords(uniqueIds);
    await pool.query("DELETE FROM wa_groups WHERE platform=$1 AND id=ANY($2::text[])", [platform, uniqueIds]);
  }
  console.log(`Removed ${uniqueIds.length} departed ${platform} group(s) from the current account snapshot`);
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

async function telegramApi<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!botToken) throw new Error("TG_BOT_TOKEN ist nicht gesetzt");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as TelegramResponse<T>;
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram Bot API ${method} fehlgeschlagen: ${payload.description ?? response.statusText}`);
  }
  return payload.result;
}

async function loadDirectSession() {
  if (accountLease) {
    const stored = await accountLease.loadSession();
    if (stored) return stored.toString("utf8");
  }
  if (directSession) return directSession;
  try { return (await readFile(directSessionPath, "utf8")).trim(); } catch { return ""; }
}

function createDirectClient(session: string) {
  return new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries,
    requestRetries,
    downloadRetries,
    retryDelay,
    timeout: 20,
    autoReconnect: true,
    maxConcurrentDownloads: 1,
  });
}

function summarizeTelegramError(error: unknown) {
  const value = error as { code?: unknown; errorMessage?: unknown; message?: unknown };
  return [value.code, value.errorMessage, value.message].filter(Boolean).map(String).join(": ") || String(error);
}

function isRetryableTelegramError(error: unknown) {
  const summary = summarizeTelegramError(error).toLowerCase();
  return summary.includes("timeout") || summary.includes("-503") || summary.includes("connection") || summary.includes("disconnected") || summary.includes("network") || summary.includes("websocket");
}

async function retryTelegramOperation<T>(label: string, operation: () => Promise<T>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= mediaRetryAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableTelegramError(error) || attempt >= mediaRetryAttempts) throw error;
      console.warn(`${label} fehlgeschlagen (${attempt}/${mediaRetryAttempts}); neuer Versuch`, summarizeTelegramError(error));
      await delay(retryDelay * attempt);
    }
  }
  throw lastError ?? new Error(`${label} fehlgeschlagen`);
}

async function saveDirectSession() {
  if (!directClient) return;
  const value = (directClient.session as StringSession).save();
  if (accountLease) {
    await accountLease.saveSession(Buffer.from(value, "utf8"));
    return;
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(directSessionPath, value, "utf8");
}

async function upsertDirectGroup(entity: any) {
  const chatId = String(entity.id);
  const groupId = `tg:${chatId}`;
  const username = entity.username ? String(entity.username) : undefined;
  const allowlisted = allowlist.has(chatId) || allowlist.has(groupId) || Boolean(username && (allowlist.has(username) || allowlist.has(`@${username}`)));
  const chatType: "group" | "supergroup" | "channel" = entity.className === "Channel" ? (entity.broadcast ? "channel" : "supergroup") : "group";
  const group: GroupDiscovered = { groupId, subject: String(entity.title ?? entity.username ?? groupId), ownerJid: `tg:direct:${chatId}`, participantCount: Number(entity.participantsCount ?? 0), isSelected: allowlisted, platform: "telegram", chatType };
  const ownerUserId = accountLease?.account.userId ?? null;
  await pool.query(
    `INSERT INTO wa_groups (id, subject, owner_jid, participant_count, is_selected, platform, chat_type, external_chat_id, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, 'telegram', $6, $1, $7)
     ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, owner_jid = EXCLUDED.owner_jid,
       participant_count = EXCLUDED.participant_count, platform = 'telegram', chat_type = EXCLUDED.chat_type,
       external_chat_id = EXCLUDED.external_chat_id, owner_user_id = COALESCE(wa_groups.owner_user_id, EXCLUDED.owner_user_id), updated_at = NOW()`,
    [group.groupId, group.subject, group.ownerJid, group.participantCount ?? 0, group.isSelected, chatType, ownerUserId],
  );
  if (ownerUserId) await pool.query(`INSERT INTO user_group_access (user_id,group_id,can_read,can_manage,is_selected) VALUES ($1::uuid,$2,TRUE,TRUE,$3) ON CONFLICT (user_id,group_id) DO NOTHING`, [ownerUserId, group.groupId, group.isSelected]);
  const result = await pool.query<{ is_selected: boolean }>(
    accountUserIsAdmin
      ? `SELECT g.is_selected FROM wa_groups g WHERE g.id=$1`
      : `SELECT COALESCE(uga.is_selected,FALSE) AS is_selected FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`,
    accountUserIsAdmin ? [group.groupId] : [group.groupId, ownerUserId],
  );
  const selected = result.rows[0]?.is_selected ?? group.isSelected;
  await publish(subjects.groupDiscovered, subjects.groupDiscovered, { ...group, isSelected: selected });
  return { groupId, selected, chatType };
}

function directTopicGroupId(entity: any, topicId: number) {
  return `tg:${String(entity.id)}:topic:${topicId}`;
}

async function upsertDirectTopic(entity: any, topic: { id: number; title?: string; topMessage?: number }) {
  const parentGroupId = `tg:${String(entity.id)}`;
  const topicId = Number(topic.id);
  const groupId = directTopicGroupId(entity, topicId);
  const title = String(topic.title || `Topic ${topicId}`);
  const group: GroupDiscovered = {
    groupId,
    subject: `${String(entity.title ?? parentGroupId)} · ${title}`,
    ownerJid: `tg:direct:${entity.id}:topic:${topicId}`,
    participantCount: Number(entity.participantsCount ?? 0),
    isSelected: allowlist.has(groupId) || allowlist.has(`${entity.id}:topic:${topicId}`),
    platform: "telegram",
    chatType: "topic",
    parentGroupId,
    topicId: String(topicId),
  };
  const ownerUserId = accountLease?.account.userId ?? null;
  await pool.query(
    `INSERT INTO wa_groups (id, subject, owner_jid, participant_count, is_selected, platform, chat_type, external_chat_id, parent_group_id, topic_id, topic_root_message_id)
     VALUES ($1, $2, $3, $4, $5, 'telegram', 'topic', $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, owner_jid = EXCLUDED.owner_jid,
       participant_count = EXCLUDED.participant_count, platform = 'telegram', chat_type = 'topic',
       external_chat_id = EXCLUDED.external_chat_id, parent_group_id = EXCLUDED.parent_group_id,
       topic_id = EXCLUDED.topic_id, topic_root_message_id = EXCLUDED.topic_root_message_id, updated_at = NOW()`,
    [groupId, group.subject, group.ownerJid, group.participantCount ?? 0, group.isSelected, `${entity.id}:${topicId}`, parentGroupId, topicId, Number(topic.topMessage ?? 0) || null],
  );
  if (ownerUserId) await pool.query(`INSERT INTO user_group_access (user_id,group_id,can_read,can_manage,is_selected) VALUES ($1::uuid,$2,TRUE,TRUE,$3) ON CONFLICT (user_id,group_id) DO NOTHING`, [ownerUserId, group.groupId, group.isSelected]);
  const result = await pool.query<{ is_selected: boolean }>(
    accountUserIsAdmin
      ? `SELECT g.is_selected FROM wa_groups g WHERE g.id=$1`
      : `SELECT COALESCE(uga.is_selected,FALSE) AS is_selected FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`,
    accountUserIsAdmin ? [group.groupId] : [group.groupId, ownerUserId],
  );
  const selected = result.rows[0]?.is_selected ?? group.isSelected;
  await publish(subjects.groupDiscovered, subjects.groupDiscovered, { ...group, isSelected: selected });
  return { groupId, selected, chatType: "topic" as const, parentGroupId, topicId };
}

async function discoverDirectTopics(entity: any): Promise<boolean> {
  if (!directClient || entity?.className !== "Channel" || !entity.forum) return true;
  const parentGroupId = `tg:${String(entity.id)}`;
  const topicGroups = new Map<number, { groupId: string; title: string; topMessage: number }>();
  try {
    let offsetTopic = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await directClient.invoke(new Api.channels.GetForumTopics({
        channel: entity,
        offsetDate: 0,
        offsetId: 0,
        offsetTopic,
        limit: 100,
      }));
      const topics = (result as any).topics ?? [];
      for (const topic of topics) {
        const topicId = Number(topic.id);
        if (!Number.isFinite(topicId)) continue;
        const title = String(topic.title || `Topic ${topicId}`);
        topicGroups.set(topicId, { groupId: directTopicGroupId(entity, topicId), title, topMessage: Number(topic.topMessage ?? 0) });
        await upsertDirectTopic(entity, { id: topicId, title, topMessage: Number(topic.topMessage ?? 0) });
      }
      const nextOffset = Number(topics.at(-1)?.id ?? 0);
      if (topics.length < 100 || !nextOffset || nextOffset === offsetTopic) break;
      offsetTopic = nextOffset;
    }
    directTopicGroups.set(parentGroupId, topicGroups);
    return true;
  } catch (error) {
    console.warn("Telegram forum topic discovery failed", parentGroupId, summarizeTelegramError(error));
    return false;
  }
}

function directTopicIdFromMessage(message: any, entity: any) {
  if (entity?.className !== "Channel" || !entity.forum) return undefined;
  const reply = message.replyTo;
  const explicitTopicId = Number(reply?.replyToTopId ?? 0);
  if (Number.isFinite(explicitTopicId) && explicitTopicId > 0) return explicitTopicId;
  const topics = directTopicGroups.get(`tg:${String(entity.id)}`);
  const byRoot = [...(topics?.entries() ?? [])].find(([, topic]) => topic.topMessage === Number(message.id));
  return byRoot?.[0];
}

function directMessageKind(message: any): WhatsAppMessageReceived["kind"] {
  const mediaClass = message.media?.className;
  const mime = String(message.media?.document?.mimeType ?? "");
  if (mediaClass === "MessageMediaGeo" || mediaClass === "MessageMediaGeoLive") return "location";
  if (mediaClass === "MessageMediaPhoto") return "image";
  if (mediaClass === "MessageMediaDocument") {
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    return "document";
  }
  return message.message ? "text" : "system";
}

function directMessageText(message: any) {
  if (message.media?.geo) return `Ort: ${message.media.geo.lat}, ${message.media.geo.long}`;
  return typeof message.message === "string" ? message.message : undefined;
}

function directTimestamp(value: unknown) {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  return Math.floor(Date.now() / 1000);
}

async function downloadDirectMedia(message: any, mediaKey: string, kind: string) {
  if (!message.media) return undefined;
  const content = await retryTelegramOperation(`Direct Telegram media download ${mediaKey}`, async () => {
    await ensureDirectConnection();
    if (!directClient) throw new Error("Telegram-Client ist nicht verfügbar");
    return directClient.downloadMedia(message, {});
  });
  if (!content) return undefined;
  const safeName = mediaKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const mime = String(message.media?.document?.mimeType ?? (kind === "image" ? "image/jpeg" : "application/octet-stream"));
  const extension = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  const objectPath = join(mediaDir, "incoming", `${safeName}.${extension}`);
  await mkdir(join(mediaDir, "incoming"), { recursive: true });
  await writeFile(objectPath, Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
  return { objectPath, mediaMime: mime };
}

function scheduleDirectMediaRetry(message: any, entity: any, mediaKey: string) {
  const retryCount = (mediaRetryCounts.get(mediaKey) ?? 0) + 1;
  if (retryCount > mediaRetryAttempts) return;
  mediaRetryCounts.set(mediaKey, retryCount);
  setTimeout(() => {
    void persistDirectMessage(message, entity).catch((error) => {
      console.warn("Direct Telegram media retry failed", mediaKey, summarizeTelegramError(error));
    });
  }, retryDelay * retryCount * 2);
}

async function persistDirectMessage(message: any, entity: any) {
  if (onboardingOnly) return;
  if (entity?.className === "Channel" && entity.forum && !directTopicGroups.has(`tg:${String(entity.id)}`)) {
    await discoverDirectTopics(entity);
  }
  const topicId = directTopicIdFromMessage(message, entity);
  const topic = topicId ? directTopicGroups.get(`tg:${String(entity.id)}`)?.get(topicId) : undefined;
  const group = topic
    ? await upsertDirectTopic(entity, { id: topicId!, title: topic.title, topMessage: topic.topMessage })
    : await upsertDirectGroup(entity);
  if (!group.selected) return;
  const timestamp = directTimestamp(message.date);
  if (new Date(timestamp * 1000) < backfillCutoff) return;
  const groupId = group.groupId;
  const waMessageId = `${groupId}:${message.id}`;
  const kind = directMessageKind(message);
  const mediaKey = ["audio", "image", "video", "document"].includes(kind) ? `telegram-direct/${entity.id}/${message.id}` : undefined;
  let downloaded: { objectPath: string; mediaMime: string } | undefined;
  if (mediaKey) {
    try {
      downloaded = await downloadDirectMedia(message, mediaKey, kind);
      if (downloaded) mediaRetryCounts.delete(mediaKey);
    } catch (error) {
      console.warn("Direct Telegram media download failed; Nachricht bleibt pending", mediaKey, summarizeTelegramError(error));
      scheduleDirectMediaRetry(message, entity, mediaKey);
    }
  }
  const text = directMessageText(message);
  const raw = { id: message.id, date: timestamp, message: text, location: message.media?.geo ? { latitude: Number(message.media.geo.lat), longitude: Number(message.media.geo.long) } : undefined, reply_to_message: message.replyTo?.replyToMsgId ? { message_id: Number(message.replyTo.replyToMsgId) } : undefined };
  const contentHash = createHash("sha256").update(JSON.stringify({ groupId, waMessageId, kind, text, raw })).digest("hex");
  const existing = await pool.query<{ id: string; content_hash: string | null; media_status: string | null }>("SELECT id, content_hash, media_status FROM messages WHERE group_id=$1 AND wa_message_id=$2", [groupId, waMessageId]);
  if (existing.rows[0]?.content_hash === contentHash && (!mediaKey || existing.rows[0].media_status === "completed")) return;
  const sender = await message.getSender?.();
  const senderJid = `tg:user:${String(message.senderId ?? sender?.id ?? "unknown")}`;
  const senderName = sender ? [sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username : undefined;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, wa_message_id, platform, external_chat_id, sender_jid, sender_name, kind, text, received_at, has_media, media_key, media_mime, raw, content_hash, sequence_no, media_status)
     VALUES ($1,$2,'telegram',$1,$3,$4,$5,$6,to_timestamp($7),$8,$9,$10,$11,$12,$7,$13)
     ON CONFLICT (group_id, wa_message_id) DO UPDATE SET sender_jid=EXCLUDED.sender_jid, sender_name=EXCLUDED.sender_name, kind=EXCLUDED.kind, text=EXCLUDED.text, received_at=EXCLUDED.received_at, has_media=EXCLUDED.has_media, media_key=EXCLUDED.media_key, media_mime=EXCLUDED.media_mime, raw=EXCLUDED.raw, content_hash=EXCLUDED.content_hash, sequence_no=EXCLUDED.sequence_no, media_status=CASE WHEN EXCLUDED.media_status='completed' THEN 'completed' ELSE messages.media_status END
     RETURNING id`,
    [groupId, waMessageId, senderJid, senderName ?? null, kind, text ?? null, timestamp, Boolean(mediaKey), mediaKey ?? null, downloaded?.mediaMime ?? null, raw, contentHash, mediaKey ? (downloaded ? "completed" : "pending") : "none"],
  );
  const messageId = result.rows[0].id;
  const data: WhatsAppMessageReceived = { messageId, waMessageId, groupId, platform: "telegram", chatType: group.chatType, externalChatId: String(entity.id), senderJid, senderName, kind, text, receivedAt: new Date(timestamp * 1000).toISOString(), hasMedia: Boolean(mediaKey), mediaKey, mediaMime: downloaded?.mediaMime, mediaObjectPath: downloaded?.objectPath, replyToWaMessageId: message.replyTo?.replyToMsgId ? `${groupId}:${message.replyTo.replyToMsgId}` : undefined, raw, changeType: existing.rows[0] ? "updated" : "created", sequenceNo: timestamp };
  await publish(subjects.messageReceived, subjects.messageReceived, data);
  if (mediaKey && downloaded?.objectPath) await publish(subjects.mediaRequested, subjects.mediaRequested, { messageId, mediaKey, objectPath: downloaded.objectPath, mediaMime: downloaded.mediaMime, kind, platform: "telegram" });
  if (kind === "audio" && mediaKey && downloaded?.objectPath) {
    const job = await pool.query<{ id: string }>("SELECT id FROM audio_jobs WHERE message_id=$1 ORDER BY created_at DESC LIMIT 1", [messageId]);
    const jobId = job.rows[0]?.id ?? randomUUID();
    if (!job.rows[0]) await pool.query("INSERT INTO audio_jobs (id,message_id,media_key,media_mime,object_path) VALUES ($1,$2,$3,$4,$5)", [jobId, messageId, mediaKey, downloaded.mediaMime, downloaded.objectPath]);
    else await pool.query("UPDATE audio_jobs SET media_mime=$1, object_path=$2, updated_at=NOW() WHERE id=$3", [downloaded.mediaMime, downloaded.objectPath, jobId]);
    await publish(subjects.audioRequested, subjects.audioRequested, { jobId, messageId, mediaKey, mediaMime: downloaded?.mediaMime, objectPath: downloaded?.objectPath });
  }
  if (accountLease) await accountLease.saveCursor(groupId, { externalMessageId: String(message.id), receivedAt: new Date(timestamp * 1000).toISOString(), sequenceNo: Number(message.id) });
}

function isDepartedDirectEntity(entity: any) {
  return entity?.className === "ChatForbidden"
    || entity?.className === "ChannelForbidden"
    || entity?.left === true
    || entity?.kicked === true
    || entity?.deactivated === true;
}

function isDepartedDirectDialog(dialog: any, entity: any) {
  return isDepartedDirectEntity(entity)
    || dialog?.left === true
    || dialog?.kicked === true
    || dialog?.deactivated === true
    || dialog?.entity?.left === true
    || dialog?.entity?.kicked === true
    || dialog?.entity?.deactivated === true;
}

function isDirectGroupEntity(entity: any) {
  return (entity?.className === "Chat" || entity?.className === "Channel") && !isDepartedDirectEntity(entity);
}

async function discoverDirectGroups() {
  if (!directClient) return;
  if (groupRefreshInProgress) return;
  groupRefreshInProgress = true;
  try {
    const presentIds = new Set<string>();
    directTopicGroups.clear();
    const iterator = (directClient as any).iterDialogs?.({});
    if (!iterator || typeof iterator[Symbol.asyncIterator] !== "function") throw new Error("Telegram liefert keine vollständige Dialogliste");
    for await (const dialog of iterator) {
      const entity = dialog?.entity;
      if (!isDirectGroupEntity(entity) || isDepartedDirectDialog(dialog, entity)) continue;
      const group = await upsertDirectGroup(entity);
      presentIds.add(group.groupId);
      if (!await discoverDirectTopics(entity)) throw new Error(`Telegram-Topics für ${group.groupId} konnten nicht vollständig gelesen werden`);
      for (const topic of directTopicGroups.get(group.groupId)?.values() ?? []) presentIds.add(topic.groupId);
    }
    const stored = await pool.query<{ id: string }>(
      `SELECT DISTINCT g.id
       FROM wa_groups g
       LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid
       WHERE g.platform='telegram'
         AND (g.owner_user_id=$1::uuid OR uga.user_id IS NOT NULL)`,
      [accountLease?.account.userId ?? null],
    );
    const stale = stored.rows.map((row) => row.id).filter((id) => !presentIds.has(id));
    if (stale.length) console.log(`Telegram group snapshot found ${stale.length} departed group/topic(s)`);
    await cleanupRemovedGroups("telegram", stale);
  } finally {
    groupRefreshInProgress = false;
  }
}

function startGroupRefreshTimer() {
  if (groupRefreshTimer) return;
  groupRefreshTimer = setInterval(() => {
    if (directRuntimeStarted && directClient?.connected) {
      void discoverDirectGroups().catch((error) => console.warn("Telegram group refresh failed", summarizeTelegramError(error)));
    }
  }, groupRefreshIntervalMs);
  groupRefreshTimer.unref?.();
}

async function backfillDirectGroup(groupId: string) {
  if (!directClient || !directRuntimeStarted) return;
  const match = groupId.match(/^tg:([^:]+)(?::topic:(\d+))?$/);
  if (!match) return;
  const entity = await directClient.getEntity(Number(match[1]));
  if (!isDirectGroupEntity(entity)) return;
  await discoverDirectTopics(entity);
  const topicId = match[2] ? Number(match[2]) : undefined;
  const topic = topicId ? directTopicGroups.get(`tg:${String(entity.id)}`)?.get(topicId) : undefined;
  const group = topic
    ? await upsertDirectTopic(entity, { id: topicId!, title: topic.title, topMessage: topic.topMessage })
    : await upsertDirectGroup(entity);
  if (!group.selected) return;
  const cursor = accountLease ? await accountLease.loadCursor(groupId) : null;
  const minimumMessageId = cursor?.externalMessageId ? Number(cursor.externalMessageId) : undefined;
  for await (const message of directClient.iterMessages(entity, { limit: 500, minId: minimumMessageId })) {
    if (directTimestamp(message.date) < Math.floor(backfillCutoff.getTime() / 1000)) break;
    if (topicId && directTopicIdFromMessage(message, entity) !== topicId) continue;
    await persistDirectMessage(message, entity);
    await delay(backfillThrottleMs);
  }
}

async function handleGroupSelection(data: GroupSelectionChanged) {
  if (data.platform && data.platform !== "telegram") return;
  if (!data.groupId.startsWith("tg:")) return;
  await pool.query("UPDATE user_group_access SET is_selected=$1 WHERE user_id=$3::uuid AND group_id=$2", [data.selected, data.groupId, accountLease?.account.userId ?? null]);
  if (data.selected) {
    await delay(backfillGroupDelayMs);
    try { await backfillDirectGroup(data.groupId); } catch (error) { console.warn("Telegram selected-group backfill failed", data.groupId, error); }
  }
}

function subscribeGroupSelections() {
  const subscription = nc.subscribe(subjects.groupSelectionChanged);
  void (async () => {
    for await (const message of subscription) {
      try {
        const envelope = JSON.parse(sc.decode(message.data)) as { data?: GroupSelectionChanged };
        if (envelope.data) await handleGroupSelection(envelope.data);
      } catch (error) {
        console.warn("Telegram group selection event failed", error);
      }
    }
  })();
}

async function stopCurrentAccountForLogout(accountId: string) {
  const lease = accountLease;
  if (!lease || lease.account.accountId !== accountId) return false;
  logoutAccountId = accountId;
  lifecycleStatus = "stopped";
  lastError = null;
  directQr = null;
  directQrExpiresAt = null;
  directQrAuthPromise = null;
  if (accountRotationTimer) clearTimeout(accountRotationTimer);
  accountRotationTimer = null;
  onboardingRequest = null;
  await destroyDirectClient();
  accountLease = null;
  accountUserIsAdmin = false;
  await lease.release().catch((error) => console.warn("Telegram logout lease release failed", error));
  return true;
}

function subscribeConnectorLogout() {
  const subscription = nc.subscribe("internal.connector.logout.requested");
  void (async () => {
    for await (const message of subscription) {
      try {
        const payload = JSON.parse(sc.decode(message.data)) as { token?: string; platform?: string; accountId?: string };
        if (!mediaCleanupToken || payload.token !== mediaCleanupToken || payload.platform !== "telegram" || !payload.accountId) continue;
        const matched = await stopCurrentAccountForLogout(payload.accountId);
        if (matched) await message.respond(sc.encode(JSON.stringify({ ok: true, platform: "telegram", accountId: payload.accountId })));
      } catch (error) {
        console.warn("Telegram connector logout request failed", summarizeTelegramError(error));
      }
    }
  })();
}

async function backfillSelectedDirectGroups() {
  const selected = await pool.query<{ id: string }>(
    accountUserIsAdmin
      ? "SELECT g.id FROM wa_groups g WHERE g.platform='telegram' AND g.is_selected=TRUE ORDER BY g.subject"
      : "SELECT g.id FROM wa_groups g JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$1::uuid WHERE g.platform='telegram' AND uga.is_selected=TRUE ORDER BY g.subject",
    accountUserIsAdmin ? [] : [accountLease?.account.userId ?? null],
  );
  console.log(`Telegram worker ${poolWorkerId} backfills ${selected.rows.length} selected group(s) for ${accountLease?.account.label ?? "account"}`);
  for (const [index, group] of selected.rows.entries()) {
    if (index > 0) await delay(backfillGroupDelayMs);
    try { await backfillDirectGroup(group.id); } catch (error) { console.warn("Telegram selected-group startup backfill failed", group.id, error); }
  }
}

async function startDirectRuntime() {
  if (!directClient || directRuntimeStarted) return;
  directRuntimeStarted = true;
  await setStatus("syncing", `${initialActivation ? "Erst-" : "Neustart-"}Backfill der letzten ${backfillDays} Tage läuft (gedrosselt)`);
  directClient.addEventHandler(async (event: any) => {
    try {
      const message = event.message;
      const entity = await message.getChat();
      if (isDirectGroupEntity(entity)) await persistDirectMessage(message, entity);
    } catch (error) { console.error("Direct Telegram update failed", error); }
  }, new NewMessage({ incoming: true }));
  await discoverDirectGroups();
  startGroupRefreshTimer();
  if (!onboardingOnly) await backfillSelectedDirectGroups();
  if (onboardingOnly) {
    if (accountLease) await accountLease.updateOnboardingRequest("connected", null, onboardingRequest?.id);
    await delay(500);
    await finishOnboarding();
    return;
  }
  await completeInitialActivation();
  connectedAt = new Date().toISOString();
  await setStatus("ready", "Direct Telegram verbunden");
  await finishProcessingCycle();
}

async function ensureDirectConnection() {
  if (!directClient) {
    directClient = createDirectClient(await loadDirectSession());
  }
  if (directClient.connected) return;
  const connected = await directClient.connect();
  if (!connected || !directClient.connected) {
    throw new Error("Telegram-Verbindung konnte nicht aufgebaut werden");
  }
}

async function startDirectConnector() {
  if (logoutAccountId && accountLease?.account.accountId === logoutAccountId) return;
  // A previous failed pool attempt may have left a client object behind.
  // Never replace it without destroying its background update loop first.
  if (directClient) await destroyDirectClient();
  const session = await loadDirectSession();
  directClient = createDirectClient(session);
  if (session) {
    await ensureDirectConnection();
    if (await directClient.checkAuthorization()) { await startDirectRuntime(); return; }
  }
  if (onboardingOnly) {
    await beginDirectQrAuth();
    return;
  }
  await setStatus("reauth_required", "Keine gültige Direct-Telegram-Session. Session einmalig mit `npm run auth --workspace=@wagi/tg-connector` erzeugen.");
}

async function beginDirectQrAuth() {
  if (!directMode) throw new Error("TG_API_ID und TG_API_HASH sind für den Direct-Telegram-QR erforderlich");
  await ensureDirectConnection();
  if (!directClient) throw new Error("Telegram-Client wurde nicht initialisiert");
  const client = directClient;
  if (await client.checkAuthorization()) { await startDirectRuntime(); return; }
  if (directQrAuthPromise) return;
  lastError = null;
  directQrAuthPromise = client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      qrCode: async ({ token, expires }) => {
        directQr = `tg://login?token=${token.toString("base64url")}`;
        directQrExpiresAt = expires > 10_000_000_000 ? expires : expires * 1000;
        if (onboardingOnly && accountLease) await accountLease.updateQR({ status: "qr", qrPayload: directQr, expiresAt: new Date(directQrExpiresAt), workerId: poolWorkerId });
        await setStatus("pairing", "Telegram-QR mit der mobilen Telegram-App scannen");
      },
      password: async () => { throw new Error("DIRECT_TELEGRAM_2FA_REQUIRED: QR-Anmeldung benötigt das 2FA-Passwort; nutze einmalig den lokalen Auth-Befehl."); },
      onError: async (error) => { lastError = String(error); return true; },
    },
  ).then(async () => {
    if (onboardingOnly && accountLease) await accountLease.updateQR({ status: "connected", qrPayload: null, expiresAt: null, workerId: poolWorkerId });
    directQr = null;
    directQrExpiresAt = null;
    await saveDirectSession();
    await startDirectRuntime();
  }).catch(async (error) => {
    directQr = null;
    directQrExpiresAt = null;
    if (onboardingOnly) await finishOnboarding("failed", error);
    await setStatus("error", String(error).includes("DIRECT_TELEGRAM_2FA_REQUIRED") ? "Telegram-QR wurde gescannt, aber 2FA erfordert den lokalen Auth-Befehl" : "Telegram-QR-Anmeldung fehlgeschlagen", error);
  }).finally(() => { directQrAuthPromise = null; });
}

function normalizedChatId(chatId: number) {
  return `tg:${chatId}`;
}

function chatSubject(chat: TelegramChat) {
  return chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || normalizedChatId(chat.id));
}

function isTargetChat(chat: TelegramChat): chat is TelegramChat & { type: "group" | "supergroup" | "channel" } {
  return chat.type === "group" || chat.type === "supergroup" || chat.type === "channel";
}

function isSelected(chat: TelegramChat) {
  return allowlist.has(String(chat.id)) || allowlist.has(normalizedChatId(chat.id)) || (chat.username ? allowlist.has(`@${chat.username}`) || allowlist.has(chat.username) : false);
}

async function upsertGroup(chat: TelegramChat) {
  if (!isTargetChat(chat)) return;
  const group: GroupDiscovered = {
    groupId: normalizedChatId(chat.id),
    subject: chatSubject(chat),
    ownerJid: `tg:chat:${chat.id}`,
    isSelected: isSelected(chat),
    platform: "telegram",
    chatType: chat.type,
  };
  const ownerUserId = accountLease?.account.userId ?? null;
  await pool.query(
    `INSERT INTO wa_groups (id, subject, owner_jid, participant_count, is_selected, platform, chat_type, external_chat_id, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, 'telegram', $6, $1, $7)
     ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, owner_jid = EXCLUDED.owner_jid,
       platform = 'telegram', chat_type = EXCLUDED.chat_type, external_chat_id = EXCLUDED.external_chat_id, owner_user_id = COALESCE(wa_groups.owner_user_id, EXCLUDED.owner_user_id), updated_at = NOW()`,
    [group.groupId, group.subject, group.ownerJid, 0, group.isSelected, group.chatType, ownerUserId],
  );
  if (ownerUserId) await pool.query(`INSERT INTO user_group_access (user_id,group_id,can_read,can_manage,is_selected) VALUES ($1::uuid,$2,TRUE,TRUE,$3) ON CONFLICT (user_id,group_id) DO NOTHING`, [ownerUserId, group.groupId, group.isSelected]);
  const result = await pool.query<{ is_selected: boolean }>(`SELECT COALESCE(uga.is_selected,g.is_selected) AS is_selected FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, [group.groupId, ownerUserId]);
  await publish(subjects.groupDiscovered, subjects.groupDiscovered, { ...group, isSelected: result.rows[0]?.is_selected ?? group.isSelected });
}

function messageKind(message: TelegramMessage): WhatsAppMessageReceived["kind"] {
  if (message.voice || message.audio) return "audio";
  if (message.photo) return "image";
  if (message.video) return "video";
  if (message.document) return "document";
  if (message.location) return "location";
  if (message.text || message.caption) return "text";
  if (message.new_chat_title || message.left_chat_member || message.new_chat_member) return "system";
  return "system";
}

function messageText(message: TelegramMessage) {
  if (message.location) return `Ort: ${message.location.latitude}, ${message.location.longitude}`;
  return message.text ?? message.caption;
}

function senderId(message: TelegramMessage) {
  if (message.from) return `tg:user:${message.from.id}`;
  if (message.sender_chat) return `tg:chat:${message.sender_chat.id}`;
  return `tg:chat:${message.chat.id}`;
}

function senderName(message: TelegramMessage) {
  if (message.from) return [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || message.from.username;
  return message.sender_chat ? chatSubject(message.sender_chat) : chatSubject(message.chat);
}

function mediaDetails(message: TelegramMessage, kind: WhatsAppMessageReceived["kind"]) {
  const item = message.voice ?? message.audio ?? message.photo?.at(-1) ?? message.video ?? message.document;
  if (!item || !["audio", "image", "video", "document"].includes(kind)) return undefined;
  const fileId = item.file_id;
  const mediaMime = "mime_type" in item ? item.mime_type : kind === "image" ? "image/jpeg" : undefined;
  return { mediaKey: `telegram/${message.chat.id}/${message.message_id}/${fileId}`, mediaMime, fileId, fileName: "file_name" in item ? item.file_name : undefined };
}

async function downloadTelegramMedia(fileId: string, mediaKey: string) {
  const file = await telegramApi<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram lieferte keinen file_path");
  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram-Datei konnte nicht geladen werden: ${response.status}`);
  const extension = file.file_path.includes(".") ? `.${file.file_path.split(".").pop()!.replace(/[^a-z0-9]/gi, "")}` : "";
  const safeName = mediaKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const objectPath = join(mediaDir, "incoming", `${safeName}${extension}`);
  await mkdir(join(mediaDir, "incoming"), { recursive: true });
  await writeFile(objectPath, Buffer.from(await response.arrayBuffer()));
  return objectPath;
}

async function persistMessage(message: TelegramMessage) {
  if (!isTargetChat(message.chat)) return;
  await upsertGroup(message.chat);
  const selected = await pool.query<{ is_selected: boolean }>(`SELECT (g.is_selected OR COALESCE(uga.is_selected,FALSE)) AS is_selected FROM wa_groups g LEFT JOIN user_group_access uga ON uga.group_id=g.id AND uga.user_id=$2::uuid WHERE g.id=$1`, [normalizedChatId(message.chat.id), accountLease?.account.userId ?? null]);
  if (!selected.rows[0]?.is_selected) return;

  const groupId = normalizedChatId(message.chat.id);
  const waMessageId = `${groupId}:${message.message_id}`;
  if (new Date(message.date * 1000) < backfillCutoff) return;
  const kind = messageKind(message);
  const media = mediaDetails(message, kind);
  const hasMedia = Boolean(media);
  const raw = message as unknown as Record<string, unknown>;
  let objectPath: string | undefined;
  if (media) {
    try { objectPath = await retryTelegramOperation(`Telegram media download ${media.mediaKey}`, () => downloadTelegramMedia(media.fileId, media.mediaKey)); }
    catch (error) { console.warn("Telegram media download failed; Nachricht bleibt pending", media.mediaKey, summarizeTelegramError(error)); }
  }
  const contentHash = createHash("sha256").update(JSON.stringify({ groupId, waMessageId, kind, text: messageText(message), raw })).digest("hex");
  const existing = await pool.query<{ id: string; content_hash: string | null; media_status: string | null }>("SELECT id, content_hash, media_status FROM messages WHERE group_id=$1 AND wa_message_id=$2", [groupId, waMessageId]);
  if (existing.rows[0]?.content_hash === contentHash && (!media || existing.rows[0].media_status === "completed")) return;
  const mediaStatus = media ? (objectPath ? "completed" : "pending") : "none";
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, wa_message_id, platform, external_chat_id, sender_jid, sender_name, kind, text, received_at, has_media, media_key, media_mime, raw, content_hash, sequence_no, media_status)
     VALUES ($1,$2,'telegram',$1,$3,$4,$5,$6,to_timestamp($7),$8,$9,$10,$11,$12,$7,$13)
     ON CONFLICT (group_id, wa_message_id) DO UPDATE SET sender_jid = EXCLUDED.sender_jid,
       sender_name = EXCLUDED.sender_name, kind = EXCLUDED.kind, text = EXCLUDED.text,
       received_at = EXCLUDED.received_at, has_media = EXCLUDED.has_media,
       media_key = EXCLUDED.media_key, media_mime = EXCLUDED.media_mime, raw = EXCLUDED.raw, content_hash = EXCLUDED.content_hash,
       sequence_no = EXCLUDED.sequence_no, media_status = CASE WHEN EXCLUDED.media_status='completed' THEN 'completed' ELSE messages.media_status END
     RETURNING id`,
    [groupId, waMessageId, senderId(message), senderName(message) ?? null, kind, messageText(message) ?? null,
      message.date, hasMedia, media?.mediaKey ?? null, media?.mediaMime ?? null, raw, contentHash, mediaStatus],
  );
  const replyToWaMessageId = message.reply_to_message
    ? `${groupId}:${message.reply_to_message.message_id}`
    : undefined;
  const data: WhatsAppMessageReceived = {
    messageId: result.rows[0].id,
    waMessageId,
    groupId,
    platform: "telegram",
    chatType: message.chat.type,
    externalChatId: String(message.chat.id),
    senderJid: senderId(message),
    senderName: senderName(message),
    kind,
    text: messageText(message),
    receivedAt: new Date(message.date * 1000).toISOString(),
    hasMedia,
    mediaKey: media?.mediaKey,
    mediaMime: media?.mediaMime,
    replyToWaMessageId,
    raw,
    mediaObjectPath: objectPath,
    changeType: existing.rows[0] ? "updated" : "created",
    sequenceNo: message.date,
  };
  await publish(subjects.messageReceived, subjects.messageReceived, data);
  if (media && objectPath) await publish(subjects.mediaRequested, subjects.mediaRequested, { messageId: data.messageId, mediaKey: media.mediaKey, objectPath, mediaMime: media.mediaMime, kind, platform: "telegram", fileName: media.fileName });

  if (kind === "audio" && media && objectPath) {
    const existing = await pool.query<{ id: string }>("SELECT id FROM audio_jobs WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1", [data.messageId]);
    const jobId = existing.rows[0]?.id ?? randomUUID();
    if (!existing.rows[0]) {
      await pool.query("INSERT INTO audio_jobs (id, message_id, media_key, media_mime, object_path) VALUES ($1,$2,$3,$4,$5)", [jobId, data.messageId, media.mediaKey, media.mediaMime ?? null, objectPath]);
    }
    await publish(subjects.audioRequested, subjects.audioRequested, { jobId, messageId: data.messageId, mediaKey: media.mediaKey, mediaMime: media.mediaMime, objectPath });
  }
}

async function loadOffset() {
  await mkdir(stateDir, { recursive: true });
  try {
    const content = JSON.parse(await readFile(offsetPath, "utf8")) as { offset?: number };
    return Number.isInteger(content.offset) && Number(content.offset) >= 0 ? Number(content.offset) : 0;
  } catch {
    return 0;
  }
}

async function saveOffset(offset: number) {
  const temporaryPath = `${offsetPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ offset }), "utf8");
  await rename(temporaryPath, offsetPath);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function handleUpdate(update: TelegramUpdate) {
  if (update.my_chat_member) {
    const membership = update.my_chat_member;
    const state = membership.new_chat_member;
    const removed = state?.status === "left" || state?.status === "kicked" || (state?.status === "restricted" && state.is_member === false);
    if (removed && isTargetChat(membership.chat)) await cleanupRemovedGroups("telegram", [normalizedChatId(membership.chat.id)]);
    else if (isTargetChat(membership.chat)) await upsertGroup(membership.chat);
  } else if (update.chat_member && isTargetChat(update.chat_member.chat)) {
    await upsertGroup(update.chat_member.chat);
  }
  const message = update.message ?? update.channel_post;
  if (message) await persistMessage(message);
}

async function pollTelegram() {
  if (!botToken) return;
  await setStatus("connecting", "Telegram Bot API wird verbunden");
  await telegramApi<boolean>("deleteWebhook", { drop_pending_updates: false });
  botInfo = await telegramApi<TelegramUser>("getMe");
  connectedAt = new Date().toISOString();
  await setStatus("ready", `Bot @${botInfo.username ?? botInfo.first_name} empfängt Gruppen und Channels`);
  polling = true;
  let offset = initialActivation ? 0 : await loadOffset();
  let initialPollCompleted = false;
  console.log(`tg-connector authenticated as @${botInfo.username ?? botInfo.first_name}; polling groups/channels`);
  while (true) {
    try {
      const updates = await telegramApi<TelegramUpdate[]>("getUpdates", {
        offset,
        limit: 100,
        timeout: pollTimeout,
        allowed_updates: ["message", "channel_post", "my_chat_member", "chat_member"],
      });
      for (const update of updates) {
        await handleUpdate(update);
        offset = update.update_id + 1;
        await saveOffset(offset);
      }
      if (initialActivation && !initialPollCompleted) {
        initialPollCompleted = true;
        await completeInitialActivation();
        await setStatus("ready", `Erst-Backfill abgeschlossen: verfügbare Telegram-Updates geprüft; Bot API liefert keine rückwirkende Gruppenhistorie`);
      }
    } catch (error) {
      polling = false;
      await setStatus("degraded", "Polling unterbrochen; Wiederholung in 5 Sekunden", error);
      console.error("Telegram polling failed", error);
      await delay(5000);
      polling = true;
      await setStatus("ready", "Telegram-Polling wieder aktiv");
    }
  }
}

function respond(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" });
    return response.end();
  }
  if (request.url === "/healthz") return respond(response, 200, { status: "ok", service: "tg-connector" });
  if (request.url === "/readyz") return respond(response, lifecycleStatus === "ready" ? 200 : 503, { status: lifecycleStatus, mode: directMode ? "telegram-direct" : "telegram-bot", lastError });
  if (request.url === "/status") {
    return respond(response, 200, { connector: "telegram", status: lifecycleStatus, mode: directMode ? "telegram-direct" : "telegram-bot", connected: directRuntimeStarted || Boolean(botInfo && polling), connectedAt, lastError, qrRouting: "api-account", initialBackfillActive: initialActivation, backfillDays, backfillThrottleMs, backfillGroupDelayMs, backfillNote: directMode ? `Direct Telegram liest beim Neustart die letzten ${backfillDays} Tage aus ausgewählten Dialogen und drosselt die Verarbeitung.` : "Die Telegram Bot API stellt keine rückwirkende Gruppenhistorie bereit; verarbeitet werden alle noch verfügbaren Updates." });
  }
  if (request.method === "POST" && request.url === "/auth/qr") {
    return respond(response, 410, { error: "QR wird ausschließlich über die authentifizierte API und ein konkretes Nutzerkonto gestartet" });
  }
  if (request.url === "/bot") {
    return respond(response, 200, {
      configured: directMode || Boolean(botToken),
      mode: directMode ? "telegram-direct" : "telegram-bot",
      connected: directRuntimeStarted || Boolean(botInfo && polling),
      bot: botInfo ? { id: botInfo.id, username: botInfo.username, firstName: botInfo.first_name } : null,
      groupAllowlist: [...allowlist],
      initialBackfillActive: initialActivation,
      backfillDays,
      backfillThrottleMs,
      backfillGroupDelayMs,
      backfillNote: directMode ? `Direct Telegram liest beim Neustart die letzten ${backfillDays} Tage aus ausgewählten Dialogen und drosselt die Verarbeitung.` : "Die Telegram Bot API stellt keine rückwirkende Gruppenhistorie bereit; verarbeitet werden alle noch verfügbaren Updates.",
      instructions: [
        ...(directMode ? ["Direct Telegram verwendet die persönliche MTProto-Session; Gruppen müssen nur im persönlichen Konto erreichbar sein.", "Bei fehlender Session `npm run auth --workspace=@wagi/tg-connector` ausführen."] : [
        "Füge den Bot zu den gewünschten Gruppen hinzu.",
        "Für vollständige Gruppennachrichten den Bot als Administrator setzen oder die Privacy Mode über @BotFather mit /setprivacy deaktivieren.",
        "Für Channels reicht es, den Bot als Mitglied bzw. Administrator hinzuzufügen.",
        ]),
      ],
    });
  }
  return respond(response, 404, { error: "not found" });
});

async function main() {
  if (connectorStartDelayMs > 0) await delay(connectorStartDelayMs);
  nc = await connect({ servers: natsUrl });
  await ensureEventStream();
  subscribeGroupSelections();
  subscribeConnectorLogout();
  await pool.query("SELECT 1");
  if (!onboardingOnly) await prepareInitialActivation();
  let poolReady = onboardingOnly ? false : true;
  if (!onboardingOnly) {
    try {
      poolReady = await initializePoolLease();
    } catch (error) {
      poolReady = false;
      console.error("Telegram connector pool initialization failed", error);
      await setStatus("error", "Connector-Pool konnte nicht initialisiert werden", error);
    }
  }
  if (onboardingOnly) await setStatus("starting", "Telegram-Onboarding wartet auf eine QR-Anforderung");
  server.listen(port, () => console.log(`tg-connector listening on :${port} (${directMode ? "direct" : botToken ? "bot-api" : "waiting for Telegram credentials"})`));
  if (onboardingOnly) startOnboardingPoller();
  else if (directMode && poolReady) void startDirectConnector().catch((error) => { void setStatus("error", "Direct Telegram Initialisierung fehlgeschlagen", error); console.error(error); });
  else if (botToken) void pollTelegram().catch((error) => { polling = false; void setStatus("error", "Telegram-Initialisierung fehlgeschlagen", error); console.error(error); });
  else if (!poolEnabled) void setStatus("starting", "TG_API_ID/TG_API_HASH oder TG_BOT_TOKEN ist noch nicht konfiguriert");
  else {
    console.warn("Telegram connector is paused because no account lease is available");
  }
  if (poolEnabled && !onboardingOnly) startProcessingPoller();
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
