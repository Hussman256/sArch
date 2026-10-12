import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Address, ArchRpc, ArchpadClient, ArchpadEvent, FullBlock } from "@archpad/sdk";
import { buildApi } from "../src/api.ts";
import { type Db, getMeta, openEmbedded } from "../src/db.ts";
import { ChainChangedError, Follower } from "../src/follower.ts";
import { type IngestContext, type Notification, applyBlock } from "../src/ingest.ts";
import { getCandles, getCoin, getTotals, listCoins, listTrades } from "../src/queries.ts";
import { UploadStore, canonicalDocument, documentHash } from "../src/uploads.ts";
import {
  ALICE,
  BOB,
  BTC,
  CREATOR,
  CURVE_SUPPLY,
  INITIAL_VIRTUAL_QUOTE,
  INITIAL_VIRTUAL_TOKEN,
  TOTAL_SUPPLY,
  USD,
  addresses,
  block,
  coinDetails,
  created,
  key,
  programs,
  trade,
  transaction,
} from "./helpers.ts";

const CAT = key(0xc1);
const DOG = key(0xc2);
const T0 = 1_800_000_000;

let db: Db;
/** What the "chain" knows about each coin. */
let chainCoins: Map<Address, ReturnType<typeof coinDetails>>;
let ctx: IngestContext;

// Starting the embedded database takes a few seconds, so one is shared by
// the whole file and emptied before each test.
beforeAll(async () => {
  db = await openEmbedded();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query("TRUNCATE coins, trades, payouts RESTART IDENTITY");
  await db.query("DELETE FROM meta WHERE key IN ('cursor', 'anchor')");
  chainCoins = new Map([
    [CAT, coinDetails(CAT)],
    [DOG, coinDetails(DOG, { quoteMint: USD }, { name: "Arch Dog", symbol: "ADOG" })],
  ]);
  ctx = { programs, loadCoin: async (mint) => chainCoins.get(mint) ?? null };
});

const apply = (b: FullBlock): Promise<Notification[]> => db.transaction((tx) => applyBlock(tx, b, ctx));

/** Reserves after `quote` has entered a fresh curve, by the constant-product rule. */
function after(quote: bigint) {
  const virtualQuote = INITIAL_VIRTUAL_QUOTE + quote;
  const virtualToken = (INITIAL_VIRTUAL_QUOTE * INITIAL_VIRTUAL_TOKEN) / virtualQuote + 1n;
  const sold = INITIAL_VIRTUAL_TOKEN - virtualToken;
  return { virtualQuote, virtualToken, realQuote: quote, realToken: CURVE_SUPPLY - sold, sold };
}

describe("storing what the chain did", () => {
  it("records a launch with the coin's details and its creator's first buy", async () => {
    const state = after(40_000n);
    const notes = await apply(
      block(10, [transaction([created(CAT, T0), trade(CAT, CREATOR, T0, state, { quote: 40_000n, token: state.sold })])]),
    );
    expect(notes.map((note) => note.type)).toEqual(["coin", "trade"]);

    const coin = (await getCoin(db, CAT))!;
    expect(coin).toMatchObject({
      mint: CAT,
      creator: CREATOR,
      quoteMint: BTC,
      name: "Arch Cat",
      symbol: "ACAT",
      status: "trading",
      createdAt: T0,
      graduatedAt: null,
      totalSupply: TOTAL_SUPPLY.toString(),
      raisedQuote: "40000",
      tradeCount: 1,
      volumeQuote: "40000",
      lastTradeAt: T0,
      creatorFees: "500",
      platformFeeBps: 100,
      creatorFeeBps: 125,
      poolFeeBps: 30,
    });
    expect(coin.createdTxid).toMatch(/^[0-9a-f]{64}$/);
    expect(coin.price).toBeCloseTo(Number(state.virtualQuote) / Number(state.virtualToken), 20);
    expect(coin.marketCapQuote).toBe(((state.virtualQuote * TOTAL_SUPPLY) / state.virtualToken).toString());
    expect(coin.progressBps).toBe(Number((state.sold * 10_000n) / CURVE_SUPPLY));
    expect(BigInt(coin.graduationQuote)).toBeGreaterThan(14_000_000n);

    const [first] = await listTrades(db, { mint: CAT });
    expect(first).toMatchObject({
      mint: CAT,
      trader: CREATOR,
      venue: "curve",
      side: "buy",
      quoteAmount: "40000",
      tokenAmount: state.sold.toString(),
      feeQuote: "900",
      height: 10,
      timestamp: T0,
    });
    expect(first!.txid).toBe(coin.createdTxid);
  });

  it("follows price, progress and volume as a coin trades", async () => {
    await apply(block(10, [transaction([created(CAT, T0)])]));
    const one = after(100_000n);
    await apply(block(11, [transaction([trade(CAT, ALICE, T0 + 20, one, { quote: 100_000n, token: one.sold })])]));
    const two = after(60_000n);
    // Alice sells part of it back: 40,000 leaves the curve.
    await apply(
      block(12, [
        transaction([trade(CAT, ALICE, T0 + 30, two, { quote: 40_000n, token: two.realToken - one.realToken, isBuy: false })]),
      ]),
    );

    const coin = (await getCoin(db, CAT))!;
    expect(coin.tradeCount).toBe(2);
    expect(coin.volumeQuote).toBe("140000");
    expect(coin.raisedQuote).toBe("60000");
    expect(coin.lastTradeAt).toBe(T0 + 30);
    expect(coin.price).toBeCloseTo(Number(two.virtualQuote) / Number(two.virtualToken), 20);

    const trades = await listTrades(db, { mint: CAT });
    expect(trades.map((t) => t.side)).toEqual(["sell", "buy"]);
    // Paging backwards from the newest trade gives the one before it.
    expect((await listTrades(db, { mint: CAT, before: trades[0]!.id })).map((t) => t.id)).toEqual([trades[1]!.id]);
    expect(await listTrades(db, { trader: BOB })).toEqual([]);
  });

  it("ignores a transaction the chain rejected, whatever it recorded before failing", async () => {
    const state = after(40_000n);
    const failed = transaction([created(CAT, T0), trade(CAT, CREATOR, T0, state, { quote: 40_000n, token: state.sold })], {
      type: "failed",
      message: "custom program error: 0x131",
    });
    expect(await apply(block(10, [failed]))).toEqual([]);
    expect(await getCoin(db, CAT)).toBeNull();
    expect(await listTrades(db)).toEqual([]);
  });

  it("keeps several events from one transaction apart and in order", async () => {
    await apply(block(10, [transaction([created(CAT, T0)])]));
    const steps = [10_000n, 20_000n, 30_000n].map(after);
    await apply(
      block(11, [
        transaction(steps.map((state, i) => trade(CAT, ALICE, T0 + 20, state, { quote: 10_000n, token: 1_000n + BigInt(i) }))),
      ]),
    );
    const trades = await listTrades(db, { mint: CAT });
    expect(trades.map((t) => t.tokenAmount)).toEqual(["1002", "1001", "1000"]);
    expect(new Set(trades.map((t) => t.txid)).size).toBe(1);
    expect((await getCoin(db, CAT))!.raisedQuote).toBe("30000");
  });

  it("switches to the pool's price when a coin graduates", async () => {
    await apply(block(10, [transaction([created(CAT, T0)])]));
    const full = { virtualQuote: 19_167_560n, virtualToken: 279_900_000_000_000n, realQuote: 14_167_560n, realToken: 0n };
    const poolTokens = TOTAL_SUPPLY - CURVE_SUPPLY;
    const graduated: ArchpadEvent = {
      type: "Graduated",
      mint: CAT,
      pool: addresses.pool(CAT),
      quoteAmount: full.realQuote,
      tokenAmount: poolTokens,
      timestamp: BigInt(T0 + 100),
    };
    const notes = await apply(
      block(11, [transaction([trade(CAT, ALICE, T0 + 100, full, { quote: 14_167_560n, token: CURVE_SUPPLY }), graduated])]),
    );
    expect(notes.map((note) => note.type)).toEqual(["trade", "graduated"]);

    let coin = (await getCoin(db, CAT))!;
    expect(coin).toMatchObject({ status: "graduated", graduatedAt: T0 + 100, progressBps: 10_000, curveTokensLeft: "0" });
    expect(coin.priceQuote).toBe(full.realQuote.toString());
    expect(coin.priceToken).toBe(poolTokens.toString());

    // A swap on the pool moves the price and counts as a trade.
    const swap: ArchpadEvent = {
      type: "PoolSwap",
      mint: CAT,
      trader: BOB,
      isBuy: true,
      quoteAmount: 1_000_000n,
      tokenAmount: 13_000_000_000_000n,
      lpFee: 2_000n,
      platformFee: 500n,
      creatorFee: 500n,
      quoteReserve: 15_169_560n,
      tokenReserve: 193_900_000_000_000n,
      timestamp: BigInt(T0 + 200),
    };
    await apply(block(12, [transaction([swap])]));
    coin = (await getCoin(db, CAT))!;
    expect(coin.priceQuote).toBe("15169560");
    expect(coin.tradeCount).toBe(2);
    expect(coin.raisedQuote).toBe(full.realQuote.toString());
    const [latest] = await listTrades(db, { mint: CAT });
    expect(latest).toMatchObject({ venue: "pool", side: "buy", feeQuote: "3000", trader: BOB });
  });

  it("picks up a coin it did not see launch", async () => {
    // The indexer was started after DOG launched. Its first sight of it is a trade.
    const state = after(75_000n);
    await apply(block(500, [transaction([trade(DOG, BOB, T0 + 900, state, { quote: 75_000n, token: state.sold })])]));
    const coin = (await getCoin(db, DOG))!;
    expect(coin).toMatchObject({ name: "Arch Dog", quoteMint: USD, createdAt: T0, raisedQuote: "75000", tradeCount: 1 });
    expect(coin.createdTxid).toBe("");

    // An event for a coin the chain has never heard of is a bug, not something to skip.
    await expect(apply(block(501, [transaction([created(key(0xee), T0)])]))).rejects.toThrow(/no curve/);
  });

  it("records fees paid out and adds everything up per quote asset", async () => {
    await apply(block(10, [transaction([created(CAT, T0)]), transaction([created(DOG, T0)])]));
    const state = after(200_000n);
    await apply(
      block(11, [
        transaction([trade(CAT, ALICE, T0 + 20, state, { quote: 200_000n, token: state.sold })]),
        transaction([trade(DOG, BOB, T0 + 21, state, { quote: 200_000n, token: state.sold })]),
        transaction([{ type: "CreatorFeesClaimed", mint: CAT, creator: CREATOR, amount: 2_500n, timestamp: BigInt(T0 + 30) }]),
        transaction([{ type: "PlatformFeesWithdrawn", quoteMint: BTC, amount: 2_000n, timestamp: BigInt(T0 + 31) }]),
      ]),
    );
    const totals = await getTotals(db);
    expect(totals).toMatchObject({ coins: 2, graduated: 0, trades: 2, traders: 2 });
    const btc = totals.byQuote.find((quote) => quote.quoteMint === BTC)!;
    expect(btc).toMatchObject({
      coins: 1,
      volumeQuote: "200000",
      platformFees: "2000",
      platformFeesWithdrawn: "2000",
      creatorFees: "2500",
      creatorFeesClaimed: "2500",
    });
    const usd = totals.byQuote.find((quote) => quote.quoteMint === USD)!;
    expect(usd).toMatchObject({ coins: 1, platformFeesWithdrawn: "0", creatorFeesClaimed: "0" });
  });
});

describe("candles", () => {
  it("open where the last one closed, and start from the launch price", async () => {
    await apply(block(10, [transaction([created(CAT, T0)])]));
    const prices: number[] = [];
    // Minute 0: two buys. Minute 1: nothing. Minute 2: a sell.
    const schedule: [number, bigint, boolean][] = [
      [T0 + 5, 100_000n, true],
      [T0 + 50, 300_000n, true],
      [T0 + 130, 200_000n, false],
    ];
    for (const [i, [timestamp, raised, isBuy]] of schedule.entries()) {
      const state = after(raised);
      prices.push(Number(state.virtualQuote) / Number(state.virtualToken));
      await apply(block(11 + i, [transaction([trade(CAT, ALICE, timestamp, state, { quote: 100_000n, token: 1n, isBuy })])]));
    }
    const launchPrice = Number(INITIAL_VIRTUAL_QUOTE) / Number(INITIAL_VIRTUAL_TOKEN);
    const minute = Math.floor(T0 / 60) * 60;

    const candles = await getCandles(db, CAT, 60);
    expect(candles.map((candle) => candle.time)).toEqual([minute, minute + 120]);
    expect(candles[0]).toMatchObject({ open: launchPrice, low: launchPrice, high: prices[1], close: prices[1], volume: "200000" });
    // The quiet minute has no candle; the next one opens at the last close.
    expect(candles[1]).toMatchObject({ open: prices[1], high: prices[1], low: prices[2], close: prices[2], volume: "100000" });

    // One wide candle covers the lot.
    const [hour] = await getCandles(db, CAT, 3_600);
    expect(hour).toMatchObject({ open: launchPrice, high: prices[1], low: launchPrice, close: prices[2], volume: "300000" });

    // Looking only at the past, the later candle is gone.
    expect(await getCandles(db, CAT, 60, { to: minute + 60 })).toHaveLength(1);
    expect(await getCandles(db, DOG, 60)).toEqual([]);
    await expect(getCandles(db, CAT, 7)).rejects.toThrow(RangeError);
  });
});

describe("lists", () => {
  beforeEach(async () => {
    const mints = [0xa1, 0xa2, 0xa3, 0xa4].map(key);
    for (const [i, mint] of mints.entries()) {
      chainCoins.set(mint, coinDetails(mint, { quoteMint: i === 3 ? USD : BTC, creator: i === 0 ? ALICE : CREATOR }, {
        name: ["Alpha", "Beta", "Gamma 100%", "Delta"][i]!,
        symbol: ["ALP", "BET", "GAM", "DEL"][i]!,
      }));
      await apply(block(10 + i, [transaction([created(mint, T0 + i * 10)])]));
    }
    const [alpha, beta, gamma] = mints as [Address, Address, Address, Address];
    // Alpha: one wallet trading a lot. Beta: three wallets once each. Gamma: nearly sold out.
    const small = after(50_000n);
    await apply(
      block(20, [
        transaction([
          trade(alpha, ALICE, T0 + 100, small, { quote: 50_000n, token: 1n }),
          trade(alpha, ALICE, T0 + 101, small, { quote: 50_000n, token: 1n }),
          trade(alpha, ALICE, T0 + 102, small, { quote: 50_000n, token: 1n }),
          trade(alpha, ALICE, T0 + 103, small, { quote: 50_000n, token: 1n }),
        ]),
        transaction([
          trade(beta, ALICE, T0 + 110, small, { quote: 50_000n, token: 1n }),
          trade(beta, BOB, T0 + 111, small, { quote: 50_000n, token: 1n }),
          trade(beta, CREATOR, T0 + 112, small, { quote: 50_000n, token: 1n }),
        ]),
        transaction([
          trade(gamma, BOB, T0 + 120, { ...after(13_000_000n), realToken: CURVE_SUPPLY / 20n }, { quote: 13_000_000n, token: 1n }),
        ]),
      ]),
    );
  });

  const names = async (query: Parameters<typeof listCoins>[1]) => (await listCoins(db, query)).map((coin) => coin.name);

  it("show the newest first by default", async () => {
    expect(await names({})).toEqual(["Delta", "Gamma 100%", "Beta", "Alpha"]);
    expect(await names({ limit: 2, offset: 1 })).toEqual(["Gamma 100%", "Beta"]);
  });

  it("rank trending by how many different wallets traded, not how often one did", async () => {
    expect(await names({ sort: "trending", now: T0 + 200 })).toEqual(["Beta", "Alpha", "Gamma 100%", "Delta"]);
    // An hour later none of those trades count, and it falls back to the latest activity.
    expect((await names({ sort: "trending", now: T0 + 5_000 }))[0]).toBe("Gamma 100%");
  });

  it("rank graduating by how close each curve is to selling out", async () => {
    expect((await names({ sort: "graduating" }))[0]).toBe("Gamma 100%");
    expect(await names({ sort: "graduated" })).toEqual([]);
  });

  it("filter by quote asset, creator and search text", async () => {
    expect(await names({ quoteMint: USD })).toEqual(["Delta"]);
    expect(await names({ creator: ALICE })).toEqual(["Alpha"]);
    expect(await names({ search: "bet" })).toEqual(["Beta"]);
    expect(await names({ search: "GAM" })).toEqual(["Gamma 100%"]);
    expect(await names({ search: key(0xa4) })).toEqual(["Delta"]);
    // A percent sign is searched for literally, not treated as a wildcard.
    expect(await names({ search: "100%" })).toEqual(["Gamma 100%"]);
    expect(await names({ search: "%" })).toEqual(["Gamma 100%"]);
    expect(await names({ search: "nothing like this" })).toEqual([]);
  });
});

describe("following the chain", () => {
  /** A stand-in node holding a fixed list of blocks. `name` tells one chain's block hashes from another's. */
  function fakeChain(blocks: Map<number, FullBlock>, finalized: { height: number }, name = "a") {
    const requested: number[][] = [];
    const rpc = {
      getFinalizedHeight: async () => finalized.height,
      getBlockHash: async (height: number) => {
        if (height > finalized.height) throw new Error("NOT FOUND");
        return `${name}${height}`.padEnd(64, "0");
      },
      getFullBlocks: async (heights: number[]) => {
        requested.push(heights);
        return heights.map((height) => blocks.get(height) ?? (height <= finalized.height ? block(height, []) : null));
      },
    } as unknown as ArchRpc;
    return { rpc, requested };
  }

  it("reads finalized blocks in order, once each, and picks up where it left off", async () => {
    const state = after(40_000n);
    const blocks = new Map<number, FullBlock>([
      [103, block(103, [transaction([created(CAT, T0)])])],
      [107, block(107, [transaction([trade(CAT, ALICE, T0 + 5, state, { quote: 40_000n, token: state.sold })])])],
    ]);
    const finalized = { height: 105 };
    const { rpc, requested } = fakeChain(blocks, finalized);
    const seen: Notification[] = [];
    const options = {
      programs,
      startHeight: 100,
      loadCoin: ctx.loadCoin,
      batchSize: 4,
      onNotifications: (notes: Notification[]) => seen.push(...notes),
    };

    const follower = new Follower(db, rpc, options);
    expect(await follower.catchUp()).toBe(4);
    expect(await follower.catchUp()).toBe(2);
    expect(await follower.catchUp()).toBe(0);
    expect(requested).toEqual([[100, 101, 102, 103], [104, 105]]);
    expect(follower.height).toBe(105);
    expect(await getMeta(db, "cursor")).toBe("105");
    expect(seen.map((note) => note.type)).toEqual(["coin"]);
    // Block 107 exists but is not finalized yet, so its trade is not stored.
    expect((await getCoin(db, CAT))!.tradeCount).toBe(0);

    // A restart resumes from the stored cursor instead of starting over.
    finalized.height = 108;
    const restarted = new Follower(db, rpc, { ...options, startHeight: 0 });
    expect(await restarted.catchUp()).toBe(3);
    expect(requested.at(-1)).toEqual([106, 107, 108]);
    expect((await getCoin(db, CAT))!.tradeCount).toBe(1);
    expect(seen.map((note) => note.type)).toEqual(["coin", "trade"]);
  });

  it("waits when the node cannot serve a block yet, rather than skipping it", async () => {
    const blocks = new Map<number, FullBlock>([[2, block(2, [transaction([created(CAT, T0)])])]]);
    const finalized = { height: 3 };
    const rpc = {
      getFinalizedHeight: async () => finalized.height,
      getBlockHash: async (height: number) => `a${height}`.padEnd(64, "0"),
      // The node claims height 3 but has only got as far as block 1.
      getFullBlocks: async (heights: number[]) => heights.map((height) => (height <= 1 ? block(height, []) : null)),
    } as unknown as ArchRpc;
    const follower = new Follower(db, rpc, { programs, startHeight: 0, loadCoin: ctx.loadCoin });
    expect(await follower.catchUp()).toBe(2);
    expect(follower.height).toBe(1);
    expect(await follower.catchUp()).toBe(0);
    expect(await getCoin(db, CAT)).toBeNull();

    // Once the node catches up, so do we.
    const caughtUp = fakeChain(blocks, finalized);
    const resumed = new Follower(db, caughtUp.rpc, { programs, startHeight: 0, loadCoin: ctx.loadCoin });
    expect(await resumed.catchUp()).toBe(2);
    expect(await getCoin(db, CAT)).not.toBeNull();
  });

  it("stores nothing from a block it could not finish", async () => {
    const state = after(40_000n);
    // The trade's coin cannot be read from the chain, so applying the block fails part way.
    const unknown = key(0xef);
    const blocks = new Map<number, FullBlock>([
      [1, block(1, [transaction([created(CAT, T0)]), transaction([trade(unknown, ALICE, T0, state, { quote: 1n, token: 1n })])])],
    ]);
    const { rpc } = fakeChain(blocks, { height: 1 });
    const follower = new Follower(db, rpc, { programs, startHeight: 0, loadCoin: ctx.loadCoin });
    await expect(follower.catchUp()).rejects.toThrow(/no curve/);
    // Neither the coin from the first transaction nor the cursor moved past block 0.
    expect(await getCoin(db, CAT)).toBeNull();
    expect(follower.height).toBe(0);
  });

  it("refuses to carry on against a different chain, unless told to start over", async () => {
    const blocks = new Map<number, FullBlock>([[2, block(2, [transaction([created(CAT, T0)])])]]);
    const options = { programs, startHeight: 0, loadCoin: ctx.loadCoin };
    const first = new Follower(db, fakeChain(blocks, { height: 5 }).rpc, options);
    expect(await first.catchUp()).toBe(6);
    expect(await getCoin(db, CAT)).not.toBeNull();
    expect(await getMeta(db, "anchor")).toBe(`0:${"a0".padEnd(64, "0")}`);

    // The same chain later, longer: carries on as normal.
    const later = new Follower(db, fakeChain(blocks, { height: 8 }).rpc, options);
    expect(await later.catchUp()).toBe(3);

    // The test network was wiped and restarted: same heights, different blocks, and DOG where CAT was.
    const reset = new Map<number, FullBlock>([[1, block(1, [transaction([created(DOG, T0)])])]]);
    const stopped = new Follower(db, fakeChain(reset, { height: 3 }, "b").rpc, options);
    await expect(stopped.catchUp()).rejects.toThrow(ChainChangedError);
    // Nothing was touched: the old data is still there for someone to look at.
    expect(await getCoin(db, CAT)).not.toBeNull();

    // A chain shorter than where the database began is also a different chain.
    const shorter = new Follower(db, fakeChain(reset, { height: -1 }, "a").rpc, options);
    await expect(shorter.catchUp()).rejects.toThrow(/different chain/);

    // Told to follow the chain wherever it goes, it empties the database and indexes the new one.
    const followed = new Follower(db, fakeChain(reset, { height: 3 }, "b").rpc, { ...options, onChainChanged: "reindex" });
    expect(await followed.catchUp()).toBe(4);
    expect(await getCoin(db, CAT)).toBeNull();
    expect(await getCoin(db, DOG)).not.toBeNull();
    expect(await getMeta(db, "anchor")).toBe(`0:${"b0".padEnd(64, "0")}`);
  });
});

describe("the API", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  async function api() {
    const directory = mkdtempSync(join(tmpdir(), "archpad-uploads-"));
    const client = {
      addresses,
      getConfig: async () => null,
      rpc: {
        getProgramAccounts: async () => [],
        getMultipleAccounts: async (list: Address[]) => list.map(() => null),
      },
    } as unknown as ArchpadClient;
    const built = await buildApi({
      db,
      client,
      uploads: new UploadStore(directory),
      network: "localnet",
      bitcoinNetwork: "regtest",
      programs,
      quotes: [{ symbol: "BTC", name: "Test Bitcoin", mint: BTC, decimals: 8 }],
      publicUrl: "http://api.test",
      progress: () => ({ height: 12, finalizedHeight: 15 }),
    });
    return { ...built, directory };
  }

  beforeEach(async () => {
    const state = after(40_000n);
    await apply(
      block(10, [transaction([created(CAT, T0), trade(CAT, CREATOR, T0, state, { quote: 40_000n, token: state.sold })])]),
    );
  });

  it("serves coins, trades and candles, and says clearly when asked for something that is not there", async () => {
    const { app } = await api();
    expect((await app.inject("/health")).json()).toEqual({ ok: true, height: 12, finalizedHeight: 15, behind: 3 });

    const list = (await app.inject("/v1/coins?sort=new")).json();
    expect(list.coins.map((coin: { mint: string }) => coin.mint)).toEqual([CAT]);

    const detail = (await app.inject(`/v1/coins/${CAT}`)).json();
    expect(detail.coin).toMatchObject({ symbol: "ACAT", links: {}, fullDescription: "The first cat on Arch." });

    expect((await app.inject(`/v1/coins/${CAT}/trades`)).json().trades).toHaveLength(1);
    expect((await app.inject(`/v1/coins/${CAT}/candles?interval=60`)).json().candles).toHaveLength(1);
    expect((await app.inject(`/v1/coins/${CAT}/holders`)).json()).toEqual({ count: 0, top: [] });
    expect((await app.inject("/v1/trades")).json().trades[0]).toMatchObject({ symbol: "ACAT", mint: CAT });
    expect((await app.inject("/v1/stats")).json()).toMatchObject({ coins: 1, trades: 1 });

    const profile = (await app.inject(`/v1/wallets/${CREATOR}`)).json();
    expect(profile.created).toHaveLength(1);
    expect(profile.created[0].unclaimedCreatorFees).toBe("0");
    expect(profile.trades).toHaveLength(1);

    const missing = await app.inject(`/v1/coins/${DOG}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatch(/no coin/);
    expect((await app.inject("/v1/coins/not-an-address")).statusCode).toBe(400);
    expect((await app.inject(`/v1/coins/${CAT}/candles?interval=7`)).statusCode).toBe(400);
    expect((await app.inject("/v1/coins?sort=sideways")).statusCode).toBe(400);
    expect((await app.inject("/v1/coins?limit=-1")).statusCode).toBe(400);
    await app.close();
  });

  it("accepts real images only, and serves them back locked down", async () => {
    const { app } = await api();
    const upload = await app.inject({ method: "POST", url: "/v1/uploads/image", headers: { "content-type": "image/png" }, payload: Buffer.from(png) });
    expect(upload.statusCode).toBe(200);
    const { url, name } = upload.json();
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(url).toBe(`http://api.test/files/${name}`);
    // Short enough to go on chain as the coin's image link.
    expect(url.length).toBeLessThanOrEqual(128);

    const served = await app.inject(`/files/${name}`);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["cache-control"]).toContain("immutable");
    expect(new Uint8Array(served.rawPayload)).toEqual(png);

    // A script dressed up as an image is refused, whatever it claims to be.
    const svg = await app.inject({
      method: "POST",
      url: "/v1/uploads/image",
      headers: { "content-type": "image/png" },
      payload: Buffer.from("<svg onload=alert(1)>"),
    });
    expect(svg.statusCode).toBe(400);
    expect(svg.json().error).toMatch(/PNG, JPEG, GIF or WebP/);
    expect((await app.inject("/files/..%2F..%2Fetc%2Fpasswd")).statusCode).toBe(404);
    expect((await app.inject(`/files/${"0".repeat(32)}.png`)).statusCode).toBe(404);
    await app.close();
  });

  it("stores a coin's metadata under its hash and attaches its links to the coin", async () => {
    const { app, directory } = await api();
    const document = {
      name: "Arch Cat",
      symbol: "ACAT",
      description: "The long version of the story. ".repeat(10),
      image: "http://api.test/files/abc.png",
      links: { website: "https://archcat.example/", x: "https://x.com/archcat", telegram: "https://t.me/archcat" },
    };
    const saved = await app.inject({ method: "POST", url: "/v1/uploads/metadata", payload: document });
    expect(saved.statusCode).toBe(200);
    const { hash } = saved.json();
    expect(hash).toBe(documentHash(canonicalDocument(document)));
    // The same content always gets the same hash, however the client ordered or padded it.
    const again = await app.inject({
      method: "POST",
      url: "/v1/uploads/metadata",
      payload: { links: document.links, image: document.image, symbol: " ACAT ", name: "Arch Cat", description: document.description },
    });
    expect(again.json().hash).toBe(hash);
    expect((await app.inject(`/v1/metadata/${hash}`)).json().links.x).toBe("https://x.com/archcat");

    // A coin launched with that hash gets the links and the full description.
    chainCoins.set(DOG, coinDetails(DOG, { metadataHash: hash }));
    await apply(block(11, [transaction([created(DOG, T0 + 10)])]));
    const coin = (await app.inject(`/v1/coins/${DOG}`)).json().coin;
    expect(coin.links).toEqual(document.links);
    expect(coin.fullDescription).toBe(document.description.trim());

    // If the stored file is altered, it no longer matches what the chain
    // committed to, and is not served as if it did.
    writeFileSync(join(directory, "documents", `${hash}.json`), JSON.stringify({ ...document, links: { website: "https://evil.example/" } }));
    expect((await app.inject(`/v1/metadata/${hash}`)).statusCode).toBe(404);
    expect((await app.inject(`/v1/coins/${DOG}`)).json().coin.links).toEqual({});

    // Links that could run code or point somewhere unexpected are refused.
    for (const links of [
      { website: "javascript:alert(1)" },
      { website: "http://plain.example/" },
      { x: "https://x.com.evil.example/archcat" },
      { telegram: "https://example.com/archcat" },
    ]) {
      const refused = await app.inject({ method: "POST", url: "/v1/uploads/metadata", payload: { ...document, links } });
      expect(refused.statusCode).toBe(400);
    }
    const noName = await app.inject({ method: "POST", url: "/v1/uploads/metadata", payload: { ...document, name: "  " } });
    expect(noName.json().error).toMatch(/name is required/);
    await app.close();
  });

  it("limits how many uploads one client can make", async () => {
    const { app } = await api();
    const post = () =>
      app.inject({ method: "POST", url: "/v1/uploads/image", headers: { "content-type": "image/png" }, payload: Buffer.from(png) });
    for (let i = 0; i < 20; i++) expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(429);
    await app.close();
  });
});
