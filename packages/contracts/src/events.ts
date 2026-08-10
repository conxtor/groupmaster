export const subjects = {
  messageReceived: "wa.messages.received",
  groupDiscovered: "wa.groups.discovered",
  audioRequested: "media.audio.requested",
  audioTranscribed: "media.audio.transcribed",
  mediaRequested: "media.objects.requested",
  imageAnalyzed: "media.image.analyzed",
  messageAnalyzed: "ai.messages.analyzed",
  connectorStatus: "connector.status.changed",
  groupSelectionChanged: "connector.group.selection.changed",
} as const;

export type EventSubject = (typeof subjects)[keyof typeof subjects];

export interface EventEnvelope<T> {
  id: string;
  type: EventSubject;
  occurredAt: string;
  source: string;
  traceId?: string;
  data: T;
}

export interface GroupDiscovered {
  groupId: string;
  subject: string;
  ownerJid?: string;
  participantCount?: number;
  isSelected: boolean;
  platform?: "whatsapp" | "telegram";
  chatType?: "group" | "supergroup" | "channel" | "topic";
  language?: "de" | "es" | "ca" | "en" | "fr";
  parentGroupId?: string;
  topicId?: string;
}

export interface GroupSelectionChanged {
  groupId: string;
  selected: boolean;
  platform?: "whatsapp" | "telegram";
}

export interface WhatsAppMessageReceived {
  messageId: string;
  waMessageId: string;
  groupId: string;
  /** Identifies the upstream connector while keeping the MVP event subject stable. */
  platform?: "whatsapp" | "telegram";
  chatType?: "group" | "supergroup" | "channel" | "topic";
  externalChatId?: string;
  senderJid: string;
  senderName?: string;
  kind: "text" | "image" | "audio" | "video" | "document" | "location" | "system";
  text?: string;
  receivedAt: string;
  hasMedia: boolean;
  mediaKey?: string;
  mediaMime?: string;
  replyToWaMessageId?: string;
  changeType?: "created" | "updated" | "deleted";
  editedAt?: string;
  sequenceNo?: number;
  mediaObjectPath?: string;
  thumbnailObjectPath?: string;
  raw?: Record<string, unknown>;
}

export interface MediaObjectRequested {
  messageId: string;
  mediaKey: string;
  objectPath: string;
  mediaMime?: string;
  platform?: "whatsapp" | "telegram";
  fileName?: string;
}

export interface ImageAnalyzed {
  messageId: string;
  ocrText?: string;
  caption?: string;
  provider: string;
}

export type ConnectorLifecycleStatus = "starting" | "pairing" | "connecting" | "syncing" | "ready" | "degraded" | "error" | "reauth_required" | "stopped";

export interface ConnectorStatus {
  connector: string;
  status: ConnectorLifecycleStatus;
  detail?: string;
  lastError?: string;
  qr?: string;
  connectedAt?: string;
}

export interface AudioTranscriptionRequested {
  jobId: string;
  messageId: string;
  mediaKey: string;
  mediaMime?: string;
  objectPath?: string;
}

export interface AudioTranscribed {
  jobId: string;
  messageId: string;
  transcript: string;
  language?: string;
  confidence?: number;
  provider: string;
}

export interface MessageAnalysis {
  messageId: string;
  relevant: boolean;
  relevanceScore: number;
  summary: string;
  facts: Array<{ text: string; confidence: number }>;
  entities: Array<{ name: string; type: string; confidence: number }>;
  events: Array<{ title: string; startsAt?: string; location?: string; confidence: number; sourceMessageIds?: string[] }>;
  places: Array<{ name: string; latitude?: number; longitude?: number; confidence: number }>;
  knowledge: Array<{ topicKey: string; topicTitle: string; itemKey: string; itemType: "fact" | "insight" | "entity"; content: string; confidence: number; sourceMessageIds: string[] }>;
  schemaVersion?: string;
  promptVersion?: string;
  provenance?: Array<{ field: string; sourceMessageIds: string[]; confidence?: number }>;
  conflicts?: Array<{ field: string; messageIds: string[]; description: string; confidence?: number }>;
  model: string;
}
