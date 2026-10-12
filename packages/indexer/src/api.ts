/**
 * The HTTP and WebSocket API the web app talks to.
 *
 * Everything under /v1 is read-only except the two upload routes. Amounts are
 * decimal strings in base units; times are Unix seconds.
 */
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  type Address,
  type ArchpadClient,
  type ProgramIds,
  configuredQuotes,
  graduationQuote,
  isAddress,
  launchCurveParams,
} from "@archpad/sdk";
import { ChainReader } from "./chain.ts";
import type { Db } from "./db.ts";
import type { Notification } from "./ingest.ts";
import {
  CANDLE_INTERVALS,
  type CoinSort,
  type CoinView,
  getCandles,
  getCoin,
  getCoins,
  getTotals,
  listCoins,
  listTrades,
} from "./queries.ts";
import { MAX_IMAGE_BYTES, UploadError, type UploadStore } from "./uploads.ts";

/** A quote asset as published by the deployment. */
export interface QuoteInfo {
  symbol: string;
  name: string;
  mint: Address;
  decimals: number;
}

export interface ApiOptions {
  db: Db;
  client: ArchpadClient;
  uploads: UploadStore;
  network: string;
  bitcoinNetwork: string;
  programs: ProgramIds;
  quotes: QuoteInfo[];
  /** Where this API is reachable from a browser, for building image links. */
  publicUrl: string;
  /** How far the indexer has got. */
  progress: () => { height: number; finalizedHeight: number };
  /** Origins allowed to call the API from a browser. Defaults to any. */
  corsOrigin?: string[];
  /**
   * Local chains only: sends a wallet some lamports and test assets. When
   * absent, which it must be anywhere real, the route does not exist.
   */
  devFaucet?: (wallet: Address) => Promise<void>;
  logger?: boolean;
}

export interface Api {
  app: FastifyInstance;
  /** Pushes what a block just did to everyone listening on the stream. */
  publish(notes: Notification[]): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const SORTS: CoinSort[] = ["new", "trending", "graduating", "graduated", "active"];

function addressParam(value: unknown, what: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new HttpError(400, `${what} is not a valid address`);
  return value;
}

function optionalAddress(value: unknown, what: string): Address | undefined {
  return value === undefined || value === "" ? undefined : addressParam(value, what);
}

function numberParam(value: unknown, what: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new HttpError(400, `${what} must be a non-negative number`);
  return parsed;
}

/** Allows each client a fixed number of uploads per window. */
class UploadLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(client: string): void {
    const now = Date.now();
    const recent = (this.seen.get(client) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) throw new HttpError(429, "too many uploads; try again in a few minutes");
    recent.push(now);
    this.seen.set(client, recent);
    if (this.seen.size > 10_000) {
      for (const [key, times] of this.seen) {
        if (times.every((at) => now - at >= this.windowMs)) this.seen.delete(key);
      }
    }
  }
}

export async function buildApi(options: ApiOptions): Promise<Api> {
  const { db, client, uploads } = options;
  const chain = new ChainReader(client);
  const limiter = new UploadLimiter(20, 10 * 60_000);
  const listeners = new Map<WebSocket, Address | null>();

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_IMAGE_BYTES + 1_024 });
  await app.register(cors, { origin: options.corsOrigin ?? true });
  await app.register(websocket, { options: { maxPayload: 1_024 } });

  // Image uploads arrive as the raw file.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof UploadError) return reply.status(400).send({ error: error.message });
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: error.message });
    if (error instanceof RangeError) return reply.status(400).send({ error: error.message });
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    return reply.status(status).send({ error: status === 500 ? "something went wrong on our side" : error.message });
  });

  /** The on-chain config changes rarely; read it at most every few seconds. */
  let configCache: { at: number; value: ReturnType<ArchpadClient["getConfig"]> } | undefined;
  const chainConfig = () => {
    if (!configCache || Date.now() - configCache.at > 5_000) {
      configCache = { at: Date.now(), value: client.getConfig() };
      configCache.value.catch(() => (configCache = undefined));
    }
    return configCache.value;
  };

  /** Adds a coin's links from its metadata document, if we hold the document the chain committed to. */
  const withLinks = async (coin: CoinView) => {
    const document = /^0+$/.test(coin.metadataHash) ? null : await uploads.readDocument(coin.metadataHash);
    return {
      ...coin,
      fullDescription: document?.description ?? coin.description,
      links: document?.links ?? {},
    };
  };

  app.get("/health", async () => {
    const progress = options.progress();
    return { ok: true, ...progress, behind: Math.max(0, progress.finalizedHeight - progress.height) };
  });

  app.get("/v1/network", async () => {
    const config = await chainConfig();
    const known = new Map(options.quotes.map((quote) => [quote.mint, quote]));
    return {
      network: options.network,
      bitcoinNetwork: options.bitcoinNetwork,
      programs: options.programs,
      indexer: options.progress(),
      devFaucet: options.devFaucet !== undefined,
      initialised: config !== null,
      ...(config && {
        launchesPaused: config.launchesPaused,
        admins: config.active.admins,
        timelockSecs: config.active.timelockSecs,
        treasury: config.active.treasury,
        launch: {
          platformFeeBps: config.active.launch.platformFeeBps,
          creatorFeeBps: config.active.launch.creatorFeeBps,
          minCreatorBuyBps: config.active.launch.minCreatorBuyBps,
          earlyWalletCapBps: config.active.launch.earlyWalletCapBps,
          earlyWindowSecs: config.active.launch.earlyWindowSecs,
          tokenDecimals: config.active.launch.tokenDecimals,
          totalSupply: config.active.launch.totalSupply.toString(),
          curveSupply: config.active.launch.curveSupply.toString(),
          virtualTokenReserves: config.active.launch.virtualTokenReserves.toString(),
          poolFeeBps:
            config.active.launch.poolLpFeeBps +
            config.active.launch.poolPlatformFeeBps +
            config.active.launch.poolCreatorFeeBps,
        },
        quotes: configuredQuotes(config.active).map((quote) => ({
          mint: quote.mint,
          symbol: known.get(quote.mint)?.symbol ?? quote.mint.slice(0, 4),
          name: known.get(quote.mint)?.name ?? quote.mint,
          decimals: known.get(quote.mint)?.decimals ?? 0,
          paused: (config.pausedQuotes & (1 << quote.index)) !== 0,
          virtualQuoteReserves: quote.virtualQuoteReserves.toString(),
          graduationQuote: graduationQuote(launchCurveParams(config.active.launch, quote)).toString(),
        })),
      }),
    };
  });

  app.get("/v1/coins", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const sort = (query["sort"] ?? "new") as CoinSort;
    if (!SORTS.includes(sort)) throw new HttpError(400, `sort must be one of ${SORTS.join(", ")}`);
    const quoteMint = optionalAddress(query["quote"], "quote");
    const creator = optionalAddress(query["creator"], "creator");
    const limit = numberParam(query["limit"], "limit");
    const offset = numberParam(query["offset"], "offset");
    const search = query["q"]?.slice(0, 64);
    return {
      coins: await listCoins(db, {
        sort,
        ...(quoteMint && { quoteMint }),
        ...(creator && { creator }),
        ...(search && { search }),
        ...(limit !== undefined && { limit }),
        ...(offset !== undefined && { offset }),
      }),
    };
  });

  const coinOr404 = async (request: FastifyRequest): Promise<CoinView> => {
    const mint = addressParam((request.params as { mint: string }).mint, "mint");
    const coin = await getCoin(db, mint);
    if (!coin) throw new HttpError(404, "no coin with that address has been launched here");
    return coin;
  };

  app.get("/v1/coins/:mint", async (request) => ({ coin: await withLinks(await coinOr404(request)) }));

  app.get("/v1/coins/:mint/trades", async (request) => {
    const coin = await coinOr404(request);
    const query = request.query as Record<string, string | undefined>;
    const limit = numberParam(query["limit"], "limit");
    return {
      trades: await listTrades(db, {
        mint: coin.mint,
        ...(query["before"] && { before: query["before"] }),
        ...(limit !== undefined && { limit }),
      }),
    };
  });

  app.get("/v1/coins/:mint/candles", async (request) => {
    const coin = await coinOr404(request);
    const query = request.query as Record<string, string | undefined>;
    const interval = numberParam(query["interval"], "interval") ?? 60;
    if (!CANDLE_INTERVALS.includes(interval as (typeof CANDLE_INTERVALS)[number])) {
      throw new HttpError(400, `interval must be one of ${CANDLE_INTERVALS.join(", ")} seconds`);
    }
    const to = numberParam(query["to"], "to");
    const limit = numberParam(query["limit"], "limit");
    return {
      interval,
      candles: await getCandles(db, coin.mint, interval, {
        ...(to !== undefined && { to }),
        ...(limit !== undefined && { limit }),
      }),
    };
  });

  app.get("/v1/coins/:mint/holders", async (request) => chain.getHolders(await coinOr404(request)));

  app.get("/v1/trades", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = numberParam(query["limit"], "limit");
    const trades = await listTrades(db, {
      ...(query["before"] && { before: query["before"] }),
      ...(limit !== undefined && { limit }),
    });
    // A feed row needs the coin's name and picture, and the asset its
    // amount is in, not just the coin's address.
    const coins = await getCoins(db, [...new Set(trades.map((trade) => trade.mint))]);
    return {
      trades: trades.map((trade) => {
        const coin = coins.get(trade.mint);
        return {
          ...trade,
          symbol: coin?.symbol ?? "",
          name: coin?.name ?? "",
          image: coin?.image ?? "",
          quoteMint: coin?.quoteMint ?? "",
        };
      }),
    };
  });

  app.get("/v1/wallets/:address", async (request) => {
    const wallet = addressParam((request.params as { address: string }).address, "address");
    const [created, holdings, trades] = await Promise.all([
      listCoins(db, { creator: wallet, limit: 100 }),
      chain.getHoldings(wallet),
      listTrades(db, { trader: wallet, limit: 50 }),
    ]);

    const launched = await getCoins(db, [...new Set([...holdings.map((h) => h.mint), ...trades.map((t) => t.mint)])]);
    const unclaimed = await chain.getUnclaimedCreatorFees(created.map((coin) => coin.mint));
    const quotes = new Set(options.quotes.map((quote) => quote.mint));
    return {
      wallet,
      created: created.map((coin) => ({ ...coin, unclaimedCreatorFees: unclaimed.get(coin.mint) ?? "0" })),
      // Coins launched here that the wallet holds, each with what it is worth at the current price.
      holdings: holdings
        .filter((holding) => launched.has(holding.mint))
        .map((holding) => {
          const coin = launched.get(holding.mint)!;
          const priceToken = BigInt(coin.priceToken);
          return {
            coin,
            amount: holding.amount,
            valueQuote: (priceToken === 0n ? 0n : (BigInt(holding.amount) * BigInt(coin.priceQuote)) / priceToken).toString(),
          };
        }),
      // The wallet's balances of the assets coins are priced in.
      quoteBalances: holdings.filter((holding) => quotes.has(holding.mint)),
      trades: trades.map((trade) => ({
        ...trade,
        symbol: launched.get(trade.mint)?.symbol ?? "",
        quoteMint: launched.get(trade.mint)?.quoteMint ?? "",
      })),
    };
  });

  app.get("/v1/stats", async () => getTotals(db));

  if (options.devFaucet) {
    const fund = options.devFaucet;
    app.post("/v1/dev/fund", async (request) => {
      limiter.check(request.ip);
      const wallet = addressParam((request.body as { address?: unknown } | null)?.address, "address");
      await fund(wallet);
      return { ok: true };
    });
  }

  // --- uploads ---------------------------------------------------------------

  app.post("/v1/uploads/image", async (request) => {
    limiter.check(request.ip);
    if (!Buffer.isBuffer(request.body)) throw new HttpError(415, "send the image file as the request body");
    const stored = await uploads.saveImage(request.body);
    return { url: `${options.publicUrl}/files/${stored.name}`, name: stored.name };
  });

  app.post("/v1/uploads/metadata", async (request) => {
    limiter.check(request.ip);
    const { hash, document } = await uploads.saveDocument(request.body);
    return { hash, document };
  });

  app.get("/v1/metadata/:hash", async (request) => {
    const document = await uploads.readDocument((request.params as { hash: string }).hash);
    if (!document) throw new HttpError(404, "no metadata document with that hash");
    return document;
  });

  app.get("/files/:name", async (request, reply: FastifyReply) => {
    const image = await uploads.readImage((request.params as { name: string }).name);
    if (!image) throw new HttpError(404, "no such file");
    return reply
      .header("content-type", image.contentType)
      // The name is the hash of the contents, so the contents never change.
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'")
      .send(Buffer.from(image.bytes));
  });

  // --- live stream -----------------------------------------------------------

  // A client connects to /v1/stream for everything, or /v1/stream?mint=... for one coin.
  app.get("/v1/stream", { websocket: true }, (socket: WebSocket, request) => {
    const mint = (request.query as Record<string, string | undefined>)["mint"];
    listeners.set(socket, mint && isAddress(mint) ? mint : null);
    socket.on("close", () => listeners.delete(socket));
    socket.on("error", () => listeners.delete(socket));
  });

  const publish = async (notes: Notification[]): Promise<void> => {
    if (listeners.size === 0 || notes.length === 0) return;
    const mints = [...new Set(notes.map((note) => (note.type === "trade" ? note.trade.mint : note.mint)))];
    const coins = await getCoins(db, mints);
    for (const note of notes) {
      const mint = note.type === "trade" ? note.trade.mint : note.mint;
      // Each message carries the coin as it now stands, so a listener can
      // update its price and progress without asking again.
      const message = JSON.stringify({ ...note, coin: coins.get(mint) ?? null });
      for (const [socket, only] of listeners) {
        if (only !== null && only !== mint) continue;
        if (socket.readyState === socket.OPEN) socket.send(message);
      }
    }
  };

  return { app, publish };
}
