/**
 * The indexer and API against the real chain (PRD modules: UI data, UI-1 to
 * UI-3; wallet profile WA-3).
 *
 * A fresh indexer reads the local chain from its first block, which by now
 * holds everything the earlier test files did. Its picture of every coin has
 * to match the chain's own accounts.
 */
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CurveStatus } from "@archpad/sdk";
import { type CoinView, type Service, type TradeRecord, startService } from "@archpad/indexer";
import { type Chain, connect, launchCoin, newWallet, waitUntil } from "../src/harness.ts";

let chain: Chain;
let service: Service;
let base: string;

const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

/** Waits until the indexer has stored the chain's current finalized block. */
async function caughtUp(): Promise<void> {
  const target = await chain.rpc.getFinalizedHeight();
  for (let i = 0; i < 600; i++) {
    if (service.follower.height >= target) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the indexer stopped at block ${service.follower.height}, short of ${target}`);
}

beforeAll(async () => {
  chain = await connect();
  service = await startService({
    network: "localnet",
    bitcoinNetwork: chain.deployment.bitcoinNetwork,
    rpcUrl: chain.rpc.url,
    programs: chain.deployment.programs,
    quotes: chain.deployment.quotes,
    startHeight: 0,
    databaseUrl: "pglite:",
    dataDir: mkdtempSync(join(tmpdir(), "archpad-e2e-uploads-")),
    publicUrl: "http://localhost",
  });
  await service.api.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(service.api.app.server.address() as AddressInfo).port}`;
  await caughtUp();
});

afterAll(async () => {
  await service?.close();
});

describe("the indexer", () => {
  it("agrees with the chain about every coin it has indexed", async () => {
    const { client } = chain;
    const all: CoinView[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = (await get<{ coins: CoinView[] }>(`/v1/coins?limit=100&offset=${offset}`)).coins;
      all.push(...page);
      if (page.length < 100) break;
    }
    expect(all.length).toBeGreaterThan(0);

    let graduated = 0;
    for (const coin of all) {
      const onChain = (await client.getCoin(coin.mint))!;
      const { curve, pool, metadata } = onChain;
      expect(coin).toMatchObject({
        creator: curve.creator,
        quoteMint: curve.quoteMint,
        name: metadata!.name,
        symbol: metadata!.symbol,
        image: metadata!.image,
        totalSupply: curve.totalSupply.toString(),
        raisedQuote: curve.realQuote.toString(),
        curveTokensLeft: curve.realToken.toString(),
        createdAt: Number(curve.launchedAt),
        platformFeeBps: curve.platformFeeBps,
        creatorFeeBps: curve.creatorFeeBps,
      });
      if (curve.status === CurveStatus.Graduated) {
        graduated++;
        // After graduation the price is the pool's reserves.
        expect(coin).toMatchObject({
          status: "graduated",
          graduatedAt: Number(curve.graduatedAt),
          progressBps: 10_000,
          priceQuote: pool!.quoteReserve.toString(),
          priceToken: pool!.tokenReserve.toString(),
        });
      } else {
        expect(coin).toMatchObject({
          status: "trading",
          graduatedAt: null,
          priceQuote: curve.virtualQuote.toString(),
          priceToken: curve.virtualToken.toString(),
        });
      }
    }

    const stats = await get<{ coins: number; graduated: number }>("/v1/stats");
    expect(stats.coins).toBe(all.length);
    expect(stats.graduated).toBe(graduated);
    console.log(`checked ${all.length} coins against the chain (${graduated} graduated)`);
  });

  it("identifies each trade by the transaction the node knows it as", async () => {
    const { trades } = await get<{ trades: TradeRecord[] }>("/v1/trades?limit=20");
    expect(trades.length).toBeGreaterThan(0);
    for (const trade of trades.slice(0, 5)) {
      const processed = await chain.rpc.getProcessedTransaction(trade.txid);
      expect(processed?.status.type).toBe("processed");
    }
  });

  it("streams a launch and its trades as they happen, and serves them afterwards", async () => {
    const { client } = chain;
    const socket = new WebSocket(`${base.replace("http", "ws")}/v1/stream`);
    const messages: { type: string; coin: CoinView | null; trade?: TradeRecord; mint?: string }[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const { mint, creator, plan } = await launchCoin(chain, { label: "Indexed" });
    const curve = (await client.getCurve(mint))!;
    await waitUntil(chain, curve.earlyWindowEnd);
    const trader = await newWallet(chain, { btc: 50_000_000n });
    const buy = client.planCurveBuy(trader.address, curve, 2_000_000n, 100);
    await client.sendAndConfirm(buy.instructions, [trader]);
    const sell = client.planCurveSell(trader.address, (await client.getCurve(mint))!, buy.quote.tokensOut / 4n, 100);
    await client.sendAndConfirm(sell.instructions, [trader]);
    await caughtUp();

    // UI-2: the live feed saw the coin appear and each trade, in order.
    const mine = messages.filter((message) => (message.trade?.mint ?? message.mint) === mint);
    expect(mine.map((message) => message.type)).toEqual(["coin", "trade", "trade", "trade"]);
    expect(mine[1]!.trade).toMatchObject({ trader: creator.address, side: "buy", tokenAmount: plan.creatorBuy.tokensOut.toString() });
    expect(mine[2]!.trade).toMatchObject({ trader: trader.address, side: "buy", quoteAmount: buy.quote.quoteToCurve.toString() });
    expect(mine[3]!.trade).toMatchObject({ trader: trader.address, side: "sell", quoteAmount: sell.quote.quoteFromCurve.toString() });
    // Each message carries the coin as it stood after that trade.
    expect(mine[3]!.coin).toMatchObject({ mint, tradeCount: 3 });
    socket.close();

    // UI-1: it is the newest coin on the home page lists.
    const newest = await get<{ coins: CoinView[] }>("/v1/coins?sort=new&limit=1");
    expect(newest.coins[0]!.mint).toBe(mint);
    const trending = await get<{ coins: CoinView[] }>("/v1/coins?sort=trending&limit=50");
    expect(trending.coins.map((coin) => coin.mint)).toContain(mint);

    // UI-2: the coin page's data.
    const { coin } = await get<{ coin: CoinView }>(`/v1/coins/${mint}`);
    const now = (await client.getCurve(mint))!;
    expect(coin).toMatchObject({ tradeCount: 3, raisedQuote: now.realQuote.toString(), status: "trading" });
    // UI-3: progress toward graduation.
    expect(coin.progressBps).toBe(Number(((now.curveSupply - now.realToken) * 10_000n) / now.curveSupply));
    expect(coin.progressBps).toBeGreaterThan(0);

    const { trades } = await get<{ trades: TradeRecord[] }>(`/v1/coins/${mint}/trades`);
    expect(trades.map((trade) => trade.side)).toEqual(["sell", "buy", "buy"]);
    const { candles } = await get<{ candles: { open: number; close: number; volume: string }[] }>(
      `/v1/coins/${mint}/candles?interval=3600`,
    );
    expect(candles.length).toBeGreaterThanOrEqual(1);
    expect(candles.at(-1)!.close).toBeCloseTo(coin.price, 15);
    const traded = buy.quote.quoteToCurve + sell.quote.quoteFromCurve + plan.creatorBuy.quoteToCurve;
    expect(candles.reduce((total, candle) => total + BigInt(candle.volume), 0n)).toBe(traded);

    // Holders come straight from the chain's token accounts.
    const holders = await get<{ count: number; top: { owner: string; amount: string; label: string | null }[] }>(
      `/v1/coins/${mint}/holders`,
    );
    expect(holders.count).toBe(3);
    expect(holders.top[0]).toMatchObject({ owner: client.addresses.curve(mint), label: "curve" });
    expect(holders.top.find((holder) => holder.owner === creator.address)).toMatchObject({
      label: "creator",
      amount: plan.creatorBuy.tokensOut.toString(),
    });
    expect(holders.top.find((holder) => holder.owner === trader.address)?.amount).toBe(
      (await client.getTokenBalance(trader.address, mint)).toString(),
    );
    expect(holders.top.reduce((total, holder) => total + BigInt(holder.amount), 0n)).toBe(now.totalSupply);

    // WA-3: a wallet's profile.
    const profile = await get<{
      created: (CoinView & { unclaimedCreatorFees: string })[];
      holdings: { coin: CoinView; amount: string; valueQuote: string }[];
      quoteBalances: { mint: string; amount: string }[];
      trades: TradeRecord[];
    }>(`/v1/wallets/${creator.address}`);
    expect(profile.created.map((entry) => entry.mint)).toEqual([mint]);
    expect(profile.created[0]!.unclaimedCreatorFees).toBe((await client.getUnclaimedCreatorFees(mint)).toString());
    expect(profile.holdings).toHaveLength(1);
    expect(profile.holdings[0]).toMatchObject({ amount: plan.creatorBuy.tokensOut.toString() });
    expect(BigInt(profile.holdings[0]!.valueQuote)).toBeGreaterThan(0n);
    expect(profile.quoteBalances.map((balance) => balance.mint).sort()).toEqual([chain.btc, chain.usd].sort());
    expect(profile.trades).toHaveLength(1);
  });

  it("reports the network's launch terms from the chain's config", async () => {
    const config = (await chain.client.getConfig())!;
    const network = await get<{
      network: string;
      launchesPaused: boolean;
      launch: { platformFeeBps: number; creatorFeeBps: number; minCreatorBuyBps: number; earlyWalletCapBps: number };
      quotes: { mint: string; symbol: string; decimals: number; graduationQuote: string; paused: boolean }[];
      admins: { members: string[]; threshold: number };
    }>("/v1/network");
    expect(network.network).toBe("localnet");
    expect(network.launchesPaused).toBe(config.launchesPaused);
    expect(network.launch).toMatchObject({
      platformFeeBps: config.active.launch.platformFeeBps,
      creatorFeeBps: config.active.launch.creatorFeeBps,
      minCreatorBuyBps: config.active.launch.minCreatorBuyBps,
      earlyWalletCapBps: config.active.launch.earlyWalletCapBps,
    });
    expect(network.quotes.map((quote) => quote.symbol).sort()).toEqual(["BTC", "USD"]);
    expect(network.quotes.find((quote) => quote.symbol === "BTC")).toMatchObject({ mint: chain.btc, decimals: 8, paused: false });
    expect(network.admins).toEqual(config.active.admins);
  });
});
