import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { connect, StorageType, StringCodec, type JetStreamClient, type NatsConnection } from "nats";
import { Pool } from "pg";
import qrcode from "qrcode-terminal";
import { subjects, type EventEnvelope, type GroupDiscovered, type WhatsAppMessageReceived } from "@wagi/contracts";

const port = Number(process.env.PORT ?? 3001);
const databaseUrl = process.env.DATABASE_URL ?? "postgres://wagi_app:app@localhost:5432/app";
const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
const authDir = process.env.WA_AUTH_DIR ?? "./data/wa-auth";
const mockMode = (process.env.WA_MOCK_MODE ?? "false").toLowerCase() === "true";
const allowlist = new Set((process.env.WA_GROUP_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean));

const pool = new Pool({ connectionString: databaseUrl });
const sc = StringCodec();
let nc: NatsConnection;
let js: JetStreamClient;
let latestQr: string | null = null;
let connected = false;

function envelope<T>(type: EventEnvelope<T>["type"], data: T): EventEnvelope<T> {
  return { id: randomUUID(), type, occurredAt: new Date().toISOString(), source: "wa-connector", data };
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

async function upsertGroup(group: GroupDiscovered) {
  await pool.query(
    `INSERT INTO wa_groups (id, subject, owner_jid, participant_count, is_selected)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, owner_jid = EXCLUDED.owner_jid,
       participant_count = EXCLUDED.participant_count, updated_at = NOW()`,
    [group.groupId, group.subject, group.ownerJid ?? null, group.participantCount ?? 0, group.isSelected],
  );
  await publish(subjects.groupDiscovered, subjects.groupDiscovered, group);
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

async function persistMessage(message: WAMessage) {
  const groupId = message.key.remoteJid;
  const waMessageId = message.key.id;
  if (!groupId?.endsWith("@g.us") || !waMessageId) return;

  const selected = await pool.query<{ is_selected: boolean }>("SELECT is_selected FROM wa_groups WHERE id = $1", [groupId]);
  if (!selected.rows[0]?.is_selected) return;

  const kind = messageKind(message);
  const hasMedia = kind === "audio" || kind === "image" || kind === "video" || kind === "document";
  const mediaMime = kind === "audio" ? message.message?.audioMessage?.mimetype ?? undefined : undefined;
  const timestamp = Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000));
  const raw = JSON.parse(JSON.stringify(message, (_, value) => typeof value === "bigint" ? Number(value) : value));
  const result = await pool.query<{ id: string }>(
    `INSERT INTO messages (group_id, wa_message_id, sender_jid, sender_name, kind, text, received_at, has_media, media_key, media_mime, raw)
     VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),$8,$9,$10,$11)
     ON CONFLICT (group_id, wa_message_id) DO UPDATE SET sender_jid = EXCLUDED.sender_jid,
       sender_name = EXCLUDED.sender_name, kind = EXCLUDED.kind, text = EXCLUDED.text,
       received_at = EXCLUDED.received_at, has_media = EXCLUDED.has_media,
       media_key = EXCLUDED.media_key, media_mime = EXCLUDED.media_mime, raw = EXCLUDED.raw
     RETURNING id`,
    [groupId, waMessageId, message.key.participant ?? "unknown", message.pushName ?? null, kind, messageText(message) ?? null,
      timestamp, hasMedia, hasMedia ? `${groupId}/${waMessageId}` : null, mediaMime ?? null, raw],
  );
  const data: WhatsAppMessageReceived = {
    messageId: result.rows[0].id, waMessageId, groupId,
    senderJid: message.key.participant ?? "unknown", senderName: message.pushName ?? undefined,
    kind, text: messageText(message), receivedAt: new Date(timestamp * 1000).toISOString(), hasMedia,
    mediaKey: hasMedia ? `${groupId}/${waMessageId}` : undefined, mediaMime, raw,
    replyToWaMessageId: replyToWaMessageId(message),
  };
  await publish(subjects.messageReceived, subjects.messageReceived, data);
  if (kind === "audio") {
    const existing = await pool.query<{ id: string }>("SELECT id FROM audio_jobs WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1", [data.messageId]);
    const jobId = existing.rows[0]?.id ?? randomUUID();
    if (!existing.rows[0]) {
      await pool.query("INSERT INTO audio_jobs (id, message_id, media_key, media_mime) VALUES ($1,$2,$3,$4)", [jobId, data.messageId, data.mediaKey, data.mediaMime ?? null]);
    }
    await publish(subjects.audioRequested, subjects.audioRequested, { jobId, messageId: data.messageId, mediaKey: data.mediaKey!, mediaMime: data.mediaMime });
  }
}

async function connectWhatsApp() {
  await mkdir(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const socket = makeWASocket({ auth: state, browser: Browsers.macOS("WAGI"), printQRInTerminal: false, syncFullHistory: false });
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) { latestQr = qr; qrcode.generate(qr, { small: true }); }
    connected = connection === "open";
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) setTimeout(() => void connectWhatsApp(), 3000);
    }
  });
  socket.ev.on("groups.upsert", async (groups) => {
    for (const group of groups) {
      await upsertGroup({ groupId: group.id, subject: group.subject, ownerJid: group.owner ?? undefined, participantCount: group.participants?.length ?? 0, isSelected: allowlist.size === 0 || allowlist.has(group.id) });
    }
  });
  socket.ev.on("messages.upsert", async ({ messages }) => {
    for (const message of messages) await persistMessage(message);
  });
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
    await upsertGroup({ groupId: group.groupId, subject: group.subject, participantCount: group.participantCount, isSelected: true });
    for (const message of group.messages) await persistMessage(message);
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
    if (request.url === "/readyz") return respond(response, 200, { status: connected || mockMode ? "ready" : "waiting-for-whatsapp", mode: mockMode ? "mock" : "baileys" });
    if (request.url === "/pairing") return respond(response, 200, { connected, qr: latestQr, mode: mockMode ? "mock" : "baileys" });
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
  await pool.query("SELECT 1");
  server.listen(port, () => console.log(`wa-connector listening on :${port} (${mockMode ? "mock" : "baileys"})`));
  if (mockMode) { connected = true; await seedMockData(); }
  else await connectWhatsApp();
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
