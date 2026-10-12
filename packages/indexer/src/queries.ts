/**
 * Reads for the API: coins, trades, candles and totals, shaped for clients.
 *
 * Amounts leave as decimal strings in base units. A price is a plain number:
 * quote base units per token base unit, precise enough to chart.
 */
import type { Address } from "@archpad/sdk";
import type { Queryable, Row } from "./db.ts";
import type { TradeRecord } from "./ingest.ts";

export interface CoinView {
  mint: Address;
  creator: Address;
  quoteMint: Address;
  name: string;
  symbol: string;
  image: string;
  description: string;
  /** SHA-256 of the coin's off-chain metadata document, as hex. All zeros if it has none. */
  metadataHash: string;
  tokenDecimals: number;
  totalSupply: string;
  curveSupply: string;
  status: "trading" | "graduated";
  createdAt: number;
  createdTxid: string;
  graduatedAt: number | null;
  /** Quote base units per token base unit. */
  price: number;
  /** The reserves that set the price: the curve's while trading, the pool's after. */
  priceQuote: string;
  priceToken: string;
  /** Price times total supply, in quote base units. */
  marketCapQuote: string;
  /** Quote the curve has taken in so far. */
  raisedQuote: string;
  /** Quote the curve takes in before it graduates. */
  graduationQuote: string;
  /** Curve tokens still unsold. */
  curveTokensLeft: string;
  /** Share of the curve sold, in basis points. 10000 once graduated. */
  progressBps: number;
  platformFeeBps: number;
  creatorFeeBps: number;
  poolFeeBps: number;
  /** Unix time the launch window closes. Before it, each wallet is capped. */
  earlyWindowEnd: number;
  earlyWalletCap: string;
  tradeCount: number;
  volumeQuote: string;
  lastTradeAt: number | null;
  /** Fees this coin has earned its creator, claimed or not. */
  creatorFees: string;
}

const COIN_COLUMNS = `
  c.mint, c.creator, c.quote_mint, c.name, c.symbol, c.image, c.description, c.metadata_hash,
  c.token_decimals, c.total_supply::text AS total_supply, c.curve_supply::text AS curve_supply,
  c.graduation_quote::text AS graduation_quote,
  c.platform_fee_bps, c.creator_fee_bps, c.pool_fee_bps,
  c.early_window_end::text AS early_window_end, c.early_wallet_cap::text AS early_wallet_cap,
  c.created_at::text AS created_at, c.created_txid, c.graduated_at::text AS graduated_at,
  c.price_quote::text AS price_quote, c.price_token::text AS price_token,
  c.real_quote::text AS real_quote, c.real_token::text AS real_token,
  c.trade_count::text AS trade_count, c.volume_quote::text AS volume_quote,
  c.last_trade_at::text AS last_trade_at, c.creator_fees::text AS creator_fees`;

const text = (row: Row, key: string): string => String(row[key]);
const optionalNumber = (row: Row, key: string): number | null => (row[key] == null ? null : Number(row[key]));

function toCoin(row: Row): CoinView {
  const priceQuote = BigInt(text(row, "price_quote"));
  const priceToken = BigInt(text(row, "price_token"));
  const totalSupply = BigInt(text(row, "total_supply"));
  const curveSupply = BigInt(text(row, "curve_supply"));
  const realToken = BigInt(text(row, "real_token"));
  const graduatedAt = optionalNumber(row, "graduated_at");
  const sold = curveSupply - realToken;
  return {
    mint: text(row, "mint"),
    creator: text(row, "creator"),
    quoteMint: text(row, "quote_mint"),
    name: text(row, "name"),
    symbol: text(row, "symbol"),
    image: text(row, "image"),
    description: text(row, "description"),
    metadataHash: text(row, "metadata_hash"),
    tokenDecimals: Number(row["token_decimals"]),
    totalSupply: totalSupply.toString(),
    curveSupply: curveSupply.toString(),
    status: graduatedAt === null ? "trading" : "graduated",
    createdAt: Number(row["created_at"]),
    createdTxid: text(row, "created_txid"),
    graduatedAt,
    price: priceToken === 0n ? 0 : Number(priceQuote) / Number(priceToken),
    priceQuote: priceQuote.toString(),
    priceToken: priceToken.toString(),
    marketCapQuote: (priceToken === 0n ? 0n : (priceQuote * totalSupply) / priceToken).toString(),
    raisedQuote: text(row, "real_quote"),
    graduationQuote: text(row, "graduation_quote"),
    curveTokensLeft: realToken.toString(),
    progressBps: graduatedAt !== null || curveSupply === 0n ? 10_000 : Number((sold * 10_000n) / curveSupply),
    platformFeeBps: Number(row["platform_fee_bps"]),
    creatorFeeBps: Number(row["creator_fee_bps"]),
    poolFeeBps: Number(row["pool_fee_bps"]),
    earlyWindowEnd: Number(row["early_window_end"]),
    earlyWalletCap: text(row, "early_wallet_cap"),
    tradeCount: Number(row["trade_count"]),
    volumeQuote: text(row, "volume_quote"),
    lastTradeAt: optionalNumber(row, "last_trade_at"),
    creatorFees: text(row, "creator_fees"),
  };
}

export type CoinSort = "new" | "trending" | "graduating" | "graduated" | "active";

export interface CoinQuery {
  sort?: CoinSort;
  /** Only coins priced in this asset. */
  quoteMint?: Address;
  /** Only coins launched by this wallet. */
  creator?: Address;
  /** Matches a name or ticker fragment, or a whole mint address. */
  search?: string;
  limit?: number;
  offset?: number;
  /** Current Unix time, for the trending window. */
  now?: number;
}

/** How far back "trending" looks, in seconds. */
export const TRENDING_WINDOW_SECS = 3_600;

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.max(1, Math.min(max, Math.floor(value ?? fallback)));

export async function listCoins(db: Queryable, query: CoinQuery = {}): Promise<CoinView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.quoteMint) where.push(`c.quote_mint = ${param(query.quoteMint)}`);
  if (query.creator) where.push(`c.creator = ${param(query.creator)}`);
  if (query.search?.trim()) {
    const term = query.search.trim();
    // Escape the characters LIKE treats as wildcards, so a search for "100%" means that.
    const like = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const fragment = param(like);
    where.push(`(c.name ILIKE ${fragment} OR c.symbol ILIKE ${fragment} OR c.mint = ${param(term)})`);
  }

  let join = "";
  let order: string;
  switch (query.sort ?? "new") {
    case "trending": {
      // Ranked by how many different wallets traded it lately, which is
      // harder to fake than raw volume, then by how many trades.
      const since = param((query.now ?? Math.floor(Date.now() / 1000)) - TRENDING_WINDOW_SECS);
      join = `LEFT JOIN (
                SELECT mint, COUNT(DISTINCT trader) AS traders, COUNT(*) AS trades
                FROM trades WHERE timestamp >= ${since} GROUP BY mint
              ) recent ON recent.mint = c.mint`;
      order = "COALESCE(recent.traders, 0) DESC, COALESCE(recent.trades, 0) DESC, c.last_trade_at DESC NULLS LAST, c.mint";
      break;
    }
    case "graduating":
      // Closest to selling out first.
      where.push("c.graduated_at IS NULL");
      order = "(c.real_token / NULLIF(c.curve_supply, 0)) ASC, c.created_at DESC, c.mint";
      break;
    case "graduated":
      where.push("c.graduated_at IS NOT NULL");
      order = "c.graduated_at DESC, c.mint";
      break;
    case "active":
      order = "c.last_trade_at DESC NULLS LAST, c.mint";
      break;
    default:
      order = "c.created_at DESC, c.created_height DESC, c.mint";
  }

  const limit = param(clamp(query.limit, 24, 100));
  const offset = param(Math.max(0, Math.floor(query.offset ?? 0)));
  const rows = await db.query(
    `SELECT ${COIN_COLUMNS} FROM coins c ${join}
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return rows.map(toCoin);
}

export async function getCoin(db: Queryable, mint: Address): Promise<CoinView | null> {
  const [row] = await db.query(`SELECT ${COIN_COLUMNS} FROM coins c WHERE c.mint = $1`, [mint]);
  return row ? toCoin(row) : null;
}

/** The coins among `mints` that were launched here, keyed by mint. */
export async function getCoins(db: Queryable, mints: Address[]): Promise<Map<Address, CoinView>> {
  if (mints.length === 0) return new Map();
  const rows = await db.query(`SELECT ${COIN_COLUMNS} FROM coins c WHERE c.mint = ANY($1::text[])`, [mints]);
  return new Map(rows.map((row) => [text(row, "mint"), toCoin(row)]));
}

function toTrade(row: Row): TradeRecord {
  return {
    id: text(row, "id"),
    height: Number(row["height"]),
    txid: text(row, "txid"),
    mint: text(row, "mint"),
    trader: text(row, "trader"),
    venue: row["on_pool"] ? "pool" : "curve",
    side: row["is_buy"] ? "buy" : "sell",
    quoteAmount: text(row, "quote_amount"),
    tokenAmount: text(row, "token_amount"),
    feeQuote: text(row, "fee_quote"),
    price: Number(row["price"]),
    timestamp: Number(row["timestamp"]),
  };
}

const TRADE_COLUMNS = `id::text AS id, height::text AS height, txid, mint, trader, on_pool, is_buy,
  quote_amount::text AS quote_amount, token_amount::text AS token_amount, fee_quote::text AS fee_quote,
  price, timestamp::text AS timestamp`;

export interface TradeQuery {
  mint?: Address;
  trader?: Address;
  /** Only trades older than this trade ID. For paging backwards. */
  before?: string;
  limit?: number;
}

/** Trades, newest first. */
export async function listTrades(db: Queryable, query: TradeQuery = {}): Promise<TradeRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.mint) where.push(`mint = $${params.push(query.mint)}`);
  if (query.trader) where.push(`trader = $${params.push(query.trader)}`);
  if (query.before && /^\d+$/.test(query.before)) where.push(`id < $${params.push(query.before)}`);
  const limit = `$${params.push(clamp(query.limit, 50, 200))}`;
  const rows = await db.query(
    `SELECT ${TRADE_COLUMNS} FROM trades ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY id DESC LIMIT ${limit}`,
    params,
  );
  return rows.map(toTrade);
}

export interface Candle {
  /** Unix time the candle opens. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote traded during the candle, in base units. */
  volume: string;
}

/** Candle widths the API accepts, in seconds. */
export const CANDLE_INTERVALS = [1, 5, 15, 60, 300, 900, 3_600, 14_400, 86_400] as const;

/**
 * Price candles for a coin, oldest first. Each candle opens where the one
 * before it closed, so the chart is continuous through quiet periods.
 */
export async function getCandles(
  db: Queryable,
  mint: Address,
  interval: number,
  options: { to?: number; limit?: number } = {},
): Promise<Candle[]> {
  if (!CANDLE_INTERVALS.includes(interval as (typeof CANDLE_INTERVALS)[number])) {
    throw new RangeError(`unsupported candle interval ${interval}`);
  }
  const params: unknown[] = [mint, interval];
  const until = options.to === undefined ? "" : `AND timestamp < $${params.push(Math.floor(options.to))}`;
  const limit = `$${params.push(clamp(options.limit, 300, 1_000))}`;
  const rows = await db.query(
    `SELECT bucket::text AS bucket, o, h, l, c, v::text AS v FROM (
       SELECT (timestamp / $2) * $2 AS bucket,
              (array_agg(price ORDER BY id ASC))[1] AS o,
              MAX(price) AS h,
              MIN(price) AS l,
              (array_agg(price ORDER BY id DESC))[1] AS c,
              SUM(quote_amount) AS v
       FROM trades WHERE mint = $1 ${until}
       GROUP BY bucket ORDER BY bucket DESC LIMIT ${limit}
     ) newest ORDER BY bucket ASC`,
    params,
  );
  if (rows.length === 0) return [];

  // What the price was just before the first candle: the last trade before
  // it, or the launch price if the first candle is the coin's first.
  const first = Number(rows[0]!["bucket"]);
  const [before] = await db.query(
    "SELECT price FROM trades WHERE mint = $1 AND timestamp < $2 ORDER BY id DESC LIMIT 1",
    [mint, first],
  );
  let previous: number;
  if (before) {
    previous = Number(before["price"]);
  } else {
    const [coin] = await db.query(
      "SELECT initial_virtual_quote::text AS q, initial_virtual_token::text AS t FROM coins WHERE mint = $1",
      [mint],
    );
    previous = coin ? Number(coin["q"]) / Number(coin["t"]) : Number(rows[0]!["o"]);
  }

  return rows.map((row) => {
    const open = previous;
    const close = Number(row["c"]);
    previous = close;
    return {
      time: Number(row["bucket"]),
      open,
      high: Math.max(open, Number(row["h"])),
      low: Math.min(open, Number(row["l"])),
      close,
      volume: text(row, "v"),
    };
  });
}

export interface QuoteTotals {
  quoteMint: Address;
  coins: number;
  graduated: number;
  trades: number;
  volumeQuote: string;
  /** Platform fees charged on trades. */
  platformFees: string;
  /** Of those, how much has been sent on to the treasury. */
  platformFeesWithdrawn: string;
  creatorFees: string;
  creatorFeesClaimed: string;
}

export interface Totals {
  coins: number;
  graduated: number;
  trades: number;
  traders: number;
  byQuote: QuoteTotals[];
}

/** Platform-wide totals, per quote asset: volumes in different assets do not add up. */
export async function getTotals(db: Queryable): Promise<Totals> {
  const perQuote = await db.query(
    `SELECT c.quote_mint,
            COUNT(*)::text AS coins,
            COUNT(c.graduated_at)::text AS graduated,
            COALESCE(SUM(c.trade_count), 0)::text AS trades,
            COALESCE(SUM(c.volume_quote), 0)::text AS volume,
            COALESCE(SUM(c.platform_fees), 0)::text AS platform_fees,
            COALESCE(SUM(c.creator_fees), 0)::text AS creator_fees
     FROM coins c GROUP BY c.quote_mint ORDER BY c.quote_mint`,
  );
  const paid = await db.query(
    `SELECT quote_mint, (mint IS NULL) AS platform, COALESCE(SUM(amount), 0)::text AS amount
     FROM payouts GROUP BY quote_mint, (mint IS NULL)`,
  );
  const paidOut = (quoteMint: string, platform: boolean): string =>
    text(paid.find((row) => row["quote_mint"] === quoteMint && Boolean(row["platform"]) === platform) ?? { amount: "0" }, "amount");

  const [traders] = await db.query("SELECT COUNT(DISTINCT trader)::text AS n FROM trades");
  const byQuote: QuoteTotals[] = perQuote.map((row) => ({
    quoteMint: text(row, "quote_mint"),
    coins: Number(row["coins"]),
    graduated: Number(row["graduated"]),
    trades: Number(row["trades"]),
    volumeQuote: text(row, "volume"),
    platformFees: text(row, "platform_fees"),
    platformFeesWithdrawn: paidOut(text(row, "quote_mint"), true),
    creatorFees: text(row, "creator_fees"),
    creatorFeesClaimed: paidOut(text(row, "quote_mint"), false),
  }));
  return {
    coins: byQuote.reduce((total, quote) => total + quote.coins, 0),
    graduated: byQuote.reduce((total, quote) => total + quote.graduated, 0),
    trades: byQuote.reduce((total, quote) => total + quote.trades, 0),
    traders: Number(traders?.["n"] ?? 0),
    byQuote,
  };
}
