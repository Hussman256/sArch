"use client";

/** One coin: its chart, the trade box, how close it is to graduating, who holds it and what it is doing right now. */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Position } from "@archpad/sdk";
import { type CoinDetail, type Holders, type QuoteAsset, type TradeRecord, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import {
  formatBps,
  formatDuration,
  formatPrice,
  formatQuote,
  formatTokens,
  shortAddress,
  timeAgo,
} from "@/lib/format.ts";
import { useLoaded, useNow, useStream } from "@/lib/hooks.ts";
import type { Market } from "@/lib/quote.ts";
import { PriceChart } from "./PriceChart.tsx";
import { TradeBox } from "./TradeBox.tsx";
import { Address, CoinImage, Notice, Progress, Skeleton, Stat } from "./ui.tsx";

const LINK_LABELS = { website: "Website", x: "X", telegram: "Telegram" } as const;

function Header({ coin, quote }: { coin: CoinDetail; quote: QuoteAsset | undefined }) {
  const { notify } = useApp();
  return (
    <section className="panel p-4">
      <div className="flex items-start gap-4">
        <CoinImage coin={coin} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-baseline gap-x-3 text-xl font-bold">
            <span className="break-words">{coin.name || "Unnamed"}</span>
            <span className="text-sm font-medium text-dim">{coin.symbol}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
            <span>
              Created by <Address value={coin.creator} href={`/profile/${coin.creator}`} />
            </span>
            <button
              className="font-mono hover:text-accent"
              title="Copy the coin's address"
              onClick={() => {
                void navigator.clipboard.writeText(coin.mint);
                notify("info", "Coin address copied.");
              }}
            >
              {shortAddress(coin.mint, 6)} ⧉
            </button>
            {(Object.keys(LINK_LABELS) as (keyof typeof LINK_LABELS)[]).map((key) => {
              const href = coin.links[key];
              // Links come from the creator. Only plain https ones are ever rendered.
              return href && /^https:\/\//i.test(href) ? (
                <a key={key} href={href} target="_blank" rel="noreferrer noopener nofollow ugc" className="text-accent hover:underline">
                  {LINK_LABELS[key]}
                </a>
              ) : null;
            })}
          </div>
          {coin.fullDescription && (
            <p className="mt-2 text-sm whitespace-pre-line text-text/90 break-words">{coin.fullDescription}</p>
          )}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
        <Stat label="Price">{quote ? formatPrice(coin.price, coin.tokenDecimals, quote) : "…"}</Stat>
        <Stat label="Market cap">{quote ? formatQuote(coin.marketCapQuote, quote, { compact: true }) : "…"}</Stat>
        <Stat label="Volume">{quote ? formatQuote(coin.volumeQuote, quote, { compact: true }) : "…"}</Stat>
        <Stat label="Trades">{coin.tradeCount.toLocaleString("en-US")}</Stat>
      </div>
    </section>
  );
}

function GraduationCard({ coin, quote }: { coin: CoinDetail; quote: QuoteAsset | undefined }) {
  const graduated = coin.status === "graduated";
  return (
    <section className="panel p-4" aria-label="Graduation">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{graduated ? "Graduated" : "Progress to graduation"}</h2>
        <span className="tabular text-sm font-semibold">{(coin.progressBps / 100).toFixed(1)}%</span>
      </div>
      <div className="mt-2">
        <Progress bps={coin.progressBps} graduated={graduated} />
      </div>
      {graduated ? (
        <p className="mt-3 text-xs text-dim">
          The curve sold out and everything it raised moved into a liquidity pool, together with the supply held back for
          it. That liquidity is locked: nobody, including the creator and the platform, can take it out. Trading
          continues on the pool.
        </p>
      ) : (
        <>
          <p className="tabular mt-3 text-xs text-dim">
            {quote ? formatQuote(coin.raisedQuote, quote) : coin.raisedQuote} raised of{" "}
            {quote ? formatQuote(coin.graduationQuote, quote) : coin.graduationQuote} ·{" "}
            {formatTokens(coin.curveTokensLeft, coin.tokenDecimals)} {coin.symbol} left on the curve
          </p>
          <p className="mt-2 text-xs text-dim">
            When the last curve token is sold, the coin graduates in that same transaction: what the curve raised becomes
            locked pool liquidity. There is no graduation fee.
          </p>
        </>
      )}
    </section>
  );
}

function HoldersCard({ coin, holders }: { coin: CoinDetail; holders: Holders | null }) {
  const labels = { curve: "Bonding curve", pool: "Liquidity pool (locked)", creator: "Creator" } as const;
  return (
    <section className="panel p-4" aria-label="Holders">
      <h2 className="text-sm font-semibold">Holders{holders ? ` (${holders.count})` : ""}</h2>
      {!holders ? (
        <Skeleton className="mt-3 h-24" />
      ) : holders.top.length === 0 ? (
        <p className="mt-3 text-sm text-dim">Nobody holds this coin yet.</p>
      ) : (
        <ol className="mt-3 space-y-1.5 text-sm">
          {holders.top.map((holder, index) => (
            <li key={holder.owner} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="tabular mr-2 text-xs text-dim">{index + 1}.</span>
                {holder.label === "curve" || holder.label === "pool" ? (
                  <span className="text-dim">{labels[holder.label]}</span>
                ) : (
                  <>
                    <Address value={holder.owner} href={`/profile/${holder.owner}`} />
                    {holder.label === "creator" && <span className="ml-2 text-xs text-accent">{labels.creator}</span>}
                  </>
                )}
              </span>
              <span className="tabular shrink-0">{(holder.shareBps / 100).toFixed(2)}%</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-[11px] text-dim">
        Supply is fixed at {formatTokens(coin.totalSupply, coin.tokenDecimals)} and no account can be frozen.
      </p>
    </section>
  );
}

function TradesTable({ coin, quote, trades, now }: { coin: CoinDetail; quote: QuoteAsset | undefined; trades: TradeRecord[]; now: number }) {
  return (
    <section className="panel overflow-hidden" aria-label="Trades">
      <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Trades</h2>
      {trades.length === 0 ? (
        <p className="px-4 py-6 text-sm text-dim">No trades yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-dim">
              <tr>
                <th className="px-4 py-2 font-medium">Wallet</th>
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-4 py-2 text-right font-medium">{quote?.symbol ?? "Quote"}</th>
                <th className="px-4 py-2 text-right font-medium">{coin.symbol || "Tokens"}</th>
                <th className="px-4 py-2 text-right font-medium">Price</th>
                <th className="px-4 py-2 text-right font-medium">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {trades.map((trade) => (
                <tr key={trade.id}>
                  <td className="px-4 py-2">
                    <Address value={trade.trader} href={`/profile/${trade.trader}`} />
                  </td>
                  <td className={`px-4 py-2 font-medium ${trade.side === "buy" ? "text-up" : "text-down"}`}>
                    {trade.side === "buy" ? "Buy" : "Sell"}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{quote ? formatQuote(trade.quoteAmount, quote) : trade.quoteAmount}</td>
                  <td className="tabular px-4 py-2 text-right">{formatTokens(trade.tokenAmount, coin.tokenDecimals)}</td>
                  <td className="tabular px-4 py-2 text-right text-dim">
                    {quote ? formatPrice(trade.price, coin.tokenDecimals, quote) : "…"}
                  </td>
                  <td className="tabular px-4 py-2 text-right text-dim" title={trade.txid}>
                    {timeAgo(trade.timestamp, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CoinPage({ mint }: { mint: string }) {
  const { client, wallet, quoteOf, activity, network } = useApp();
  const now = useNow();
  const detail = useLoaded(mint, () => api.coin(mint), 30_000);
  const holders = useLoaded(`holders:${mint}`, () => api.holders(mint), 20_000);
  const [coin, setCoin] = useState<CoinDetail | null>(null);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [market, setMarket] = useState<Market | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => setCoin(detail.data), [detail.data]);
  useEffect(() => {
    setTrades([]);
    api.trades(mint, { limit: 50 }).then(setTrades).catch(() => undefined);
  }, [mint]);

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
      setTrades((list) => [message.trade, ...list.filter((trade) => trade.id !== message.trade.id)].slice(0, 100));
      setVersion((value) => value + 1);
      reloadHolders();
    }
    void readChain();
  });

  if (detail.error && !coin) {
    return (
      <Notice tone="error">
        {/no coin/.test(detail.error) ? "No coin with that address has been launched here." : `Could not load this coin: ${detail.error}`}{" "}
        <Link href="/" className="text-accent hover:underline">
          Back to all coins
        </Link>
      </Notice>
    );
  }
  if (!coin) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const quote = quoteOf(coin.quoteMint);
  const windowLeft = coin.status === "trading" ? coin.earlyWindowEnd - now : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="flex min-w-0 flex-col gap-6">
        <Header coin={coin} quote={quote} />
        {quote && <PriceChart coin={coin} quote={quote} version={version} />}
        <TradesTable coin={coin} quote={quote} trades={trades} now={now} />
      </div>
      <div className="flex flex-col gap-6">
        {quote ? (
          <TradeBox
            coin={coin}
            quote={quote}
            market={market}
            position={position}
            onTraded={() => {
              void readChain();
              holders.reload();
            }}
          />
        ) : (
          network && <Notice>This coin is priced in an asset this app does not recognise, so it cannot be traded here.</Notice>
        )}
        <GraduationCard coin={coin} quote={quote} />
        <HoldersCard coin={coin} holders={holders.data} />
        <section className="panel space-y-1 p-4 text-xs text-dim" aria-label="Terms">
          <h2 className="mb-2 text-sm font-semibold text-text">This coin's terms</h2>
          <p>
            Trading fee on the curve: {formatBps(coin.platformFeeBps + coin.creatorFeeBps)} ({formatBps(coin.platformFeeBps)}{" "}
            platform, {formatBps(coin.creatorFeeBps)} creator). On the pool after graduation: {formatBps(coin.poolFeeBps)}.
          </p>
          <p>These were fixed when the coin launched. Later changes to the platform's settings do not affect it.</p>
          {windowLeft > 0 && (
            <p className="text-accent">
              Launch window open for another {formatDuration(windowLeft)}: each wallet can buy at most{" "}
              {formatTokens(coin.earlyWalletCap, coin.tokenDecimals)} {coin.symbol}.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
