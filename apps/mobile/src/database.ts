import * as SQLite from "expo-sqlite";

type TrustedIdentityRow = {
  address: string;
  identity_key: string;
  updated_at: number;
};

type SignedPreKeyRow = {
  id: number;
  key_pair: string;
  signature: string;
};

type LocalDeviceStateRow = {
  user_id: string;
  device_id: string;
  signal_device_id: number | null;
  updated_at: number;
};

type LocalE2EEMessageRow = {
  id: string;
  pending_message_id: string | null;
  client_message_id: string | null;
  chat_id: string | null;
  peer_user_id: string;
  direction: string;
  sender_user_id: string;
  sender_device_id: string | null;
  sender_signal_device_id: number | null;
  receiver_device_id: string | null;
  receiver_signal_device_id: number | null;
  message_type: number;
  ciphertext: string;
  plaintext: string;
  status: string;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
};

export type LocalDeviceState = {
  userId: string;
  deviceId: string;
  signalDeviceId: number | null;
  updatedAt: number;
};

export type LocalE2EEMessage = {
  id: string;
  pendingMessageId?: string | null;
  clientMessageId?: string | null;
  chatId?: string | null;
  peerUserId: string;
  direction: "inbound" | "outbound";
  senderUserId: string;
  senderDeviceId?: string | null;
  senderSignalDeviceId?: number | null;
  receiverDeviceId?: string | null;
  receiverSignalDeviceId?: number | null;
  messageType: number;
  ciphertext: string;
  plaintext: string;
  status: string;
  createdAt: number;
  deliveredAt?: number | null;
  ackedAt?: number | null;
};

export class DatabaseService {
  private databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
  private initialized = false;

  async init(): Promise<void> {
    const database = await this.getDatabase();
    if (this.initialized) {
      return;
    }

    await database.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY NOT NULL,
        username TEXT,
        identity_key TEXT,
        trust_state TEXT NOT NULL DEFAULT 'trusted'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        address TEXT PRIMARY KEY NOT NULL,
        session_data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_device_state (
        user_id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL UNIQUE,
        signal_device_id INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prekeys (
        id INTEGER PRIMARY KEY NOT NULL,
        key_pair TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS signed_prekeys (
        id INTEGER PRIMARY KEY NOT NULL,
        key_pair TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trusted_identities (
        address TEXT PRIMARY KEY NOT NULL,
        identity_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS e2ee_messages (
        id TEXT PRIMARY KEY NOT NULL,
        pending_message_id TEXT,
        client_message_id TEXT,
        chat_id TEXT,
        peer_user_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender_user_id TEXT NOT NULL,
        sender_device_id TEXT,
        sender_signal_device_id INTEGER,
        receiver_device_id TEXT,
        receiver_signal_device_id INTEGER,
        message_type INTEGER NOT NULL,
        ciphertext TEXT NOT NULL,
        plaintext TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        acked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at
      ON messages (chat_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_trusted_identities_address
      ON trusted_identities (address);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_e2ee_messages_pending_message_id
      ON e2ee_messages (pending_message_id)
      WHERE pending_message_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_e2ee_messages_client_message_id
      ON e2ee_messages (client_message_id)
      WHERE client_message_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_e2ee_messages_peer_created_at
      ON e2ee_messages (peer_user_id, created_at DESC);
    `);

    this.initialized = true;
  }

  async saveSession(address: string, sessionData: string): Promise<void> {
    const database = await this.ready();
    await database.runAsync(
      `INSERT INTO sessions(address, session_data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         session_data = excluded.session_data,
         updated_at = excluded.updated_at`,
      address,
      sessionData,
      Date.now(),
    );
  }

  async getSession(address: string): Promise<string | null> {
    const database = await this.ready();
    const row = await database.getFirstAsync<{ session_data: string }>(
      "SELECT session_data FROM sessions WHERE address = ?",
      address,
    );
    return row?.session_data ?? null;
  }

  async deleteSession(address: string): Promise<void> {
    const database = await this.ready();
    await database.runAsync("DELETE FROM sessions WHERE address = ?", address);
  }

  async savePreKey(id: number, keyPair: string): Promise<void> {
    const database = await this.ready();
    await database.runAsync(
      `INSERT INTO prekeys(id, key_pair, created_at, used)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         key_pair = excluded.key_pair,
         used = 0`,
      id,
      keyPair,
      Date.now(),
    );
  }

  async getPreKey(id: number): Promise<string | null> {
    const database = await this.ready();
    const row = await database.getFirstAsync<{ key_pair: string }>(
      "SELECT key_pair FROM prekeys WHERE id = ?",
      id,
    );
    return row?.key_pair ?? null;
  }

  async listPreKeyIds(): Promise<number[]> {
    const database = await this.ready();
    const rows = await database.getAllAsync<{ id: number }>("SELECT id FROM prekeys ORDER BY id ASC");
    return rows.map((row) => row.id);
  }

  async countPreKeys(): Promise<number> {
    const database = await this.ready();
    return (
      (await database.getFirstAsync<{ count: number }>("SELECT COUNT(*) as count FROM prekeys"))?.count
      ?? 0
    );
  }

  async getMaxPreKeyId(): Promise<number> {
    const database = await this.ready();
    return (
      (await database.getFirstAsync<{ max_id: number | null }>("SELECT MAX(id) as max_id FROM prekeys"))?.max_id
      ?? 0
    );
  }

  async deletePreKey(id: number): Promise<void> {
    const database = await this.ready();
    await database.runAsync("DELETE FROM prekeys WHERE id = ?", id);
  }

  async saveSignedPreKey(id: number, keyPair: string, signature: string): Promise<void> {
    const database = await this.ready();
    await database.runAsync(
      `INSERT INTO signed_prekeys(id, key_pair, signature, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         key_pair = excluded.key_pair,
         signature = excluded.signature,
         created_at = excluded.created_at`,
      id,
      keyPair,
      signature,
      Date.now(),
    );
  }

  async getSignedPreKey(id: number): Promise<string | null> {
    const row = await this.getSignedPreKeyBundle(id);
    return row?.key_pair ?? null;
  }

  async getSignedPreKeyBundle(id: number): Promise<SignedPreKeyRow | null> {
    const database = await this.ready();
    return (
      (await database.getFirstAsync<SignedPreKeyRow>(
        "SELECT id, key_pair, signature FROM signed_prekeys WHERE id = ?",
        id,
      )) ?? null
    );
  }

  async deleteSignedPreKey(id: number): Promise<void> {
    const database = await this.ready();
    await database.runAsync("DELETE FROM signed_prekeys WHERE id = ?", id);
  }

  async saveTrustedIdentity(address: string, identityKey: string): Promise<void> {
    const database = await this.ready();
    await database.runAsync(
      `INSERT INTO trusted_identities(address, identity_key, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         identity_key = excluded.identity_key,
         updated_at = excluded.updated_at`,
      address,
      identityKey,
      Date.now(),
    );
  }

  async getTrustedIdentity(address: string): Promise<{ identityKey: string; updatedAt: number } | null> {
    const database = await this.ready();
    const row = await database.getFirstAsync<TrustedIdentityRow>(
      "SELECT address, identity_key, updated_at FROM trusted_identities WHERE address = ?",
      address,
    );

    if (!row) {
      return null;
    }

    return {
      identityKey: row.identity_key,
      updatedAt: row.updated_at,
    };
  }

  async getTrustedIdentitiesForIdentifier(identifier: string, exactAddress?: string): Promise<Array<{ address: string; identityKey: string }>> {
    const database = await this.ready();
    const addressPrefix = `${identifier}.%`;
    const rows = await database.getAllAsync<TrustedIdentityRow>(
      `SELECT address, identity_key, updated_at
       FROM trusted_identities
       WHERE address = ?
          OR address = ?
          OR address LIKE ?`,
      identifier,
      exactAddress ?? identifier,
      addressPrefix,
    );

    return rows.map((row) => ({
      address: row.address,
      identityKey: row.identity_key,
    }));
  }

  async saveLocalDeviceState(userId: string, deviceId: string, signalDeviceId: number | null): Promise<void> {
    const database = await this.ready();
    await database.runAsync(
      `INSERT INTO local_device_state(user_id, device_id, signal_device_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         device_id = excluded.device_id,
         signal_device_id = excluded.signal_device_id,
         updated_at = excluded.updated_at`,
      userId,
      deviceId,
      signalDeviceId,
      Date.now(),
    );
  }

  async getLocalDeviceState(userId: string): Promise<LocalDeviceState | null> {
    const database = await this.ready();
    const row = await database.getFirstAsync<LocalDeviceStateRow>(
      "SELECT user_id, device_id, signal_device_id, updated_at FROM local_device_state WHERE user_id = ?",
      userId,
    );

    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      deviceId: row.device_id,
      signalDeviceId: row.signal_device_id,
      updatedAt: row.updated_at,
    };
  }

  async saveLocalE2EEMessage(message: LocalE2EEMessage): Promise<void> {
    const database = await this.ready();
    await database.runAsync(
      `INSERT INTO e2ee_messages(
         id,
         pending_message_id,
         client_message_id,
         chat_id,
         peer_user_id,
         direction,
         sender_user_id,
         sender_device_id,
         sender_signal_device_id,
         receiver_device_id,
         receiver_signal_device_id,
         message_type,
         ciphertext,
         plaintext,
         status,
         created_at,
         delivered_at,
         acked_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         pending_message_id = excluded.pending_message_id,
         client_message_id = excluded.client_message_id,
         chat_id = excluded.chat_id,
         peer_user_id = excluded.peer_user_id,
         direction = excluded.direction,
         sender_user_id = excluded.sender_user_id,
         sender_device_id = excluded.sender_device_id,
         sender_signal_device_id = excluded.sender_signal_device_id,
         receiver_device_id = excluded.receiver_device_id,
         receiver_signal_device_id = excluded.receiver_signal_device_id,
         message_type = excluded.message_type,
         ciphertext = excluded.ciphertext,
         plaintext = excluded.plaintext,
         status = excluded.status,
         created_at = excluded.created_at,
         delivered_at = excluded.delivered_at,
         acked_at = excluded.acked_at`,
      message.id,
      message.pendingMessageId ?? null,
      message.clientMessageId ?? null,
      message.chatId ?? null,
      message.peerUserId,
      message.direction,
      message.senderUserId,
      message.senderDeviceId ?? null,
      message.senderSignalDeviceId ?? null,
      message.receiverDeviceId ?? null,
      message.receiverSignalDeviceId ?? null,
      message.messageType,
      message.ciphertext,
      message.plaintext,
      message.status,
      message.createdAt,
      message.deliveredAt ?? null,
      message.ackedAt ?? null,
    );
  }

  async getLocalE2EEMessageByPendingId(pendingMessageId: string): Promise<LocalE2EEMessage | null> {
    const database = await this.ready();
    const row = await database.getFirstAsync<LocalE2EEMessageRow>(
      "SELECT * FROM e2ee_messages WHERE pending_message_id = ?",
      pendingMessageId,
    );

    return row ? this.mapLocalE2EEMessage(row) : null;
  }

  async listLocalE2EEMessages(peerUserId: string): Promise<LocalE2EEMessage[]> {
    const database = await this.ready();
    const rows = await database.getAllAsync<LocalE2EEMessageRow>(
      "SELECT * FROM e2ee_messages WHERE peer_user_id = ? ORDER BY created_at ASC, id ASC",
      peerUserId,
    );

    return rows.map((row) => this.mapLocalE2EEMessage(row));
  }

  async withTransaction<T>(task: () => Promise<T>): Promise<T> {
    const database = await this.ready();
    let result!: T;
    await database.withTransactionAsync(async () => {
      result = await task();
    });
    return result;
  }

  private async ready(): Promise<SQLite.SQLiteDatabase> {
    await this.init();
    return this.getDatabase();
  }

  private async getDatabase(): Promise<SQLite.SQLiteDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = SQLite.openDatabaseAsync("signal.db");
    }

    return this.databasePromise;
  }

  private mapLocalE2EEMessage(row: LocalE2EEMessageRow): LocalE2EEMessage {
    return {
      id: row.id,
      pendingMessageId: row.pending_message_id,
      clientMessageId: row.client_message_id,
      chatId: row.chat_id,
      peerUserId: row.peer_user_id,
      direction: row.direction as LocalE2EEMessage["direction"],
      senderUserId: row.sender_user_id,
      senderDeviceId: row.sender_device_id,
      senderSignalDeviceId: row.sender_signal_device_id,
      receiverDeviceId: row.receiver_device_id,
      receiverSignalDeviceId: row.receiver_signal_device_id,
      messageType: row.message_type,
      ciphertext: row.ciphertext,
      plaintext: row.plaintext,
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      ackedAt: row.acked_at,
    };
  }
}

export const DB = new DatabaseService();
