import type { GroupDiscovered, WhatsAppMessageReceived } from "@wagi/contracts";

export interface ConnectorGroup extends GroupDiscovered {
  description?: string;
}

export interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  listGroups(): Promise<ConnectorGroup[]>;
  onMessage(handler: (message: WhatsAppMessageReceived) => Promise<void>): void;
}
