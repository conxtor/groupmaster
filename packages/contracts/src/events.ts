export const subjects = {
  messageReceived: "wa.messages.received",
  groupDiscovered: "wa.groups.discovered",
  audioRequested: "media.audio.requested",
  audioTranscribed: "media.audio.transcribed",
  messageAnalyzed: "ai.messages.analyzed",
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
}

export interface WhatsAppMessageReceived {
  messageId: string;
  waMessageId: string;
  groupId: string;
  /** Identifies the upstream connector while keeping the MVP event subject stable. */
  platform?: "whatsapp" | "telegram";
  chatType?: "group" | "supergroup" | "channel";
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
  raw?: Record<string, unknown>;
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
  model: string;
}
