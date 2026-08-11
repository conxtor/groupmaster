import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { connect, StorageType, StringCodec, type JetStreamClient, type NatsConnection } from "nats";
import { Pool } from "pg";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { subjects, type EventEnvelope, type GroupDiscovered, type GroupSelectionChanged, type WhatsAppMessageReceived } from "@wagi/contracts";

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
let groupRefreshTimer: NodeJS.Timeout | null = null;
let groupRefreshInProgress = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let connectInProgress = false;

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

async function setStatus(status: typeof lifecycleStatus, detail?: string, error?: unknown) {
  lifecycleStatus = status;
  lastError = error ? String(error) : lastError;
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
  await pool.query("DELETE FROM wa_groups WHERE platform=$1 AND id=ANY($2::text[])", [platform, uniqueIds]);
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
	const result = await pool.query<{ is_selected: boolean }>(
		`INSERT INTO wa_groups (id, subject, owner_jid, participant_count, is_selected, platform, chat_type, external_chat_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $1)
		 ON CONFLICT (id) DO UPDATE SET subject = CASE WHEN EXCLUDED.subject = EXCLUDED.id THEN wa_groups.subject ELSE EXCLUDED.subject END, owner_jid = EXCLUDED.owner_jid,
		   participant_count = EXCLUDED.participant_count, platform = EXCLUDED.platform, chat_type = EXCLUDED.chat_type,
		   external_chat_id = EXCLUDED.external_chat_id, updated_at = NOW()
		 RETURNING is_selected`,
		[group.groupId, subject, group.ownerJid ?? null, group.participantCount ?? 0, group.isSelected, group.platform ?? "whatsapp", group.chatType ?? "group"],
	);
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
      const subject = metadata.subject?.trim();
      await upsertGroup({ groupId, subject: subject || groupId, participantCount: metadata.participants?.length ?? 0, isSelected: allowlistedGroup(groupId), platform: "whatsapp", chatType: "group" });
    }
    const stored = await pool.query<{ id: string }>("SELECT id FROM wa_groups WHERE platform='whatsapp'");
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

async function persistMessage(message: WAMessage) {
  const groupId = message.key.remoteJid;
  const waMessageId = message.key.id;
  if (!groupId?.endsWith("@g.us") || !waMessageId) return;

  const selected = await pool.query<{ is_selected: boolean }>("SELECT is_selected FROM wa_groups WHERE id = $1", [groupId]);
  if (!selected.rows[0]?.is_selected) return;

  const kind = messageKind(message);
  const hasMedia = kind === "audio" || kind === "image" || kind === "video" || kind === "document";
  const mediaMime = mediaMimeFor(message, kind);
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
  if (previous.rows[0]?.content_hash === contentHash && !previous.rows[0]?.deleted_at && mediaAlreadyStored) return;
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
       sender_name = EXCLUDED.sender_name, kind = EXCLUDED.kind, text = EXCLUDED.text,
       received_at = EXCLUDED.received_at, has_media = EXCLUDED.has_media,
       media_key = EXCLUDED.media_key, media_mime = EXCLUDED.media_mime, raw = EXCLUDED.raw,
       content_hash = EXCLUDED.content_hash, sequence_no = EXCLUDED.sequence_no,
       media_status = EXCLUDED.media_status,
       edited_at = CASE WHEN messages.content_hash IS NOT NULL THEN NOW() ELSE messages.edited_at END
     RETURNING id`,
    [groupId, waMessageId, message.key.participant ?? "unknown", message.pushName ?? null, kind, text ?? null,
      timestamp, hasMedia, mediaKey ?? null, mediaMime ?? null, raw, contentHash, mediaStatus, Boolean(previous.rows[0])],
  );
  const messageId = result.rows[0].id;
  const revisionCount = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM message_revisions WHERE message_id = $1", [messageId]);
  await pool.query(
    "INSERT INTO message_revisions (message_id, revision_no, change_type, text, raw) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [messageId, Number(revisionCount.rows[0]?.count ?? 0) + 1, previous.rows[0] ? "updated" : "created", text ?? null, raw],
  );
  const data: WhatsAppMessageReceived = {
    messageId, waMessageId, groupId, platform: "whatsapp", chatType: "group", externalChatId: groupId,
    senderJid: message.key.participant ?? "unknown", senderName: message.pushName ?? undefined,
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
}

async function queueOrPersistHistory(message: WAMessage) {
  const groupId = message.key.remoteJid;
  if (!groupId?.endsWith("@g.us")) return;
  const timestamp = Number(message.messageTimestamp ?? 0);
  if (!timestamp || new Date(timestamp * 1000) < backfillCutoff) return;
  const selected = await pool.query<{ is_selected: boolean }>("SELECT is_selected FROM wa_groups WHERE id = $1", [groupId]);
  if (selected.rows[0]?.is_selected) {
    await persistMessage(message);
    return;
  }
  const messages = pendingHistory.get(groupId) ?? [];
  messages.push(message);
  pendingHistory.set(groupId, messages);
}

async function requestWhatsAppHistory(groupId: string) {
  if (!waSocket || !connected) return;
  const oldest = await pool.query<{ wa_message_id: string; received_at: Date }>(
    "SELECT wa_message_id, received_at FROM messages WHERE group_id=$1 ORDER BY received_at ASC LIMIT 1",
    [groupId],
  );
  const oldestMessage = oldest.rows[0];
  try {
    await waSocket.fetchMessageHistory(
      200,
      { remoteJid: groupId, fromMe: false, id: oldestMessage?.wa_message_id ?? "0" },
      oldestMessage?.received_at?.getTime() ?? backfillCutoff.getTime(),
    );
  } catch (error) {
    console.warn("WhatsApp selected-group history request failed", groupId, error);
  }
}

async function backfillSelectedWhatsAppGroups(socket: ReturnType<typeof makeWASocket>) {
  const selected = await pool.query<{ id: string }>(
    "SELECT id FROM wa_groups WHERE platform='whatsapp' AND is_selected=TRUE ORDER BY subject",
  );
  for (const [index, group] of selected.rows.entries()) {
    if (index > 0) await backfillDelay(backfillGroupDelayMs);
    await requestWhatsAppHistory(group.id);
  }
}

async function retryMissingWhatsAppMedia(socket: ReturnType<typeof makeWASocket>) {
  const rows = await pool.query<{ id: string; raw: WAMessage }>(
    `SELECT m.id, m.raw
     FROM messages m
     JOIN wa_groups g ON g.id = m.group_id AND g.platform='whatsapp' AND g.is_selected=TRUE
     LEFT JOIN LATERAL (
       SELECT mo.message_id
       FROM media_objects mo
       WHERE mo.message_id = m.id AND mo.status='completed' AND mo.object_path IS NOT NULL
       LIMIT 1
     ) stored ON TRUE
     WHERE m.platform='whatsapp' AND m.has_media=TRUE AND m.kind IN ('image','video')
       AND m.received_at >= $1 AND stored.message_id IS NULL
     ORDER BY m.received_at DESC`,
    [backfillCutoff],
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
  await pool.query("UPDATE wa_groups SET is_selected=$1, updated_at=NOW() WHERE id=$2", [data.selected, groupId]);
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
  await requestWhatsAppHistory(groupId);
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
  if (mockMode || reconnectTimer || lifecycleStatus === "reauth_required" || lifecycleStatus === "stopped") return;
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
    await mkdir(authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    // WhatsApp currently terminates Baileys sessions that advertise the
    // macOS/DARWIN desktop sub-platform before sending the QR event. Use the
    // browser profile so fresh linked-device registration reaches pair-device.
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: syncHistory || initialActivation,
      // This connector is read-only. Baileys' optional props/blocklist/privacy
      // init queries can time out on an otherwise healthy linked-device socket;
      // skipping them avoids a noisy 60-second error without affecting group
      // discovery, message reception, or media downloads.
      fireInitQueries: false,
    });
    waSocket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) { latestQr = qr; void setStatus("pairing", "QR-Code zur erneuten Anmeldung scannen"); qrcode.generate(qr, { small: true }); }
    connected = connection === "open";
    if (connection === "connecting") void setStatus("connecting", "WhatsApp-Verbindung wird aufgebaut");
    if (connection === "open") {
      reconnectAttempts = 0;
      connectedAt = new Date().toISOString();
      latestQr = null;
      void setStatus("syncing", `${initialActivation ? "Erst-" : "Neustart-"}Backfill der letzten ${backfillDays} Tage läuft`);
      startGroupRefreshTimer();
      void (async () => {
        await refreshAllWhatsAppGroupNames(socket);
        await backfillSelectedWhatsAppGroups(socket);
        void retryMissingWhatsAppMedia(socket)
          .catch((error) => console.warn("WhatsApp missing-media repair failed", error));
        await setStatus("ready", `WhatsApp verbunden; ${backfillDays}-Tage-Backfill eingeplant, Medienreparatur läuft im Hintergrund`);
      })().catch((error) => void setStatus("degraded", "WhatsApp-Backfill konnte nicht vollständig gestartet werden", error));
    }
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) void setStatus("reauth_required", "Session abgemeldet; erneutes QR-Pairing erforderlich");
      else scheduleWhatsAppReconnect(lastDisconnect?.error);
    }
  });
    socket.ev.on("groups.upsert", async (groups) => {
      try {
        for (const group of groups) {
          const subject = group.subject?.trim() || group.id;
          await upsertGroup({ groupId: group.id, subject, ownerJid: group.owner ?? undefined, participantCount: group.participants?.length ?? 0, isSelected: allowlistedGroup(group.id), platform: "whatsapp", chatType: "group" });
          await refreshGroupName(socket, group.id, subject);
        }
      } catch (error) {
        console.warn("WhatsApp group update failed", error);
      }
    });
    socket.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages) {
        try { await persistMessage(message); }
        catch (error) { console.warn("WhatsApp message persistence failed", message.key.id, error); }
      }
    });
    (socket.ev as any).on("messaging-history.set", async (history: { messages?: WAMessage[]; chats?: Array<{ id: string; name?: string; subject?: string; participants?: unknown[] }> }) => {
      try {
        void setStatus("syncing", "WhatsApp-History wird kontrolliert übernommen");
        for (const chat of history.chats ?? []) {
          if (chat.id.endsWith("@g.us")) {
            const subject = chat.name?.trim() || chat.subject?.trim() || chat.id;
            await upsertGroup({ groupId: chat.id, subject, participantCount: chat.participants?.length ?? 0, isSelected: allowlistedGroup(chat.id), platform: "whatsapp", chatType: "group" });
            await refreshGroupName(socket, chat.id, subject);
          }
        }
        for (const message of history.messages ?? []) {
          try { await queueOrPersistHistory(message); }
          catch (error) { console.warn("WhatsApp history message failed", message.key.id, error); }
          await backfillDelay(backfillThrottleMs);
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
      for (const update of updates) {
        try {
          if (update.update?.message) await persistMessage({ key: update.key, message: update.update.message } as WAMessage);
        } catch (error) { console.warn("WhatsApp message update failed", update.key.id, error); }
      }
    });
    (socket.ev as any).on("messages.delete", async (payload: { keys?: WAMessage["key"][] }) => {
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
      return respond(response, 200, { connector: "whatsapp", status: lifecycleStatus, connected, qr: latestQr, connectedAt, lastError, mode: mockMode ? "mock" : "baileys", historySync: syncHistory || initialActivation, initialBackfillActive: initialActivation, backfillDays, backfillThrottleMs, backfillGroupDelayMs });
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
  nc = await connect({ servers: natsUrl });
  await ensureEventStream();
  subscribeGroupSelections();
  await pool.query("SELECT 1");
  await prepareInitialActivation();
  server.listen(port, () => console.log(`wa-connector listening on :${port} (${mockMode ? "mock" : "baileys"})`));
  if (mockMode) { connected = true; connectedAt = new Date().toISOString(); await setStatus("syncing", initialActivation ? `Mock-Backfill der letzten ${backfillDays} Tage läuft` : "Mock-Daten aktiv"); await seedMockData(); await completeInitialActivation(); await setStatus("ready", "Mock-Daten aktiv"); }
  else {
    try {
      await connectWhatsApp();
    } catch (error) {
      console.error("Initial WhatsApp connection failed", error);
      scheduleWhatsAppReconnect(error);
    }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
