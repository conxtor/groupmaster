import type { ConnectorStatus, GroupDiscovered, WhatsAppMessageReceived } from "@wagi/contracts";

export interface ConnectorGroup extends GroupDiscovered {
  description?: string;
}

export interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  listGroups(): Promise<ConnectorGroup[]>;
  onMessage(handler: (message: WhatsAppMessageReceived) => Promise<void>): void;
  status(): ConnectorStatus;
  onStatus(handler: (status: ConnectorStatus) => void): void;
}

export interface ConnectorError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function connectorError(code: string, message: string, retryable = false, details?: Record<string, unknown>): ConnectorError {
  return { code, message, retryable, details };
}
