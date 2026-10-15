"use client";

/**
 * One coin, as a trading terminal: other coins down the left, the coin's
 * chart and activity in the middle, and the trade box, its numbers and its
 * safety facts on the right.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Position } from "@archpad/sdk";
import { type Candle, type CoinDetail, type CoinSort, type CoinView, type Holders, type QuoteAsset, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { bpsPct, curveShareBps, quoteToGraduate, sinceLaunch, top10Bps } from "@/lib/coin.ts";
import { DOWN_COLOR, UP_COLOR } from "@/lib/design-system.ts";
import { formatBps, formatDuration, formatTokens, int, pct, shortAddress, timeAgo } from "@/lib/format.ts";
import { useLoaded, useNow, useStream } from "@/lib/hooks.ts";
import { assetKind } from "@/lib/money.ts";
import type { Market } from "@/lib/quote.ts";
import { CoinActivity, type LiveTrade } from "./CoinActivity.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { PriceChart } from "./PriceChart.tsx";
import { TradeBox, type TradeRequest } from "./TradeBox.tsx";
import { TradeDialog } from "./TradeDialog.tsx";
import { Bar, CoinImage, Modal, Notice, Skeleton, useCopy } from "./ui.tsx";

const RAIL_TABS: { sort: CoinSort; label: string }[] = [
  { sort: "trending", label: "Trending" },
  { sort: "new", label: "New" },
  { sort: "graduating", label: "Graduating" },
];

const LINKS: { key: "x" | "telegram" | "website"; icon: IconName; title: string }[] = [
  { key: "x", icon: "x", title: "X" },
  { key: "telegram", icon: "telegram", title: "Telegram" },
  { key: "website", icon: "globe", title: "Website" },
];

function Rail({ current }: { current: CoinView }) {
  const { quoteOf, money, network } = useApp();
  const [sort, setSort] = useState<CoinSort>("trending");
  const list = useLoaded(`rail:${sort}`, () => api.coins({ sort, limit: 20 }), 20_000);
  const coins = (list.data ?? []).map((coin) => (coin.mint === current.mint ? current : coin));
  return (
    <aside className="flex flex-col overflow-hidden rounded-[12px] border border-line bg-panel pb-2">
      <div className="flex gap-0.5 p-2">
        {RAIL_TABS.map((tab) => (
          <button
            key={tab.sort}
            onClick={() => setSort(tab.sort)}
            className={`h-[30px] flex-1 rounded-[8px] text-[12.5px] font-medium ${sort === tab.sort ? "seg-on" : "seg-off"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="kicker flex justify-between px-4 pt-1 pb-1.5 whitespace-nowrap">
        <span>Coin · curve</span>
        <span>Mkt cap</span>
      </div>
      {list.loading && !list.data && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mx-1.5 my-1 h-[50px]" />)}
      {list.data && coins.length === 0 && <p className="px-4 py-4 text-[12px] text-faint">No coins to show.</p>}
      {coins.map((coin) => {
        const quote = quoteOf(coin.quoteMint);
        const me = coin.mint === current.mint;
        const progress = Math.min(100, coin.progressBps / 100);
        const change = sinceLaunch(coin, network);
        return (
          <Link
            key={coin.mint}
            href={`/coin/${coin.mint}`}
            className="mx-1.5 grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] hover:bg-[rgba(245,241,232,0.05)]"
            style={me ? { background: "rgba(245,241,232,0.08)" } : undefined}
          >
            <CoinImage coin={coin} size={36} radius={10} />
            <span className="flex min-w-0 flex-col gap-1.5">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-[13px] font-medium">{coin.symbol}</span>
                <span className="truncate text-[11.5px] text-faint">{coin.name}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Bar percent={progress} height={3} className="flex-1" />
                <span className="tabular text-[10.5px] text-faint">{coin.status === "graduated" ? "Pool" : `${progress.toFixed(0)}%`}</span>
              </span>
            </span>
            <span className="tabular flex flex-col items-end gap-[3px]">
              <span className="text-[12.5px] font-medium">{quote ? money.big(coin.marketCapQuote, quote) : "…"}</span>
              {change !== null && (
                <span className="text-[11.5px]" style={{ color: change >= 0 ? UP_COLOR : DOWN_COLOR }}>
                  {pct(change)}
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </aside>
  );
}

/** Price a given number of seconds ago, from one-minute candles. */
function priceAgo(candles: Candle[], seconds: number, now: number): number | null {
  if (candles.length === 0) return null;
  const at = now - seconds;
  let price: number | null = null;
  for (const candle of candles) {
    if (candle.time + 60 <= at) price = candle.close;
    else break;
  }
  return price ?? candles[0]!.open;
}

function GraduationModal({ coin, quote, holders, onClose }: { coin: CoinView; quote: QuoteAsset; holders: number | null; onClose: () => void }) {
  const { money } = useApp();
  const [step, setStep] = useState(0);
  const [copied, copy] = useCopy();
  useEffect(() => {
    const timers = [1, 2, 3].map((k, i) => window.setTimeout(() => setStep(k), 500 + i * 420));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);
  const poolTokens = BigInt(coin.totalSupply) - BigInt(coin.curveSupply);
  const moved = `${money.fixed(coin.graduationQuote, quote)} + ${formatTokens(poolTokens, coin.tokenDecimals)} ${coin.symbol}`;
  const steps = [
    ["Curve filled", `${money.fixed(coin.graduationQuote, quote)} raised${holders !== null ? ` from ${int(holders)} holders` : ""}`],
    ["Pool created on Arch Swap", `${moved} moved into the new pool`],
    ["Starting liquidity locked", "Nobody can withdraw it, including the creator"],
  ];
  const gradMc = (BigInt(coin.graduationQuote) * BigInt(coin.totalSupply)) / (poolTokens > 0n ? poolTokens : 1n);
  return (
    <Modal label="Graduation" onClose={onClose} width={540} top={120} dim={0.74}>
      <div className="flex flex-col items-start gap-[18px] rounded-[16px] border border-[rgba(247,147,26,0.35)] bg-panel p-7 shadow-[0_30px_90px_rgba(0,0,0,0.6)]">
        <CoinImage coin={coin} size={84} radius={22} style={{ boxShadow: "0 0 0 6px rgba(247,147,26,0.18),0 0 64px rgba(247,147,26,0.4)" }} />
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium tracking-[0.12em] text-orange uppercase">Graduation</span>
          <h2 className="m-0 text-[30px] leading-[1.1] font-medium tracking-[-0.03em]">
            {coin.symbol} {step >= 3 ? "graduated" : "is graduating"}
          </h2>
          <p className="pretty m-0 text-[13.5px] leading-[1.5] text-mute">
            Your buy filled the curve. These three steps ran in that same transaction, with no fee. If any of them had failed, all of it would have reverted.
          </p>
        </div>
        <div className="flex flex-col gap-0.5 self-stretch">
          {steps.map(([title, detail], i) => {
            const on = step >= i + 1;
            return (
              <div
                key={title}
                className="grid grid-cols-[28px_minmax(0,1fr)] items-start gap-3 py-2.5 transition-[opacity,transform] duration-[350ms] ease-out"
                style={{ opacity: on ? 1 : 0.28, transform: on ? "none" : "translateY(4px)" }}
              >
                <span
                  className="grid h-7 w-7 place-items-center rounded-full border-[1.5px] text-ground"
                  style={{ background: on ? "#F7931A" : "transparent", borderColor: on ? "#F7931A" : "rgba(245,241,232,0.25)" }}
                >
                  <Icon name="check" size={14} />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium">{title}</span>
                  <span className="tabular text-[12.5px] text-dim">{detail}</span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-4 self-stretch transition-opacity duration-400" style={{ opacity: step >= 3 ? 1 : 0 }}>
          <div className="tabular grid grid-cols-2 gap-2.5">
            <div className="flex flex-col gap-[3px] rounded-[10px] bg-deep p-3">
              <span className="text-[11.5px] text-faint">Market cap at graduation</span>
              <span className="text-[17px] font-medium">{money.big(gradMc, quote)}</span>
            </div>
            <div className="flex flex-col gap-[3px] rounded-[10px] bg-deep p-3">
              <span className="text-[11.5px] text-faint">Holders</span>
              <span className="text-[17px] font-medium">{holders !== null ? int(holders) : "…"}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn-outline h-[42px] px-4 text-[13.5px]" onClick={onClose}>
              Close
            </button>
            <button className="btn-outline h-[42px] px-4 text-[13.5px]" onClick={() => copy("share", window.location.href)}>
              {copied ? "Link copied" : "Share"}
            </button>
            <button className="btn-primary h-[42px] flex-1 text-[13.5px]" onClick={onClose}>
              Trade on the pool
              <Icon name="arrowUpRight" size={14} />
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SafetyFacts({ coin, holdersData, creatorBuyBps }: { coin: CoinView; holdersData: Holders | null; creatorBuyBps: number | null }) {
  const [copied, copy] = useCopy();
  const graduated = coin.status === "graduated";
  const capBps = curveShareBps(coin.earlyWalletCap, coin);
  const windowSecs = Math.max(0, coin.earlyWindowEnd - coin.createdAt);
  const rows: [string, string, boolean][] = [
    ["Mint authority", "None", false],
    ["Freeze authority", "None", false],
    ["Pool liquidity", graduated ? "Locked in Arch Swap pool" : "Locked at graduation", false],
    ["Creator's launch buy", creatorBuyBps !== null ? `${bpsPct(creatorBuyBps)}, full fee paid` : "Full fee paid", false],
    [`First ${formatDuration(windowSecs)}`, `Max ${bpsPct(capBps, capBps % 100 === 0 ? 0 : 1)} per wallet`, false],
    ["Top 10 holders", holdersData ? `${bpsPct(top10Bps(holdersData))} of supply` : "…", true],
  ];
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-3.5 text-[12.5px] whitespace-nowrap">
      <div className="flex items-center gap-2">
        <Icon name="shield" size={16} color={UP_COLOR} />
        <span className="text-[13px] font-medium">Safety facts</span>
        <span className="ml-auto text-[11px] text-faint">Enforced by the launch program</span>
      </div>
      <div className="flex flex-col gap-[9px]">
        {rows.map(([key, value, info]) => (
          <div key={key} className="flex items-center gap-2">
            <Icon name={info ? "info" : "check"} size={13} color={info ? "#A3ACA3" : UP_COLOR} />
            <span className="text-dim">{key}</span>
            <span className="ml-auto">{value}</span>
          </div>
        ))}
      </div>
      <button
        onClick={() => copy("mint", coin.mint)}
        className="flex h-[30px] items-center justify-center gap-1.5 rounded-[8px] border border-[rgba(245,241,232,0.14)] text-[12px] text-soft hover:bg-[rgba(245,241,232,0.06)] hover:text-text"
        title={coin.mint}
      >
        <Icon name="copy" size={13} />
        {copied ? "Mint address copied" : "Copy mint address"}
      </button>
    </section>
  );
}

export function CoinPage({ mint }: { mint: string }) {
  const { client, wallet, quoteOf, activity, network, money } = useApp();
  const now = useNow();
  const detail = useLoaded(mint, () => api.coin(mint), 30_000);
  const holders = useLoaded(`holders:${mint}`, () => api.holders(mint), 20_000);
  const [coin, setCoin] = useState<CoinDetail | null>(null);
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [market, setMarket] = useState<Market | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [version, setVersion] = useState(0);
  const [trade, setTrade] = useState<TradeRequest | null>(null);
  const [graduating, setGraduating] = useState(false);
  const [copied, copy] = useCopy();

  useEffect(() => setCoin(detail.data), [detail.data]);
  useEffect(() => {
    setTrades([]);
    api.trades(mint, { limit: 200 }).then(setTrades).catch(() => undefined);
  }, [mint]);

  const minute = useLoaded(`m:${mint}`, () => api.candles(mint, 60), 60_000);
  const reloadMinute = minute.reload;
  useEffect(() => {
    if (version > 0) reloadMinute();
  }, [version, reloadMinute]);

  // The trade box prices against the chain's own accounts, not the indexer's copy.
  const readChain = useCallback(async () => {
    if (!client) return;
    try {
      const state = await client.getCoin(mint);
      if (state) setMarket({ curve: state.curve, pool: state.pool });
      setPosition(wallet ? await client.getPosition(mint, wallet.address) : null);
    } catch {
      // Keep the last state; the next read will try again.
    }
  }, [client, mint, wallet]);

  useEffect(() => {
    void readChain();
    const timer = window.setInterval(() => void readChain(), 5_000);
    return () => window.clearInterval(timer);
  }, [readChain, activity]);

  const reloadHolders = holders.reload;
  useStream(mint, (message) => {
    if (message.coin) setCoin((current) => (current ? { ...current, ...message.coin! } : current));
    if (message.type === "trade") {
      const id = message.trade.id;
      setTrades((list) => [{ ...message.trade, fresh: true }, ...list.filter((t) => t.id !== id)].slice(0, 200));
      window.setTimeout(() => setTrades((list) => list.map((t) => (t.id === id ? { ...t, fresh: false } : t))), 200);
      setVersion((value) => value + 1);
      reloadHolders();
    }
    void readChain();
  });

  const stats = useMemo(() => {
    const buys = trades.filter((t) => t.side === "buy").length;
    return { buys, sells: trades.length - buys };
  }, [trades]);

  if (detail.error && !coin) {
    return (
      <div className="p-4">
        <Notice tone="error">
          {/no coin/.test(detail.error) ? "No coin with that address has been launched on SARCH." : `Could not load this coin: ${detail.error}`}{" "}
          <Link href="/discover" className="text-amber">
            Back to Discover
          </Link>
        </Notice>
      </div>
    );
  }
  if (!coin) {
    return (
      <div className="grid grid-cols-[272px_minmax(0,1fr)_340px] items-start gap-2.5 p-2.5 max-xl:grid-cols-[minmax(0,1fr)_340px] max-lg:grid-cols-1">
        <Skeleton className="h-[600px] max-xl:hidden" />
        <Skeleton className="h-[600px]" />
        <Skeleton className="h-[600px]" />
      </div>
    );
  }

  const quote = quoteOf(coin.quoteMint);
  const graduated = coin.status === "graduated";
  const progress = Math.min(100, coin.progressBps / 100);
  const change = sinceLaunch(coin, network);
  const nowPrice = coin.price;
  const candles = minute.data ?? [];
  const p5 = priceAgo(candles, 300, now);
  const p60 = priceAgo(candles, 3_600, now);
  const c5 = p5 && nowPrice ? (nowPrice / p5 - 1) * 100 : null;
  const c60 = p60 && nowPrice ? (nowPrice / p60 - 1) * 100 : null;
  const complete = trades.length >= coin.tradeCount;
  const first = complete ? trades[trades.length - 1] : undefined;
  const creatorBuyBps = first && first.trader === coin.creator && first.side === "buy" ? curveShareBps(first.tokenAmount, coin) : null;
  const holdersCount = holders.data ? holders.data.count : null;
  const quoteTag = quote ? (assetKind(quote) === "btc" ? "₿ pair" : `${quote.symbol} pair`) : "";
  const poolTokens = BigInt(coin.totalSupply) - BigInt(coin.curveSupply);
  const gradMc = poolTokens > 0n ? (BigInt(coin.graduationQuote) * BigInt(coin.totalSupply)) / poolTokens : 0n;
  const windowLeft = coin.status === "trading" ? coin.earlyWindowEnd - now : 0;

  const changeCell = (label: string, value: number | null, extra = "") => (
    <div className={`flex flex-col items-center gap-0.5 px-1 py-2 ${extra}`}>
      <span className="text-[10.5px] tracking-[0.06em] text-faint">{label}</span>
      <span className="text-[13px] font-medium" style={{ color: value === null ? "#8E9B93" : value >= 0 ? UP_COLOR : DOWN_COLOR }}>
        {value === null ? "–" : pct(value)}
      </span>
    </div>
  );

  return (
    <div className="grid grid-cols-[272px_minmax(0,1fr)_340px] items-start gap-2.5 p-2.5 max-xl:grid-cols-[minmax(0,1fr)_340px] max-lg:grid-cols-1" data-screen-label="Coin page">
      <div className="max-xl:hidden">
        <Rail current={coin} />
      </div>

      <main className="flex min-w-0 flex-col gap-2.5">
        <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel px-4 pt-3.5 pb-3">
          <div className="flex min-w-0 items-center gap-3.5">
            <CoinImage coin={coin} size={52} radius={14} />
            <div className="flex min-w-0 flex-col gap-[5px]">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="m-0 truncate text-[20px] font-medium tracking-[-0.02em]">{coin.name || "Unnamed"}</h1>
                <span className="rounded-[6px] bg-[rgba(245,241,232,0.08)] px-[7px] py-0.5 text-[12px] font-medium text-soft">{coin.symbol}</span>
                {quoteTag && (
                  <span className="rounded-[6px] bg-[rgba(247,147,26,0.12)] px-[7px] py-0.5 text-[11.5px] font-medium whitespace-nowrap text-amber">{quoteTag}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[12px] whitespace-nowrap text-dim">
                <span>
                  by{" "}
                  <Link href={`/profile/${coin.creator}`} className="text-amber hover:text-amber-pale" title={coin.creator}>
                    {shortAddress(coin.creator)}
                  </Link>
                </span>
                <span className="text-ghost">·</span>
                <span>{now - coin.createdAt < 60 ? "Launched just now" : timeAgo(coin.createdAt, now)}</span>
                <span className="text-ghost">·</span>
                <button
                  title="Copy mint address"
                  onClick={() => copy("mint", coin.mint)}
                  className="tabular -my-0.5 flex items-center gap-[5px] rounded-[6px] px-1.5 py-0.5 text-[12px] text-mute hover:bg-[rgba(245,241,232,0.06)]"
                >
                  {copied === "mint" ? "Copied" : `Mint ${shortAddress(coin.mint)}`}
                  <Icon name="copy" size={12} />
                </button>
                {LINKS.some((link) => coin.links[link.key] && /^https:\/\//i.test(coin.links[link.key]!)) && (
                  <>
                    <span className="text-ghost">·</span>
                    <span className="flex gap-0.5">
                      {LINKS.map((link) => {
                        const href = coin.links[link.key];
                        // Links come from the creator. Only plain https ones are ever rendered.
                        return href && /^https:\/\//i.test(href) ? (
                          <a
                            key={link.key}
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener nofollow ugc"
                            title={link.title}
                            className="grid h-6 w-6 place-items-center rounded-[6px] text-dim hover:bg-[rgba(245,241,232,0.06)] hover:text-text"
                          >
                            <Icon name={link.icon} size={13} />
                          </a>
                        ) : null;
                      })}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="ml-auto flex gap-0.5">
              <button
                title={copied === "share" ? "Link copied" : "Copy a link to this coin"}
                onClick={() => copy("share", window.location.href)}
                className="grid h-8 w-8 place-items-center rounded-[8px] text-dim hover:bg-[rgba(245,241,232,0.06)] hover:text-text"
              >
                <Icon name={copied === "share" ? "check" : "share"} size={16} />
              </button>
            </div>
          </div>
          {coin.fullDescription && <p className="pretty m-0 line-clamp-3 text-[12.5px] whitespace-pre-line text-mute">{coin.fullDescription}</p>}
          <div className="rule-top tabular grid grid-cols-[auto_auto_auto_minmax(0,1fr)] items-end gap-7 pt-3 whitespace-nowrap max-md:grid-cols-2">
            <div className="flex flex-col gap-[3px]">
              <span className="text-[11px] text-faint">Price</span>
              <span className="text-[17px] font-medium tracking-[-0.01em]">{quote ? money.px(coin.price, coin.tokenDecimals, quote) : "…"}</span>
            </div>
            <div className="flex flex-col gap-[3px]">
              <span className="text-[11px] text-faint">Market cap</span>
              <span className="text-[17px] font-medium tracking-[-0.01em]">{quote ? money.big(coin.marketCapQuote, quote) : "…"}</span>
            </div>
            <div className="flex flex-col gap-[3px]">
              <span className="text-[11px] text-faint">Since launch</span>
              <span className="text-[17px] font-medium tracking-[-0.01em]" style={{ color: change === null ? undefined : change >= 0 ? UP_COLOR : DOWN_COLOR }}>
                {change === null ? "–" : pct(change)}
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-2 pb-1">
              <div className="flex items-baseline justify-between gap-3 text-[11px] text-faint">
                <span>
                  {graduated ? "Graduated" : "Bonding curve"} <span className="ml-1 text-[12px] font-medium text-text">{progress.toFixed(1)}%</span>
                </span>
                <span className="text-[11.5px] text-amber">
                  {graduated ? "Pool liquidity locked" : quote ? `${money.fixed(quoteToGraduate(coin), quote)} to graduate` : ""}
                </span>
              </div>
              <div className="relative h-2 overflow-hidden rounded-[4px] bg-[rgba(245,241,232,0.08)]">
                <div className="h-full rounded-[4px] bg-orange transition-[width] duration-500" style={{ width: `${progress}%` }} />
                {[25, 50, 75].map((at) => (
                  <span key={at} className="absolute top-0 bottom-0 w-0.5 bg-panel" style={{ left: `${at}%` }} />
                ))}
              </div>
            </div>
          </div>
        </section>
        {quote && <PriceChart coin={coin} quote={quote} version={version} />}
        {quote && <CoinActivity coin={coin} quote={quote} trades={trades} holders={holders.data} now={now} />}
      </main>

      <aside className="flex min-w-0 flex-col gap-2.5">
        {graduated && quote && (
          <section className="flex flex-col gap-3 rounded-[12px] border border-[rgba(247,147,26,0.4)] bg-panel p-4">
            <div className="flex items-center gap-2">
              <Icon name="grad" size={16} color="#F7931A" />
              <span className="text-[14px] font-medium">Graduated to Arch Swap</span>
              <span className="ml-auto text-[11.5px] text-faint">{coin.graduatedAt ? `${timeAgo(coin.graduatedAt, now)} ago` : ""}</span>
            </div>
            <p className="pretty m-0 text-[12.5px] leading-[1.5] text-mute">
              The curve is closed. {coin.symbol} now trades in its Arch Swap pool, and the starting liquidity is locked.
            </p>
            <div className="tabular flex flex-col gap-2 rounded-[10px] bg-deep p-3 text-[12.5px] whitespace-nowrap">
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">Moved into the pool</span>
                <span>
                  {money.fixed(coin.graduationQuote, quote)} + {formatTokens(poolTokens, coin.tokenDecimals)} {coin.symbol}
                </span>
              </div>
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">Starting liquidity</span>
                <span className="text-up">Locked</span>
              </div>
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">Market cap at graduation</span>
                <span>{money.big(gradMc, quote)}</span>
              </div>
              <div className="flex justify-between gap-2.5">
                <span className="text-dim">Pool fee</span>
                <span>{formatBps(coin.poolFeeBps)}</span>
              </div>
            </div>
          </section>
        )}
        {quote ? (
          <TradeBox coin={coin} quote={quote} market={market} position={position} busy={trade !== null} onTrade={setTrade} />
        ) : (
          network && <Notice>This coin is priced in an asset this app does not recognise, so it cannot be traded here.</Notice>
        )}
        {windowLeft > 0 && (
          <div className="rounded-[10px] bg-[rgba(247,147,26,0.12)] px-3 py-2.5 text-[12px] text-amber-pale">
            Launch window open for {formatDuration(windowLeft)} more.
          </div>
        )}
        <section className="tabular flex flex-col gap-3.5 rounded-[12px] border border-line bg-panel p-3.5 whitespace-nowrap">
          <div className="grid grid-cols-3 overflow-hidden rounded-[10px] border border-line">
            {changeCell("5M", c5)}
            {changeCell("1H", c60, "border-l border-line")}
            {changeCell("LAUNCH", change, "border-l border-line bg-[rgba(245,241,232,0.04)]")}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[12px] text-dim">
              <span>
                Buys <span className="text-text">{int(stats.buys)}</span>
              </span>
              {!complete && trades.length > 0 && <span className="text-faint">last {int(trades.length)} trades</span>}
              <span>
                Sells <span className="text-text">{int(stats.sells)}</span>
              </span>
            </div>
            <div className="flex h-1 gap-[3px]">
              <span className="rounded-[2px] bg-up" style={{ flex: stats.buys || (stats.sells ? 0 : 1) }} />
              <span className="rounded-[2px] bg-down" style={{ flex: stats.sells || (stats.buys ? 0 : 1) }} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-faint">Volume</span>
              <span className="text-[13px] font-medium">{quote ? money.big(coin.volumeQuote, quote) : "…"}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-faint">Holders</span>
              <span className="text-[13px] font-medium">{holdersCount !== null ? int(holdersCount) : "…"}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-faint">Creator earned</span>
              <span className="text-[13px] font-medium text-amber-pale">{quote ? money.big(coin.creatorFees, quote) : "…"}</span>
            </div>
          </div>
        </section>
        <SafetyFacts coin={coin} holdersData={holders.data} creatorBuyBps={creatorBuyBps} />
      </aside>

      {trade && quote && (
        <TradeDialog
          coin={coin}
          quote={quote}
          side={trade.side}
          amountIn={trade.amountIn}
          slippageBps={trade.slippageBps}
          onClose={() => setTrade(null)}
          onDone={(result) => {
            void readChain();
            holders.reload();
            if (result.graduated) setGraduating(true);
          }}
        />
      )}
      {graduating && quote && <GraduationModal coin={coin} quote={quote} holders={holdersCount} onClose={() => setGraduating(false)} />}
    </div>
  );
}
