"use client";

/** A coin's trades as they happen, and who holds it. */
import Link from "next/link";
import { useState } from "react";
import type { CoinView, Holders, QuoteAsset, TradeRecord } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { bpsPct, top10Bps } from "@/lib/coin.ts";
import { DOWN_COLOR, UP_COLOR, ident } from "@/lib/design-system.ts";
import { formatTokens, int, shortAddress, timeAgo } from "@/lib/format.ts";
import { assetKind } from "@/lib/money.ts";
import { Icon } from "./icons.tsx";
import { Skeleton } from "./ui.tsx";

export type LiveTrade = TradeRecord & { fresh?: boolean };

const TRADE_COLS = "grid-cols-[44px_48px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.5fr)_44px]";
const HOLDER_COLS = "grid-cols-[24px_minmax(0,1.4fr)_minmax(0,2fr)_56px]";

export function CoinActivity({
  coin,
  quote,
  trades,
  holders,
  now,
}: {
  coin: CoinView;
  quote: QuoteAsset;
  trades: LiveTrade[];
  holders: Holders | null;
  now: number;
}) {
  const { money, wallet, unit, btcPrice } = useApp();
  const [tab, setTab] = useState<"trades" | "holders">("trades");
  const graduated = coin.status === "graduated";
  const kind = assetKind(quote);
  const sizeHead = unit === "usd" && (kind === "usd" || btcPrice) ? "USD" : kind === "btc" ? "Sats" : quote.symbol;

  const tabBtn = (key: "trades" | "holders") =>
    `flex items-center gap-[7px] border-b-2 text-[13px] font-medium ${tab === key ? "border-orange text-text" : "border-transparent text-dim hover:text-text"}`;

  return (
    <section className="flex flex-col overflow-hidden rounded-[14px] border border-[rgba(245,241,232,0.07)] bg-panel">
      <div className="flex h-11 items-stretch gap-5 border-b border-[rgba(245,241,232,0.06)] px-4">
        <button onClick={() => setTab("trades")} className={tabBtn("trades")}>
          <span className="h-1.5 w-1.5 rounded-full bg-up shadow-[0_0_0_3px_rgba(102,222,142,0.16)]" />
          Trades
        </button>
        <button onClick={() => setTab("holders")} className={tabBtn("holders")}>
          Holders <span className="tabular text-faint">{holders ? int(holders.count) : ""}</span>
        </button>
        <div className="ml-auto flex items-center gap-3.5 text-[11.5px] whitespace-nowrap text-faint max-md:hidden">
          <span className="flex items-center gap-1.5">
            <span className="h-[7px] w-[7px] rounded-full bg-up" />
            Final on Arch
          </span>
        </div>
      </div>

      {tab === "trades" && (
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            {graduated && (
              <div className="mx-4 mt-2.5 mb-0.5 flex items-center gap-2 rounded-[8px] bg-[rgba(247,147,26,0.1)] px-3 py-[9px] text-[12px] text-amber-pale">
                <Icon name="lock" size={14} />
                The curve closed at graduation. Trades since then are swaps on the {coin.symbol} pool.
              </div>
            )}
            <div className={`grid ${TRADE_COLS} gap-2.5 px-4 pt-2.5 pb-1.5 text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase`}>
              <span>Age</span>
              <span>Side</span>
              <span className="text-right">{sizeHead}</span>
              <span className="truncate text-right">{coin.symbol}</span>
              <span className="text-right">Price</span>
              <span className="pl-3.5">Trader</span>
              <span className="text-right">Status</span>
            </div>
            {trades.length === 0 && <p className="px-4 pt-4 pb-6 text-[12.5px] text-faint">No trades yet. They appear here the moment they are final.</p>}
            {trades.map((trade) => {
              const buy = trade.side === "buy";
              const me = wallet?.address === trade.trader;
              return (
                <div
                  key={trade.id}
                  className={`tabular grid ${TRADE_COLS} h-[34px] items-center gap-2.5 px-4 text-[12.5px]`}
                  style={{
                    background: me ? "rgba(247,147,26,0.12)" : trade.fresh ? (buy ? "rgba(102,222,142,0.12)" : "rgba(255,107,122,0.12)") : "transparent",
                    transition: trade.fresh ? "none" : "background 1.4s ease",
                  }}
                >
                  <span className="text-faint" title={new Date(trade.timestamp * 1000).toLocaleString()}>
                    {timeAgo(trade.timestamp, now)}
                  </span>
                  <span className="font-medium" style={{ color: buy ? UP_COLOR : DOWN_COLOR }}>
                    {buy ? "Buy" : "Sell"}
                  </span>
                  <span className="text-right" style={{ color: buy ? UP_COLOR : DOWN_COLOR }}>
                    {money.size(trade.quoteAmount, quote).replace(/ sats$/, "")}
                  </span>
                  <span className="text-right text-soft">{formatTokens(trade.tokenAmount, coin.tokenDecimals)}</span>
                  <span className="text-right text-dim">{money.px(trade.price, coin.tokenDecimals, quote, true)}</span>
                  <Link href={`/profile/${trade.trader}`} className="flex min-w-0 items-center gap-2 pl-3.5 text-mute hover:text-text" title={trade.trader}>
                    <span
                      className="h-4 w-4 flex-none rounded-full"
                      style={{ background: me ? "linear-gradient(135deg,#FFB257,#7A4A0E)" : ident(trade.trader) }}
                    />
                    <span className="truncate">{me ? "You" : shortAddress(trade.trader)}</span>
                  </Link>
                  <span className="flex justify-end" title={`Final on Arch, block ${int(trade.height)}`}>
                    <span className="h-[7px] w-[7px] rounded-full bg-up" />
                  </span>
                </div>
              );
            })}
            <div className="h-2" />
          </div>
        </div>
      )}

      {tab === "holders" && <HoldersTab coin={coin} holders={holders} />}
    </section>
  );
}

function HoldersTab({ coin, holders }: { coin: CoinView; holders: Holders | null }) {
  if (!holders) return <Skeleton className="m-4 h-40" />;
  if (holders.top.length === 0) return <p className="px-4 py-6 text-[12.5px] text-faint">Nobody holds this coin yet.</p>;

  const program = holders.top.filter((h) => h.label === "curve" || h.label === "pool");
  const wallets = holders.top.filter((h) => h.label !== "curve" && h.label !== "pool").slice(0, 10);
  const programBps = program.reduce((total, h) => total + h.shareBps, 0);
  const walletsBps = top10Bps(holders);
  const restBps = Math.max(0, 10_000 - programBps - walletsBps);
  const isPool = program.some((h) => h.label === "pool");
  const maxBps = Math.max(1, ...holders.top.map((h) => h.shareBps));
  const segments = [
    ...program.map((h) => ({ f: h.shareBps, bg: "rgba(247,147,26,0.6)", title: `${h.label === "pool" ? "Pool" : "Bonding curve"} · ${bpsPct(h.shareBps)}` })),
    ...wallets.map((h, i) => ({ f: h.shareBps, bg: `rgba(245,241,232,${(0.86 - i * 0.06).toFixed(2)})`, title: `${shortAddress(h.owner)} · ${bpsPct(h.shareBps, 2)}` })),
    { f: restBps, bg: "rgba(245,241,232,0.1)", title: `Everyone else · ${bpsPct(restBps)}` },
  ].filter((segment) => segment.f > 0);

  let rank = 0;
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[520px]">
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-1.5">
          <div className="flex h-[22px] gap-0.5 overflow-hidden rounded-[6px]">
            {segments.map((segment) => (
              <span key={segment.title} title={segment.title} className="h-full min-w-[3px]" style={{ flex: segment.f, background: segment.bg }} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] whitespace-nowrap text-dim">
            <span className="flex items-center gap-1.5">
              <span className="h-[9px] w-[9px] rounded-[2px] bg-[rgba(247,147,26,0.6)]" />
              {isPool ? "Liquidity pool" : "Bonding curve"} {bpsPct(programBps)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-[9px] w-[9px] rounded-[2px] bg-soft" />
              Top 10 wallets {bpsPct(walletsBps)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-[9px] w-[9px] rounded-[2px] bg-[rgba(245,241,232,0.14)]" />
              Everyone else {bpsPct(restBps)}
            </span>
          </div>
        </div>
        <div className={`grid ${HOLDER_COLS} gap-3 px-4 pt-2.5 pb-1.5 text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase`}>
          <span>#</span>
          <span>Holder</span>
          <span>Share of supply</span>
          <span className="text-right">%</span>
        </div>
        {holders.top.map((holder) => {
          const isProgram = holder.label === "curve" || holder.label === "pool";
          if (!isProgram) rank++;
          const tag = holder.label === "curve" ? "Curve" : holder.label === "pool" ? "Pool, locked" : holder.label === "creator" ? "Creator" : null;
          return (
            <div key={holder.owner} className={`tabular grid ${HOLDER_COLS} h-9 items-center gap-3 px-4 text-[12.5px]`}>
              <span className="text-ghost">{isProgram ? "" : rank}</span>
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-[18px] w-[18px] flex-none rounded-full" style={{ background: isProgram ? "rgba(247,147,26,0.35)" : ident(holder.owner) }} />
                {isProgram ? (
                  <span className="whitespace-nowrap text-soft">{holder.label === "pool" ? "Liquidity pool" : "Bonding curve"}</span>
                ) : (
                  <Link href={`/profile/${holder.owner}`} className="whitespace-nowrap text-soft hover:text-text" title={holder.owner}>
                    {shortAddress(holder.owner)}
                  </Link>
                )}
                {tag && (
                  <span
                    className="rounded-[5px] px-1.5 py-0.5 text-[10.5px] whitespace-nowrap"
                    style={
                      holder.label === "creator"
                        ? { color: "#FFC98A", background: "rgba(247,147,26,0.18)" }
                        : { color: "#FFB257", background: "rgba(247,147,26,0.12)" }
                    }
                  >
                    {tag}
                  </span>
                )}
              </span>
              <span className="h-1.5 overflow-hidden rounded-[3px] bg-[rgba(245,241,232,0.05)]">
                <span
                  className="block h-full rounded-[3px]"
                  style={{ width: `${((holder.shareBps / maxBps) * 100).toFixed(1)}%`, background: isProgram ? "rgba(247,147,26,0.6)" : "rgba(245,241,232,0.45)" }}
                />
              </span>
              <span className="text-right">{bpsPct(holder.shareBps)}</span>
            </div>
          );
        })}
        <div className="px-4 pt-2.5 pb-3.5 text-[11.5px] text-faint">
          {coin.status === "graduated"
            ? `The pool's liquidity is locked. Supply is fixed at ${formatTokens(coin.totalSupply, coin.tokenDecimals)} ${coin.symbol}.`
            : "The bonding curve holds unsold supply plus the reserve that moves into the pool at graduation."}
        </div>
      </div>
    </div>
  );
}
