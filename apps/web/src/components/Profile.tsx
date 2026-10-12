"use client";

/** A wallet's page: the coins it launched and what they have earned, what it holds, and what it has traded. */
import Link from "next/link";
import { useState } from "react";
import { isAddress } from "@archpad/sdk";
import { type CoinView, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { formatQuote, formatTokens, timeAgo } from "@/lib/format.ts";
import { useLoaded, useNow } from "@/lib/hooks.ts";
import { CoinImage, Notice, Progress, Skeleton } from "./ui.tsx";

export function Profile({ address }: { address: string }) {
  const { wallet, client, send, quoteOf, notify } = useApp();
  const now = useNow();
  const valid = isAddress(address);
  const profile = useLoaded(valid ? address : null, () => api.wallet(address), 20_000);
  const [claiming, setClaiming] = useState<string | null>(null);
  const mine = wallet?.address === address;

  if (!valid) return <Notice tone="error">That is not a valid wallet address.</Notice>;
  if (profile.error && !profile.data) return <Notice tone="error">Could not load this profile: {profile.error}</Notice>;
  if (!profile.data) return <Skeleton className="h-96" />;
  const { created, holdings, quoteBalances, trades } = profile.data;

  const claim = async (coin: CoinView) => {
    if (!client || !wallet) return;
    setClaiming(coin.mint);
    try {
      await send(client.planClaimCreatorFees(wallet.address, coin), {
        doing: `Claiming your ${coin.symbol} fees.`,
        done: `Your ${coin.symbol} fees are in your wallet.`,
      });
      profile.reload();
    } finally {
      setClaiming(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="panel p-4">
        <h1 className="text-lg font-bold">{mine ? "My profile" : "Wallet"}</h1>
        <button
          className="mt-1 font-mono text-xs break-all text-dim hover:text-accent"
          title="Copy address"
          onClick={() => {
            void navigator.clipboard.writeText(address);
            notify("info", "Address copied.");
          }}
        >
          {address}
        </button>
        {quoteBalances.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            {quoteBalances.map((balance) => {
              const quote = quoteOf(balance.mint);
              return quote ? (
                <span key={balance.mint} className="tabular">
                  {formatQuote(balance.amount, quote)}
                </span>
              ) : null;
            })}
          </div>
        )}
      </section>

      <section aria-label="Coins launched">
        <h2 className="mb-3 text-sm font-semibold">Coins launched ({created.length})</h2>
        {created.length === 0 ? (
          <Notice>
            {mine ? "You have not launched a coin yet. " : "This wallet has not launched a coin. "}
            {mine && (
              <Link href="/create" className="text-accent hover:underline">
                Launch one
              </Link>
            )}
          </Notice>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {created.map((coin) => {
              const quote = quoteOf(coin.quoteMint);
              const unclaimed = BigInt(coin.unclaimedCreatorFees);
              return (
                <div key={coin.mint} className="panel p-4">
                  <Link href={`/coin/${coin.mint}`} className="flex items-center gap-3 hover:text-accent">
                    <CoinImage coin={coin} size={40} />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{coin.name}</div>
                      <div className="text-xs text-dim">{coin.symbol}</div>
                    </div>
                  </Link>
                  <div className="mt-3">
                    <Progress bps={coin.progressBps} graduated={coin.status === "graduated"} />
                  </div>
                  <dl className="mt-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-dim">Fees earned so far</dt>
                      <dd className="tabular">{quote ? formatQuote(coin.creatorFees, quote) : coin.creatorFees}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-dim">Waiting to be claimed</dt>
                      <dd className="tabular font-semibold">{quote ? formatQuote(unclaimed, quote) : unclaimed.toString()}</dd>
                    </div>
                  </dl>
                  {mine && (
                    <button
                      className="button-primary mt-3 w-full"
                      disabled={unclaimed === 0n || claiming !== null}
                      onClick={() => claim(coin)}
                    >
                      {claiming === coin.mint ? "Waiting for your wallet…" : unclaimed === 0n ? "Nothing to claim yet" : "Claim fees"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel overflow-hidden" aria-label="Holdings">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Coins held ({holdings.length})</h2>
        {holdings.length === 0 ? (
          <p className="px-4 py-6 text-sm text-dim">No coins from this launchpad in this wallet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {holdings.map(({ coin, amount, valueQuote }) => {
              const quote = quoteOf(coin.quoteMint);
              return (
                <li key={coin.mint}>
                  <Link href={`/coin/${coin.mint}`} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-raised">
                    <CoinImage coin={coin} size={32} />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {coin.name} <span className="text-xs text-dim">{coin.symbol}</span>
                    </span>
                    <span className="tabular text-right">
                      {formatTokens(amount, coin.tokenDecimals)}
                      <span className="block text-xs text-dim" title="At the current price, before fees and price impact">
                        ≈ {quote ? formatQuote(valueQuote, quote) : valueQuote}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="panel overflow-hidden" aria-label="Recent trades">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Recent trades</h2>
        {trades.length === 0 ? (
          <p className="px-4 py-6 text-sm text-dim">No trades yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {trades.map((trade) => {
              const quote = quoteOf(trade.quoteMint);
              return (
                <li key={trade.id}>
                  <Link href={`/coin/${trade.mint}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-raised">
                    <span>
                      <span className={trade.side === "buy" ? "text-up" : "text-down"}>
                        {trade.side === "buy" ? "Bought" : "Sold"}
                      </span>{" "}
                      <span className="font-medium">{trade.symbol || "a coin"}</span>
                    </span>
                    <span className="tabular text-dim">
                      {quote ? formatQuote(trade.quoteAmount, quote) : trade.quoteAmount} · {timeAgo(trade.timestamp, now)} ago
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
