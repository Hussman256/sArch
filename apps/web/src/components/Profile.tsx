"use client";

/**
 * A wallet's page: what it holds and what that cost, the coins it launched
 * and what they have earned, what it has done lately, and, for the creator,
 * a way to claim their earnings.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { isAddress } from "@archpad/sdk";
import { type CoinView, type QuoteAsset, type TradeRecord, type WalletProfile, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { DOWN_COLOR, UP_COLOR, ident } from "@/lib/design-system.ts";
import { compactFixed, formatTokens, pct, shortAddress, timeAgo } from "@/lib/format.ts";
import { useLoaded, useNow } from "@/lib/hooks.ts";
import { type Money, btcText, toSats, toUsd } from "@/lib/money.ts";
import { Icon } from "./icons.tsx";
import { Bar, CoinImage, Notice, Skeleton, useCopy } from "./ui.tsx";

const TRADES_LIMIT = 50;
const DAY = 86_400;

type Amount = { amount: bigint; asset: QuoteAsset };

/** A total of amounts in different assets, in the display unit. Null if one cannot be converted. */
function total(items: Amount[], money: Money): number | null {
  let sum = 0;
  for (const { amount, asset } of items) {
    const value = money.unit === "usd" ? toUsd(amount, asset, money.price) : toSats(amount, asset, money.price);
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

function totalText(value: number | null, money: Money, signed = false): string {
  if (value === null) return "–";
  const sign = signed ? (value >= 0 ? "+" : "−") : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  return money.unit === "usd" ? `${sign}$${compactFixed(abs)}` : `${sign}${btcText(abs)}`;
}

function altText(value: number | null, money: Money): string {
  if (value === null || !money.price) return "";
  if (money.unit === "usd") return btcText((value / money.price.usd) * 1e8);
  return `$${Math.round((value / 1e8) * money.price.usd).toLocaleString("en-US")}`;
}

/**
 * What the wallet's current balance of each coin cost, by average cost over
 * its trades. Only known when the trade history is complete and covers the
 * balance; tokens that arrived by transfer have no known cost.
 */
function costBasis(profile: WalletProfile): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (profile.trades.length >= TRADES_LIMIT) return out;
  const book = new Map<string, { tokens: bigint; cost: bigint }>();
  for (const trade of [...profile.trades].reverse()) {
    const entry = book.get(trade.mint) ?? { tokens: 0n, cost: 0n };
    const tokens = BigInt(trade.tokenAmount);
    if (trade.side === "buy") {
      entry.tokens += tokens;
      // A trade's quote amount is what moved into the curve or pool; the fee was paid on top.
      entry.cost += BigInt(trade.quoteAmount) + BigInt(trade.feeQuote);
    } else if (entry.tokens > 0n) {
      const sold = tokens > entry.tokens ? entry.tokens : tokens;
      entry.cost -= (entry.cost * sold) / entry.tokens;
      entry.tokens -= sold;
    }
    book.set(trade.mint, entry);
  }
  for (const holding of profile.holdings) {
    const entry = book.get(holding.coin.mint);
    const amount = BigInt(holding.amount);
    if (!entry || entry.tokens === 0n || entry.tokens < amount) continue;
    out.set(holding.coin.mint, (entry.cost * amount) / entry.tokens);
  }
  return out;
}

/** Creator earnings per day over the last two weeks, from the curve trades on the wallet's coins. */
function useDailyEarnings(created: CoinView[], money: Money, quoteOf: (mint: string) => QuoteAsset | undefined, now: number) {
  const coins = created.slice(0, 10);
  const key = coins.map((coin) => `${coin.mint}:${coin.tradeCount}`).join(",");
  const trades = useLoaded(
    key ? `earn:${key}` : null,
    async () => {
      const since = Math.floor(Date.now() / 1000) - 14 * DAY;
      const all: { coin: CoinView; trade: TradeRecord }[] = [];
      let partial = false;
      for (const coin of coins) {
        let before: string | undefined;
        for (let page = 0; page < 5; page++) {
          const batch = await api.trades(coin.mint, { limit: 200, ...(before ? { before } : {}) });
          for (const trade of batch) if (trade.timestamp >= since) all.push({ coin, trade });
          const last = batch[batch.length - 1];
          if (batch.length < 200 || !last || last.timestamp < since) break;
          before = last.id;
          if (page === 4) partial = true;
        }
      }
      return { all, partial: partial || created.length > coins.length };
    },
    60_000,
  );
  return useMemo(() => {
    if (!trades.data) return null;
    const today = Math.floor(now / DAY);
    const days = Array.from({ length: 14 }, () => 0);
    let unconvertible = false;
    for (const { coin, trade } of trades.data.all) {
      if (trade.venue !== "curve") continue;
      const quote = quoteOf(coin.quoteMint);
      if (!quote) continue;
      const feeBps = coin.platformFeeBps + coin.creatorFeeBps;
      if (feeBps === 0) continue;
      const creator = (BigInt(trade.feeQuote) * BigInt(coin.creatorFeeBps)) / BigInt(feeBps);
      const value = total([{ amount: creator, asset: quote }], money);
      if (value === null) {
        unconvertible = true;
        continue;
      }
      const index = 13 - (today - Math.floor(trade.timestamp / DAY));
      if (index >= 0 && index < 14) days[index]! += value;
    }
    return { days, partial: trades.data.partial, unconvertible };
  }, [trades.data, money, quoteOf, now]);
}

export function Profile({ address }: { address: string }) {
  const { wallet, client, send, quoteOf, money } = useApp();
  const now = useNow();
  const valid = isAddress(address);
  const profile = useLoaded(valid ? address : null, () => api.wallet(address), 20_000);
  const [tab, setTab] = useState<"holdings" | "created" | "activity">("holdings");
  const [claim, setClaim] = useState<"idle" | "sign" | "pending" | "done">("idle");
  const [claimed, setClaimed] = useState<number | null>(null);
  const [copied, copy] = useCopy();
  const mine = wallet?.address === address;
  const created = profile.data?.created ?? [];
  const daily = useDailyEarnings(created, money, quoteOf, now);

  if (!valid) return <div className="p-8"><Notice tone="error">That is not a valid wallet address.</Notice></div>;
  if (profile.error && !profile.data) return <div className="p-8"><Notice tone="error">Could not load this wallet: {profile.error}</Notice></div>;
  if (!profile.data) {
    return (
      <div className="flex flex-col gap-5 px-8 pt-7">
        <Skeleton className="h-[68px] w-80" />
        <Skeleton className="h-[480px]" />
      </div>
    );
  }

  const data = profile.data;
  const costs = costBasis(data);
  const graduatedCount = created.filter((coin) => coin.status === "graduated").length;

  const holdingItems: Amount[] = [];
  const costItems: Amount[] = [];
  const valueWithCost: Amount[] = [];
  for (const { coin, valueQuote } of data.holdings) {
    const quote = quoteOf(coin.quoteMint);
    if (!quote) continue;
    holdingItems.push({ amount: BigInt(valueQuote), asset: quote });
    const cost = costs.get(coin.mint);
    if (cost !== undefined) {
      costItems.push({ amount: cost, asset: quote });
      valueWithCost.push({ amount: BigInt(valueQuote), asset: quote });
    }
  }
  const holdingsValue = total(holdingItems, money);
  const costTotal = costItems.length ? total(costItems, money) : null;
  const valueCovered = costItems.length ? total(valueWithCost, money) : null;
  const profit = costTotal !== null && valueCovered !== null ? valueCovered - costTotal : null;

  const cashItems = data.quoteBalances.flatMap((b) => {
    const quote = quoteOf(b.mint);
    return quote && BigInt(b.amount) > 0n ? [{ amount: BigInt(b.amount), asset: quote }] : [];
  });
  const cash = total(cashItems, money);
  const onlyAsset = cashItems.length > 0 && cashItems.every((item) => item.asset.mint === cashItems[0]!.asset.mint) ? cashItems[0]!.asset : null;

  const claimable = created.flatMap((coin) => {
    const quote = quoteOf(coin.quoteMint);
    const amount = BigInt(coin.unclaimedCreatorFees);
    return quote && amount > 0n ? [{ coin, amount, asset: quote }] : [];
  });
  const claimableValue = total(claimable, money);
  const earnedAll = total(created.flatMap((coin) => (quoteOf(coin.quoteMint) ? [{ amount: BigInt(coin.creatorFees), asset: quoteOf(coin.quoteMint)! }] : [])), money);
  const claimedAll =
    earnedAll !== null && claimableValue !== null ? Math.max(0, earnedAll - claimableValue) : null;

  const runClaim = async () => {
    if (!client || !wallet || claimable.length === 0) return;
    setClaim("pending");
    const value = claimableValue;
    let ok = 0;
    for (const { coin } of claimable) {
      const processed = await send(client.planClaimCreatorFees(wallet.address, coin), {
        doing: `Claiming your ${coin.symbol} earnings.`,
        done: `Your ${coin.symbol} earnings are in your wallet.`,
      });
      if (!processed) break;
      ok++;
    }
    profile.reload();
    if (ok === claimable.length) {
      setClaimed(value);
      setClaim("done");
    } else {
      setClaim("idle");
    }
  };

  type Activity = { key: string; when: number; coin: Pick<CoinView, "image" | "symbol" | "name">; mint: string; title: string; detail: string; value: string; color: string };
  const activity: Activity[] = [];
  for (const trade of data.trades) {
    const quote = quoteOf(trade.quoteMint);
    const coin = data.holdings.find((h) => h.coin.mint === trade.mint)?.coin ?? created.find((c) => c.mint === trade.mint);
    const buy = trade.side === "buy";
    const symbol = trade.symbol || "a coin";
    const paid = BigInt(trade.quoteAmount) + (buy ? BigInt(trade.feeQuote) : -BigInt(trade.feeQuote));
    activity.push({
      key: `t${trade.id}`,
      when: trade.timestamp,
      coin: coin ?? { image: "", symbol: trade.symbol, name: trade.symbol },
      mint: trade.mint,
      title: `${buy ? "Bought" : "Sold"} ${formatTokens(trade.tokenAmount, coin?.tokenDecimals ?? 6)} ${symbol}`,
      detail: trade.venue === "pool" ? "Swap on the pool · final on Arch" : "Final on Arch",
      value: quote ? `${buy ? "−" : "+"}${money.size(paid, quote)}` : "",
      color: buy ? "#D5D7CB" : UP_COLOR,
    });
  }
  for (const coin of created) {
    activity.push({ key: `l${coin.mint}`, when: coin.createdAt, coin, mint: coin.mint, title: `Launched ${coin.symbol}`, detail: "Mint and freeze authority: none", value: "", color: "#D5D7CB" });
    if (coin.graduatedAt) {
      activity.push({
        key: `g${coin.mint}`,
        when: coin.graduatedAt,
        coin,
        mint: coin.mint,
        title: `${coin.symbol} graduated`,
        detail: "Moved to its Arch Swap pool",
        value: "Pool locked",
        color: "#FFB257",
      });
    }
  }
  activity.sort((a, b) => b.when - a.when);

  const tabBtn = (key: typeof tab, label: string, n: string) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`flex items-center gap-[7px] border-b-2 text-[13px] font-medium ${tab === key ? "border-orange text-text" : "border-transparent text-dim hover:text-text"}`}
    >
      {label} <span className="tabular text-faint">{n}</span>
    </button>
  );

  const card = "flex flex-col gap-1 rounded-[12px] border border-line bg-panel px-4 py-3.5";
  const H_COLS = "grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_minmax(0,1.3fr)_72px]";
  const C_COLS = "grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_repeat(3,minmax(0,1fr))_minmax(0,0.9fr)]";
  const head = "gap-3 px-4 pt-3 pb-1.5 text-[10.5px] font-medium tracking-[0.08em] whitespace-nowrap text-faint uppercase";
  const maxDay = daily ? Math.max(...daily.days, 0) : 0;
  const dayLabel = (offset: number) => new Date((Math.floor(now / DAY) - offset) * DAY * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div className="flex flex-1 flex-col gap-[22px] px-8 pt-7 pb-9 max-lg:px-4" data-screen-label="Profile and creator earnings">
      <div className="flex flex-wrap items-center gap-[18px]">
        <span className="h-[68px] w-[68px] rounded-full" style={{ background: mine ? "linear-gradient(135deg,#FFB257,#7A4A0E)" : ident(address) }} />
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 flex items-baseline gap-2.5 text-[30px] leading-[1.1] font-medium tracking-[-0.03em]">
            {shortAddress(address)}
            {mine && <span className="rounded-[6px] bg-[rgba(247,147,26,0.12)] px-2 py-0.5 text-[12px] font-medium tracking-normal text-amber">You</span>}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] whitespace-nowrap text-dim">
            <button
              title="Copy address"
              onClick={() => copy("addr", address)}
              className="tabular -my-0.5 flex items-center gap-[5px] rounded-[6px] bg-[rgba(245,241,232,0.06)] px-1.5 py-0.5 text-soft hover:bg-[rgba(245,241,232,0.1)]"
            >
              {copied === "addr" ? "Address copied" : shortAddress(address, 6)}
              <Icon name="copy" size={12} />
            </button>
            {mine && wallet?.taproot && (
              <>
                <span className="text-ghost">·</span>
                <span className="tabular" title={wallet.taproot}>
                  {shortAddress(wallet.taproot, 6)}
                </span>
              </>
            )}
            <span className="text-ghost">·</span>
            <span>
              {created.length} {created.length === 1 ? "coin" : "coins"} launched, {graduatedCount} graduated
            </span>
          </div>
        </div>
        <button onClick={() => copy("share", window.location.href)} className="btn-outline ml-auto h-[34px] rounded-[8px] px-[13px] text-[13px]">
          <Icon name={copied === "share" ? "check" : "share"} size={14} />
          {copied === "share" ? "Link copied" : "Share profile"}
        </button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 max-xl:grid-cols-1">
        <main className="flex min-w-0 flex-col gap-3.5">
          <div className="tabular grid grid-cols-3 gap-2.5 max-md:grid-cols-1">
            <div className={card}>
              <span className="text-[12px] text-faint">Holdings value</span>
              <span className="text-[22px] font-medium tracking-[-0.02em]">{totalText(holdingsValue, money)}</span>
              <span className="text-[12px] text-dim">{altText(holdingsValue, money) || `${data.holdings.length} coins at the current price`}</span>
            </div>
            <div className={card}>
              <span className="text-[12px] text-faint">Unrealised profit</span>
              <span className="text-[22px] font-medium tracking-[-0.02em]" style={{ color: profit === null ? undefined : profit >= 0 ? UP_COLOR : DOWN_COLOR }}>
                {totalText(profit, money, true)}
              </span>
              <span className="text-[12px] text-dim">
                {profit !== null && costTotal
                  ? `${pct((profit / costTotal) * 100, 0)} on ${totalText(costTotal, money)} spent`
                  : data.trades.length >= TRADES_LIMIT
                    ? "Needs the full trade history"
                    : "No purchases to compare yet"}
              </span>
            </div>
            <div className={card}>
              <span className="text-[12px] text-faint">{onlyAsset ? `${onlyAsset.symbol} in wallet` : "In wallet"}</span>
              <span className="text-[22px] font-medium tracking-[-0.02em]">
                {cashItems.length === 0 ? totalText(0, money) : cash !== null ? totalText(cash, money) : cashItems.map((item) => money.big(item.amount, item.asset)).join(" · ")}
              </span>
              <span className="text-[12px] text-dim">
                {cashItems.length === 0 ? "No quote assets" : cashItems.length > 1 ? cashItems.map((item) => item.asset.symbol).join(" + ") : altText(cash, money)}
              </span>
            </div>
          </div>

          <section className="flex flex-col overflow-hidden rounded-[12px] border border-line bg-panel">
            <div className="flex h-[46px] items-stretch gap-[22px] border-b border-[rgba(245,241,232,0.07)] px-4">
              {tabBtn("holdings", "Holdings", String(data.holdings.length))}
              {tabBtn("created", mine ? "Coins you launched" : "Coins launched", String(created.length))}
              {tabBtn("activity", "Activity", "")}
            </div>

            {tab === "holdings" && (
              <div className="overflow-x-auto">
                <div className="min-w-[760px]">
                  <div className={`grid ${H_COLS} ${head}`}>
                    <span>Coin</span>
                    <span className="text-right">Balance</span>
                    <span className="text-right">Value</span>
                    <span className="text-right">Cost</span>
                    <span className="text-right">Profit</span>
                    <span className="pl-3">Curve</span>
                    <span />
                  </div>
                  {data.holdings.length === 0 && (
                    <p className="px-4 py-8 text-[12.5px] text-faint">
                      {mine ? "You hold no SARCH coins yet. " : "This wallet holds no SARCH coins. "}
                      <Link href="/discover" className="text-amber">
                        Discover coins
                      </Link>
                    </p>
                  )}
                  {data.holdings.map(({ coin, amount, valueQuote }) => {
                    const quote = quoteOf(coin.quoteMint);
                    const cost = costs.get(coin.mint);
                    const diff = cost !== undefined ? BigInt(valueQuote) - cost : null;
                    const progress = coin.status === "graduated" ? 100 : coin.progressBps / 100;
                    return (
                      <div key={coin.mint} className={`tabular grid ${H_COLS} h-14 items-center gap-3 border-t border-[rgba(245,241,232,0.05)] px-4 text-[13px] whitespace-nowrap`}>
                        <Link href={`/coin/${coin.mint}`} className="flex min-w-0 items-center gap-2.5">
                          <CoinImage coin={coin} size={32} radius={9} />
                          <span className="flex min-w-0 flex-col gap-px">
                            <span className="font-medium">{coin.symbol}</span>
                            <span className="truncate text-[11.5px] text-faint">{coin.name}</span>
                          </span>
                        </Link>
                        <span className="text-right text-soft">{formatTokens(amount, coin.tokenDecimals)}</span>
                        <span className="text-right font-medium">{quote ? money.big(valueQuote, quote) : "…"}</span>
                        <span className="text-right text-dim" title="What you paid, fees included">
                          {quote && cost !== undefined ? money.big(cost, quote) : "–"}
                        </span>
                        <span className="text-right" style={{ color: diff === null ? "#8E9B93" : diff >= 0n ? UP_COLOR : DOWN_COLOR }}>
                          {quote && diff !== null && cost
                            ? `${diff >= 0n ? "+" : "−"}${money.big(diff >= 0n ? diff : -diff, quote)} · ${pct((Number(diff) / Number(cost)) * 100, 0)}`
                            : "–"}
                        </span>
                        <span className="flex items-center gap-2 pl-3">
                          <Bar percent={progress} className="flex-1" />
                          <span className="text-[11.5px] text-dim">{coin.status === "graduated" ? "In pool" : `${progress.toFixed(0)}%`}</span>
                        </span>
                        <Link href={`/coin/${coin.mint}`} className="btn-outline h-7 rounded-[7px] text-[12px]">
                          Trade
                        </Link>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === "created" && (
              <div className="overflow-x-auto">
                <div className="min-w-[760px]">
                  <div className={`grid ${C_COLS} ${head}`}>
                    <span>Coin</span>
                    <span>Status</span>
                    <span className="text-right">Volume</span>
                    <span className="text-right">Earned</span>
                    <span className="text-right">Claimable</span>
                    <span className="text-right">Launched</span>
                  </div>
                  {created.length === 0 && (
                    <p className="px-4 py-8 text-[12.5px] text-faint">
                      {mine ? "You have not launched a coin yet. " : "This wallet has not launched a coin. "}
                      {mine && (
                        <Link href="/create" className="text-amber">
                          Launch one
                        </Link>
                      )}
                    </p>
                  )}
                  {created.map((coin) => {
                    const quote = quoteOf(coin.quoteMint);
                    const grad = coin.status === "graduated";
                    const unclaimed = BigInt(coin.unclaimedCreatorFees);
                    return (
                      <Link
                        key={coin.mint}
                        href={`/coin/${coin.mint}`}
                        className={`tabular grid ${C_COLS} h-[60px] items-center gap-3 border-t border-[rgba(245,241,232,0.05)] px-4 text-[13px] whitespace-nowrap hover:bg-[rgba(245,241,232,0.03)]`}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <CoinImage coin={coin} size={32} radius={9} />
                          <span className="flex min-w-0 flex-col gap-px">
                            <span className="font-medium">{coin.symbol}</span>
                            <span className="truncate text-[11.5px] text-faint">{coin.name}</span>
                          </span>
                        </span>
                        <span className="flex min-w-0 flex-col gap-[5px]">
                          <span className="text-[12.5px]" style={{ color: grad ? "#FFB257" : "#D5D7CB" }}>
                            {grad ? "Graduated · in Arch Swap pool" : `On the curve · ${(coin.progressBps / 100).toFixed(1)}%`}
                          </span>
                          <Bar percent={grad ? 100 : coin.progressBps / 100} />
                        </span>
                        <span className="text-right text-soft">{quote ? money.big(coin.volumeQuote, quote) : "…"}</span>
                        <span className="text-right font-medium text-amber-pale">{quote ? money.big(coin.creatorFees, quote) : "…"}</span>
                        <span className="text-right">{quote && unclaimed > 0n ? money.big(unclaimed, quote) : "—"}</span>
                        <span className="text-right text-dim">
                          {new Date(coin.createdAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      </Link>
                    );
                  })}
                  {created.length > 0 && (
                    <div className="border-t border-[rgba(245,241,232,0.05)] px-4 pt-3 pb-3.5 text-[12px] text-faint">
                      Earned includes fees from the curve and, after graduation, the creator's share of pool fees.
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "activity" && (
              <div className="flex flex-col">
                {activity.length === 0 && <p className="px-4 py-8 text-[12.5px] text-faint">Nothing yet.</p>}
                {activity.slice(0, 60).map((item) => (
                  <Link
                    key={item.key}
                    href={`/coin/${item.mint}`}
                    className="tabular grid h-14 grid-cols-[32px_minmax(0,1fr)_auto_auto] items-center gap-3 border-t border-[rgba(245,241,232,0.05)] px-4 text-[13px] whitespace-nowrap hover:bg-[rgba(245,241,232,0.03)]"
                  >
                    <CoinImage coin={item.coin} size={32} radius={9} />
                    <span className="flex min-w-0 flex-col gap-px">
                      <span className="truncate font-medium">{item.title}</span>
                      <span className="truncate text-[12px] text-faint">{item.detail}</span>
                    </span>
                    <span style={{ color: item.color }}>{item.value}</span>
                    <span className="w-[72px] text-right text-faint">{timeAgo(item.when, now)}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </main>

        <aside className="flex min-w-0 flex-col gap-3">
          <section className="tabular flex flex-col gap-4 rounded-[12px] border border-[rgba(247,147,26,0.3)] bg-panel p-[18px]">
            <div className="flex items-baseline justify-between gap-2.5">
              <h2 className="m-0 text-[15px] font-medium">Creator earnings</h2>
              <span className="text-[12px] text-faint">
                {created[0] ? `${(created[0].creatorFeeBps / 100).toFixed(2)}% of every curve trade` : "Earned on coins you launch"}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[12px] text-faint">Claimable now</span>
              <span className="flex items-baseline gap-2.5">
                <span className="text-[34px] leading-[1.05] font-medium tracking-[-0.03em]">{created.length ? totalText(claimableValue, money) : "–"}</span>
                <span className="text-[13px] text-dim">{created.length ? altText(claimableValue, money) : ""}</span>
              </span>
            </div>
            {mine && (claim === "idle" || claim === "done") && (
              <button onClick={() => claimable.length > 0 && setClaim("sign")} disabled={claimable.length === 0} className="btn-primary h-11 text-[14px]">
                {claimable.length === 0 ? "Nothing to claim yet" : `Claim ${totalText(claimableValue, money)}`}
              </button>
            )}
            {mine && (claim === "sign" || claim === "pending") && (
              <div className="flex flex-col gap-2.5 rounded-[10px] bg-deep p-3">
                <span className="text-[13px] font-medium">Confirm in your wallet</span>
                <span className="text-[12px] leading-[1.45] text-dim">
                  You receive {totalText(claimableValue, money)} from {claimable.length} {claimable.length === 1 ? "coin" : "coins"}
                  {claimable.length > 1 ? ", one signature per coin" : ""}. Only the network fee applies.
                </span>
                <div className="h-[3px] overflow-hidden rounded-[2px] bg-[rgba(245,241,232,0.08)]">
                  <div className="h-full bg-orange transition-[width] duration-[900ms] ease-linear" style={{ width: claim === "pending" ? "100%" : "0%" }} />
                </div>
                <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                  <button onClick={() => setClaim("idle")} disabled={claim === "pending"} className="btn-outline h-9 rounded-[8px] text-[13px]">
                    Cancel
                  </button>
                  <button onClick={() => void runClaim()} disabled={claim === "pending"} className="btn-primary h-9 rounded-[8px] text-[13px]">
                    {claim === "pending" ? "Approve in wallet…" : "Sign in wallet"}
                  </button>
                </div>
              </div>
            )}
            {mine && claim === "done" && (
              <div className="flex items-center gap-2.5 rounded-[10px] bg-[rgba(102,222,142,0.1)] px-3 py-[11px] text-[12.5px] text-[#C9F2D6]">
                <Icon name="check" size={15} color={UP_COLOR} />
                Claimed {totalText(claimed, money)}. It is in your wallet.
              </div>
            )}
            <span className="-mt-1.5 text-[12px] text-faint">Paid in each coin's quote asset. Claim whenever you like.</span>

            {created.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-[12px] text-dim">
                  <span>Earned per day</span>
                  <span>Last 14 days{daily?.partial ? ", partial" : ""}</span>
                </div>
                <div className="flex h-[84px] items-end gap-1">
                  {(daily?.days ?? Array.from({ length: 14 }, () => 0)).map((value, i) => (
                    <span
                      key={i}
                      title={`${dayLabel(13 - i)}: ${totalText(value, money)}`}
                      className="flex-1 rounded-[3px_3px_1px_1px]"
                      style={{ height: `${maxDay > 0 ? Math.max(4, (value / maxDay) * 84) : 4}px`, background: i === 13 ? "#F7931A" : "rgba(247,147,26,0.45)" }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-[11px] text-faint">
                  <span>{dayLabel(13)}</span>
                  <span>Today</span>
                </div>
              </div>
            )}

            {created.length > 0 && (
              <div className="rule-top flex flex-col gap-[9px] pt-3.5 text-[12.5px]">
                {created.slice(0, 8).map((coin) => {
                  const quote = quoteOf(coin.quoteMint);
                  const left = BigInt(coin.unclaimedCreatorFees);
                  return (
                    <div key={coin.mint} className="flex items-center gap-2">
                      <CoinImage coin={coin} size={18} radius={5} />
                      <span className="font-medium">{coin.symbol}</span>
                      <span className="ml-auto" style={{ color: left > 0n ? "#F5F1E8" : "#8E9B93" }}>
                        {left > 0n && quote ? `${money.size(left, quote)} to claim` : "All claimed"}
                      </span>
                    </div>
                  );
                })}
                <div className="flex justify-between pt-1 text-faint">
                  <span>Earned all time {totalText(earnedAll, money)}</span>
                  <span>Claimed {totalText(claimedAll, money)}</span>
                </div>
              </div>
            )}
            {created.length === 0 && (
              <p className="m-0 text-[12.5px] text-faint">
                {mine ? (
                  <>
                    Launch a coin and every trade on its curve pays you.{" "}
                    <Link href="/create" className="text-amber">
                      Launch a coin
                    </Link>
                  </>
                ) : (
                  "This wallet has not launched a coin."
                )}
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
