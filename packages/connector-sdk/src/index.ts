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

export type ConnectorPlatform = "whatsapp" | "telegram";

export type ConnectorSQLResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
};

export interface ConnectorSQLStore {
  query(text: string, values?: readonly unknown[]): Promise<ConnectorSQLResult>;
}

export type ConnectorAccountLeaseInfo = {
  accountId: string;
  userId: string;
  platform: ConnectorPlatform;
  label: string;
};

/**
 * Shared control-plane implementation for connector workers. A lease is
 * deliberately account-scoped: at most one worker may operate a user's
 * MTProto/Baileys session at a time. Session bytes and per-group cursors stay
 * in PostgreSQL, so workers can be restarted or rotated without losing state.
 */
export class ConnectorAccountLease {
  private renewalTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: ConnectorSQLStore,
    readonly workerId: string,
    readonly account: ConnectorAccountLeaseInfo,
    private readonly leaseSeconds = 90,
  ) {}

  startRenewal(onError?: (error: unknown) => void) {
    this.stopRenewal();
    const renew = () => {
      void this.renew().catch((error) => onError?.(error));
    };
    this.renewalTimer = setInterval(renew, Math.max(10, Math.floor(this.leaseSeconds / 3)) * 1000);
    this.renewalTimer.unref?.();
  }

  stopRenewal() {
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = undefined;
  }

  async renew() {
    const result = await this.store.query(
      `UPDATE connector_leases SET lease_until=NOW()+($3::int * INTERVAL '1 second'), updated_at=NOW()
       WHERE account_id=$1::uuid AND worker_id=$2 AND lease_until>NOW()
       RETURNING account_id`,
      [this.account.accountId, this.workerId, this.leaseSeconds],
    );
    if (!result.rowCount) throw new Error(`Connector lease expired for ${this.account.accountId}`);
  }

  async release() {
    this.stopRenewal();
    await this.store.query("DELETE FROM connector_leases WHERE account_id=$1::uuid AND worker_id=$2", [this.account.accountId, this.workerId]);
  }

  async loadSession(): Promise<Buffer | null> {
    const result = await this.store.query("SELECT session_data FROM connector_accounts WHERE id=$1::uuid", [this.account.accountId]);
    const value = result.rows[0]?.session_data;
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (typeof value === "string") return Buffer.from(value, "base64");
    return null;
  }

  async saveSession(value: Uint8Array) {
    await this.store.query(
      "UPDATE connector_accounts SET session_data=$2, session_version=session_version+1, updated_at=NOW(), last_error=NULL WHERE id=$1::uuid",
      [this.account.accountId, Buffer.from(value)],
    );
  }

  async setStatus(status: string, error?: string | null) {
    await this.store.query(
      "UPDATE connector_accounts SET status=$2, last_error=$3, last_connected_at=CASE WHEN $2='ready' THEN NOW() ELSE last_connected_at END, updated_at=NOW() WHERE id=$1::uuid",
      [this.account.accountId, status, error ?? null],
    );
  }

  async saveCursor(groupId: string, values: { externalMessageId?: string; receivedAt?: string; sequenceNo?: number }) {
    await this.store.query(
      `INSERT INTO connector_cursors (account_id, group_id, last_external_message_id, last_received_at, last_sequence_no)
       VALUES ($1::uuid,$2,$3,$4,$5)
       ON CONFLICT (account_id,group_id) DO UPDATE SET last_external_message_id=COALESCE(EXCLUDED.last_external_message_id,connector_cursors.last_external_message_id),
         last_received_at=COALESCE(EXCLUDED.last_received_at,connector_cursors.last_received_at), last_sequence_no=COALESCE(EXCLUDED.last_sequence_no,connector_cursors.last_sequence_no), updated_at=NOW()`,
      [this.account.accountId, groupId, values.externalMessageId ?? null, values.receivedAt ?? null, values.sequenceNo ?? null],
    );
  }

  async loadCursor(groupId: string): Promise<{ externalMessageId?: string; receivedAt?: string; sequenceNo?: number } | null> {
    const result = await this.store.query(
      "SELECT last_external_message_id, last_received_at, last_sequence_no FROM connector_cursors WHERE account_id=$1::uuid AND group_id=$2",
      [this.account.accountId, groupId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      externalMessageId: row.last_external_message_id ? String(row.last_external_message_id) : undefined,
      receivedAt: row.last_received_at ? new Date(String(row.last_received_at)).toISOString() : undefined,
      sequenceNo: row.last_sequence_no == null ? undefined : Number(row.last_sequence_no),
    };
  }
}

export async function ensureConnectorAccount(store: ConnectorSQLStore, platform: ConnectorPlatform, email: string, label: string): Promise<ConnectorAccountLeaseInfo> {
  const result = await store.query(
    `INSERT INTO connector_accounts (user_id, platform, label)
     SELECT id, $2, $3 FROM app_users WHERE LOWER(email)=LOWER($1)
     ON CONFLICT (user_id,platform) DO UPDATE SET label=EXCLUDED.label, updated_at=NOW()
     RETURNING id::text AS account_id, user_id::text AS user_id, platform, label`,
    [email, platform, label],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`No application user found for connector account ${email}`);
  return { accountId: String(row.account_id), userId: String(row.user_id), platform: row.platform as ConnectorPlatform, label: String(row.label ?? label) };
}

export async function acquireConnectorAccount(store: ConnectorSQLStore, platform: ConnectorPlatform, workerId: string, preferredAccountId?: string, leaseSeconds = 90): Promise<ConnectorAccountLease | null> {
  const result = await store.query(
    `WITH candidate AS (
       SELECT ca.id, ca.user_id, ca.platform, ca.label
       FROM connector_accounts ca
       LEFT JOIN connector_leases cl ON cl.account_id=ca.id
       WHERE ca.platform=$1 AND ca.status NOT IN ('disabled','stopped')
         AND (cl.account_id IS NULL OR cl.lease_until<=NOW() OR cl.worker_id=$2)
         AND ($3 IS NULL OR ca.id=$3::uuid)
       ORDER BY CASE WHEN $3 IS NOT NULL AND ca.id=$3::uuid THEN 0 ELSE 1 END, ca.next_sync_at, ca.created_at
       FOR UPDATE OF ca SKIP LOCKED LIMIT 1
     )
     INSERT INTO connector_leases (account_id,worker_id,lease_until,updated_at)
     SELECT id,$2,NOW()+($4::int * INTERVAL '1 second'),NOW() FROM candidate
     ON CONFLICT (account_id) DO UPDATE SET worker_id=EXCLUDED.worker_id, lease_until=EXCLUDED.lease_until, updated_at=NOW()
     RETURNING account_id::text`,
    [platform, workerId, preferredAccountId ?? null, leaseSeconds],
  );
  const row = result.rows[0];
  if (!row) return null;
  const accountResult = await store.query("SELECT id::text AS account_id, user_id::text AS user_id, platform, label FROM connector_accounts WHERE id=$1::uuid", [row.account_id]);
  const account = accountResult.rows[0];
  if (!account) return null;
  return new ConnectorAccountLease(store, workerId, { accountId: String(account.account_id), userId: String(account.user_id), platform: account.platform as ConnectorPlatform, label: String(account.label ?? "") }, leaseSeconds);
}
