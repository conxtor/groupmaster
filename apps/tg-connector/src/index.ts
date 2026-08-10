import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect, StorageType, StringCodec, type JetStreamClient, type NatsConnection } from "nats";
import { Pool } from "pg";
import { subjects, type EventEnvelope, type GroupDiscovered, type WhatsAppMessageReceived } from "@wagi/contracts";

const port = Number(process.env.TG_PORT ?? process.env.PORT ?? 3002);
const databaseUrl = process.env.DATABASE_URL ?? "postgres://wagi_app:app@localhost:5432/app";
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
const botToken = (process.env.TG_BOT_TOKEN ?? "").trim();
const stateDir = process.env.TG_STATE_DIR ?? "./data/tg-state";
const offsetPath = join(stateDir, "offset.json");
const pollTimeout = Math.max(1, Math.min(50, Number(process.env.TG_POLL_TIMEOUT ?? 25)));
const allowlist = new Set((process.env.TG_GROUP_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean));

const pool = new Pool({ connectionString: databaseUrl });
const sc = StringCodec();
let nc: NatsConnection;
let js: JetStreamClient;
let botInfo: TelegramUser | null = null;
let polling = false;

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

type TelegramChatMemberUpdate = { chat: TelegramChat; from: TelegramUser; date: number; new_chat_member?: { status: string; user: TelegramUser } };
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

async function ensureEventStream() {
  js = nc.jetstream();
  const manager = await nc.jetstreamManager();
  try {
    await manager.streams.info("WAGI_EVENTS");
  } catch {
    try {
      await manager.streams.add({ name: "WAGI_EVENTS", subjects: ["wa.>", "media.>", "ai.>"], storage: StorageType.File, max_msgs: -1 });
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
  if (allowlist.size === 0) return true;
  return allowlist.has(String(chat.id)) || allowlist.has(normalizedChatId(chat.id)) || (chat.username ? allowlist.has(`@${chat.username}`) || allowlist.has(chat.username) : false);
}

async function upsertGroup(chat: TelegramChat) {
  if (!isTargetChat(chat)) return;
  const group: GroupDiscovered = {
    groupId: normalizedChatId(chat.id),
    subject: chatSubject(chat),
    ownerJid: `tg:chat:${chat.id}`,
    isSelected: isSelected(chat),
  };
  await pool.query(
    `INSERT INTO wa_groups (id, subject, owner_jid, participant_count, is_selected)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, owner_jid = EXCLUDED.owner_jid,
       updated_at = NOW()`,
    [group.groupId, group.subject, group.ownerJid, 0, group.isSelected],
  );
  await publish(subjects.groupDiscovered, subjects.groupDiscovered, group);
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
  return { mediaKey: `telegram/${message.chat.id}/${message.message_id}/${fileId}`, mediaMime };
}

async function persistMessage(message: TelegramMessage) {
  if (!isTargetChat(message.chat)) return;
  await upsertGroup(message.chat);
  const selected = await pool.query<{ is_selected: boolean }>("SELECT is_selected FROM wa_groups WHERE id = $1", [normalizedChatId(message.chat.id)]);
  if (!selected.rows[0]?.is_selected) return;

  const groupId = normalizedChatId(message.chat.id);
  const waMessageId = `${groupId}:${message.message_id}`;
  const kind = messageKind(message);
  const media = mediaDetails(message, kind);
  const hasMedia = Boolean(media);
  const raw = message as unknown as Record<string, unknown>;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, wa_message_id, sender_jid, sender_name, kind, text, received_at, has_media, media_key, media_mime, raw)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),$8,$9,$10,$11)
     ON CONFLICT (group_id, wa_message_id) DO UPDATE SET sender_jid = EXCLUDED.sender_jid,
       sender_name = EXCLUDED.sender_name, kind = EXCLUDED.kind, text = EXCLUDED.text,
       received_at = EXCLUDED.received_at, has_media = EXCLUDED.has_media,
       media_key = EXCLUDED.media_key, media_mime = EXCLUDED.media_mime, raw = EXCLUDED.raw
     RETURNING id`,
    [groupId, waMessageId, senderId(message), senderName(message) ?? null, kind, messageText(message) ?? null,
      message.date, hasMedia, media?.mediaKey ?? null, media?.mediaMime ?? null, raw],
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
  };
  await publish(subjects.messageReceived, subjects.messageReceived, data);

  if (kind === "audio" && media) {
    const existing = await pool.query<{ id: string }>("SELECT id FROM audio_jobs WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1", [data.messageId]);
    const jobId = existing.rows[0]?.id ?? randomUUID();
    if (!existing.rows[0]) {
      await pool.query("INSERT INTO audio_jobs (id, message_id, media_key, media_mime) VALUES ($1,$2,$3,$4)", [jobId, data.messageId, media.mediaKey, media.mediaMime ?? null]);
    }
    await publish(subjects.audioRequested, subjects.audioRequested, { jobId, messageId: data.messageId, mediaKey: media.mediaKey, mediaMime: media.mediaMime });
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
  const membership = update.my_chat_member ?? update.chat_member;
  if (membership) await upsertGroup(membership.chat);
  const message = update.message ?? update.channel_post;
  if (message) await persistMessage(message);
}

async function pollTelegram() {
  if (!botToken) return;
  await telegramApi<boolean>("deleteWebhook", { drop_pending_updates: false });
  botInfo = await telegramApi<TelegramUser>("getMe");
  polling = true;
  let offset = await loadOffset();
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
    } catch (error) {
      polling = false;
      console.error("Telegram polling failed", error);
      await delay(5000);
      polling = true;
    }
  }
}

function respond(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type" });
    return response.end();
  }
  if (request.url === "/healthz") return respond(response, 200, { status: "ok", service: "tg-connector" });
  if (request.url === "/readyz") return respond(response, 200, { status: botInfo && polling ? "ready" : "waiting-for-bot-token", mode: "telegram-bot" });
  if (request.url === "/bot") {
    return respond(response, 200, {
      configured: Boolean(botToken),
      connected: Boolean(botInfo && polling),
      bot: botInfo ? { id: botInfo.id, username: botInfo.username, firstName: botInfo.first_name } : null,
      groupAllowlist: [...allowlist],
      instructions: [
        "Füge den Bot zu den gewünschten Gruppen hinzu.",
        "Für vollständige Gruppennachrichten den Bot als Administrator setzen oder die Privacy Mode über @BotFather mit /setprivacy deaktivieren.",
        "Für Channels reicht es, den Bot als Mitglied bzw. Administrator hinzuzufügen.",
      ],
    });
  }
  return respond(response, 404, { error: "not found" });
});

async function main() {
  nc = await connect({ servers: natsUrl });
  await ensureEventStream();
  await pool.query("SELECT 1");
  server.listen(port, () => console.log(`tg-connector listening on :${port} (${botToken ? "bot-api" : "waiting for TG_BOT_TOKEN"})`));
  if (botToken) void pollTelegram().catch((error) => { polling = false; console.error(error); });
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
