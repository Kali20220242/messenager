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
        plaintext TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        address TEXT PRIMARY KEY NOT NULL,
        session_data TEXT NOT NULL,
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

      CREATE INDEX IF NOT EXISTS idx_messages_chat_id_created_at
      ON messages (chat_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_trusted_identities_address
      ON trusted_identities (address);
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
}

export const DB = new DatabaseService();
