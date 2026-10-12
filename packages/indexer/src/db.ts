/**
 * The indexer's database.
 *
 * Production runs on Postgres. Development and tests use PGlite, which is
 * Postgres compiled to run inside the Node process, so there is nothing to
 * install and the SQL is the same. Both sit behind the small interface here.
 *
 * Amounts are stored as NUMERIC and read back as text: they are 64-bit and
 * larger, which JavaScript numbers cannot hold.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs `work` in one transaction: all of it is stored, or none of it. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Bumped whenever the tables change shape. A database from another version is rebuilt from the chain. */
export const SCHEMA_VERSION = 1;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // One row per coin. The first block of columns is fixed at launch; the
  // second follows the coin as it trades.
  `CREATE TABLE IF NOT EXISTS coins (
     mint                  TEXT PRIMARY KEY,
     creator               TEXT NOT NULL,
     quote_mint            TEXT NOT NULL,
     name                  TEXT NOT NULL,
     symbol                TEXT NOT NULL,
     image                 TEXT NOT NULL,
     description           TEXT NOT NULL,
     metadata_hash         TEXT NOT NULL,
     token_decimals        INTEGER NOT NULL,
     total_supply          NUMERIC(20,0) NOT NULL,
     curve_supply          NUMERIC(20,0) NOT NULL,
     initial_virtual_quote NUMERIC(20,0) NOT NULL,
     initial_virtual_token NUMERIC(20,0) NOT NULL,
     graduation_quote      NUMERIC(20,0) NOT NULL,
     platform_fee_bps      INTEGER NOT NULL,
     creator_fee_bps       INTEGER NOT NULL,
     pool_fee_bps          INTEGER NOT NULL,
     early_window_end      BIGINT NOT NULL,
     early_wallet_cap      NUMERIC(20,0) NOT NULL,
     created_at            BIGINT NOT NULL,
     created_height        BIGINT NOT NULL,
     created_txid          TEXT NOT NULL,

     graduated_at          BIGINT,
     price_quote           NUMERIC(20,0) NOT NULL,
     price_token           NUMERIC(20,0) NOT NULL,
     real_quote            NUMERIC(20,0) NOT NULL,
     real_token            NUMERIC(20,0) NOT NULL,
     trade_count           BIGINT NOT NULL DEFAULT 0,
     volume_quote          NUMERIC(40,0) NOT NULL DEFAULT 0,
     last_trade_at         BIGINT,
     creator_fees          NUMERIC(40,0) NOT NULL DEFAULT 0,
     platform_fees         NUMERIC(40,0) NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS coins_by_created ON coins (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS coins_by_creator ON coins (creator)`,
  `CREATE INDEX IF NOT EXISTS coins_by_graduated ON coins (graduated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS coins_by_last_trade ON coins (last_trade_at DESC)`,

  // One row per trade, on the curve or on the pool. Rows are inserted in
  // chain order, so `id` orders them the way they happened.
  `CREATE TABLE IF NOT EXISTS trades (
     id                BIGSERIAL PRIMARY KEY,
     height            BIGINT NOT NULL,
     tx_index          INTEGER NOT NULL,
     instruction_index INTEGER NOT NULL,
     inner_index       INTEGER NOT NULL,
     txid              TEXT NOT NULL,
     mint              TEXT NOT NULL,
     trader            TEXT NOT NULL,
     on_pool           BOOLEAN NOT NULL,
     is_buy            BOOLEAN NOT NULL,
     quote_amount      NUMERIC(20,0) NOT NULL,
     token_amount      NUMERIC(20,0) NOT NULL,
     fee_quote         NUMERIC(20,0) NOT NULL,
     price             DOUBLE PRECISION NOT NULL,
     timestamp         BIGINT NOT NULL,
     UNIQUE (height, tx_index, instruction_index, inner_index)
   )`,
  `CREATE INDEX IF NOT EXISTS trades_by_mint ON trades (mint, id DESC)`,
  `CREATE INDEX IF NOT EXISTS trades_by_trader ON trades (trader, id DESC)`,
  `CREATE INDEX IF NOT EXISTS trades_by_time ON trades (timestamp)`,

  // Fees leaving the vaults: a creator claiming theirs (mint set), or the
  // platform's share going to the treasury (mint null).
  `CREATE TABLE IF NOT EXISTS payouts (
     id         BIGSERIAL PRIMARY KEY,
     height     BIGINT NOT NULL,
     txid       TEXT NOT NULL,
     mint       TEXT,
     quote_mint TEXT NOT NULL,
     recipient  TEXT,
     amount     NUMERIC(20,0) NOT NULL,
     timestamp  BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS payouts_by_mint ON payouts (mint)`,
];

async function migrate(db: Db): Promise<void> {
  await db.query(SCHEMA[0]!);
  const [found] = await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  if (found && Number(found.value) !== SCHEMA_VERSION) {
    // Everything here is derived from the chain, so the simplest correct
    // migration is to start again and index from the beginning.
    await db.query("DROP TABLE IF EXISTS coins, trades, payouts, meta CASCADE");
  }
  for (const statement of SCHEMA) await db.query(statement);
  await db.query(
    "INSERT INTO meta (key, value) VALUES ('schema_version', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [String(SCHEMA_VERSION)],
  );
}

/**
 * Opens an embedded database. With no directory it lives in memory and is
 * gone when the process exits, which is what tests want.
 */
export async function openEmbedded(directory?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (directory) mkdirSync(dirname(directory), { recursive: true });
  const pg = directory ? new PGlite(directory) : new PGlite();
  await pg.waitReady;

  const db: Db = {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await pg.query<T>(sql, params)).rows;
    },
    transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction((tx) =>
        work({
          async query<R extends Row>(sql: string, params: unknown[] = []) {
            return (await tx.query<R>(sql, params)).rows;
          },
        }),
      ) as Promise<T>;
    },
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

/** Connects to a Postgres server. */
export async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 10 });

  const db: Db = {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({
          async query<R extends Row>(sql: string, params: unknown[] = []) {
            return (await client.query(sql, params)).rows as R[];
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  await migrate(db);
  return db;
}

/** Opens the database named by a URL: `postgres://...`, or `pglite:<directory>`, or `pglite:` for in-memory. */
export function openDb(url: string): Promise<Db> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return openPostgres(url);
  if (url.startsWith("pglite:")) return openEmbedded(url.slice("pglite:".length) || undefined);
  throw new Error(`unsupported database URL "${url}": expected postgres://... or pglite:<directory>`);
}

/** Reads a value kept in the `meta` table. */
export async function getMeta(db: Queryable, key: string): Promise<string | null> {
  const [row] = await db.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [key]);
  return row?.value ?? null;
}

export async function setMeta(db: Queryable, key: string, value: string): Promise<void> {
  await db.query("INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [
    key,
    value,
  ]);
}
