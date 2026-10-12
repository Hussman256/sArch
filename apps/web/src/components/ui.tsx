"use client";

/** Small pieces used all over the app. */
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { CoinView, QuoteAsset } from "@/lib/api.ts";
import { compact, formatPrice, formatQuote, shortAddress, timeAgo } from "@/lib/format.ts";

/** A coin's picture, or its initial when the picture is missing or will not load. */
export function CoinImage({ coin, size = 48 }: { coin: Pick<CoinView, "image" | "symbol" | "name">; size?: number }) {
  const [broken, setBroken] = useState(false);
  // Only links that are plainly web addresses are loaded; anything else a
  // creator managed to put on chain is shown as the fallback.
  const usable = /^https?:\/\//i.test(coin.image) && !broken;
  const style = { width: size, height: size };
  if (!usable) {
    return (
      <div
        style={style}
        className="flex shrink-0 items-center justify-center rounded-lg bg-raised font-bold text-dim"
        aria-hidden="true"
      >
        {(coin.symbol || coin.name || "?").slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={coin.image}
      alt=""
      style={style}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-lg bg-raised object-cover"
      onError={() => setBroken(true)}
    />
  );
}

/** How far a curve is toward graduating. */
export function Progress({ bps, graduated }: { bps: number; graduated: boolean }) {
  const percent = Math.min(100, bps / 100);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-raised"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={graduated ? "Graduated" : "Progress to graduation"}
    >
      <div
        className={`h-full rounded-full ${graduated ? "bg-up" : "bg-accent"}`}
        style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}

export function Address({ value, href }: { value: string; href?: string }) {
  const text = <span className="font-mono text-xs">{shortAddress(value)}</span>;
  return href ? (
    <Link href={href} className="text-dim hover:text-accent" title={value}>
      {text}
    </Link>
  ) : (
    <span className="text-dim" title={value}>
      {text}
    </span>
  );
}

/** A coin in a list: who it is, what it is worth, how far along it is. */
export function CoinCard({ coin, quote, now }: { coin: CoinView; quote: QuoteAsset | undefined; now: number }) {
  const graduated = coin.status === "graduated";
  return (
    <Link
      href={`/coin/${coin.mint}`}
      className="panel flex flex-col gap-3 p-4 transition-colors hover:border-accent"
    >
      <div className="flex items-start gap-3">
        <CoinImage coin={coin} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-semibold">{coin.name || "Unnamed"}</span>
            <span className="shrink-0 text-xs text-dim">{coin.symbol}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-dim">{coin.description || "No description."}</p>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-dim">
          Market cap{" "}
          <span className="tabular font-semibold text-text">
            {quote ? formatQuote(coin.marketCapQuote, quote, { compact: true }) : compact(Number(coin.marketCapQuote))}
          </span>
        </span>
        <span className="text-dim">{timeAgo(coin.createdAt, now)} old</span>
      </div>
      <div>
        <Progress bps={coin.progressBps} graduated={graduated} />
        <div className="mt-1 flex justify-between text-[11px] text-dim">
          <span>{graduated ? "Graduated: trading on the pool" : `${(coin.progressBps / 100).toFixed(1)}% to graduation`}</span>
          <span>{coin.tradeCount} trades</span>
        </div>
      </div>
    </Link>
  );
}

export function Price({ coin, quote }: { coin: Pick<CoinView, "price" | "tokenDecimals">; quote: QuoteAsset | undefined }) {
  return <span className="tabular">{quote ? formatPrice(coin.price, coin.tokenDecimals, quote) : "…"}</span>;
}

/** What to show in place of content that has not arrived, is empty, or failed. */
export function Notice({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "error" }) {
  return (
    <div className={`panel px-4 py-8 text-center text-sm ${tone === "error" ? "text-down" : "text-dim"}`}>{children}</div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-raised ${className}`} aria-hidden="true" />;
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] tracking-wide text-dim uppercase">{label}</div>
      <div className="tabular mt-0.5 text-sm font-semibold">{children}</div>
    </div>
  );
}
