"use client";

/** The home page: coins by newest, trending and nearest to graduating, and a live feed of trades. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { type CoinSort, type CoinView, type FeedTrade, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { formatQuote, shortAddress, timeAgo } from "@/lib/format.ts";
import { useLoaded, useNow, useStream } from "@/lib/hooks.ts";
import { CoinCard, CoinImage, Notice, Skeleton } from "./ui.tsx";

const TABS: { sort: CoinSort; label: string; empty: string }[] = [
  { sort: "trending", label: "Trending", empty: "Nothing has traded in the last hour." },
  { sort: "new", label: "New", empty: "No coins have been launched yet." },
  { sort: "graduating", label: "Graduating", empty: "No coins are on their way to graduating." },
  { sort: "graduated", label: "Graduated", empty: "No coin has graduated yet." },
];

const PAGE = 24;

function LiveFeed({ trades, now }: { trades: FeedTrade[]; now: number }) {
  const { quoteOf } = useApp();
  if (trades.length === 0) return <p className="px-4 py-6 text-sm text-dim">Trades will appear here as they happen.</p>;
  return (
    <ul className="divide-y divide-line">
      {trades.map((trade) => {
        const quote = quoteOf(trade.quoteMint);
        return (
          <li key={trade.id}>
            <Link href={`/coin/${trade.mint}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-raised">
              <CoinImage coin={trade} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <span className="font-mono text-xs text-dim">{shortAddress(trade.trader)}</span>{" "}
                  <span className={trade.side === "buy" ? "text-up" : "text-down"}>
                    {trade.side === "buy" ? "bought" : "sold"}
                  </span>{" "}
                  <span className="font-medium">{trade.symbol || "a coin"}</span>
                </div>
                <div className="tabular text-xs text-dim">
                  {quote ? formatQuote(trade.quoteAmount, quote) : trade.quoteAmount}
                </div>
              </div>
              <span className="tabular shrink-0 text-xs text-dim">{timeAgo(trade.timestamp, now)}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Home() {
  const { quoteOf, network } = useApp();
  const now = useNow();
  const [sort, setSort] = useState<CoinSort>("trending");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [quote, setQuote] = useState("");
  const [limit, setLimit] = useState(PAGE);

  // Search as the person types, but not on every keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => setLimit(PAGE), [sort, term, quote]);

  const coins = useLoaded(
    `${sort}:${term}:${quote}:${limit}`,
    () => api.coins({ sort: term ? "new" : sort, q: term, quote, limit }),
    15_000,
  );

  const [feed, setFeed] = useState<FeedTrade[]>([]);
  const [fresh, setFresh] = useState<Map<string, CoinView>>(new Map());
  useEffect(() => {
    api
      .feed(25)
      .then(setFeed)
      .catch(() => undefined);
  }, []);

  useStream(undefined, (message) => {
    if (message.coin) setFresh((map) => new Map(map).set(message.coin!.mint, message.coin!));
    if (message.type === "trade" && message.coin) {
      const row: FeedTrade = {
        ...message.trade,
        symbol: message.coin.symbol,
        name: message.coin.name,
        image: message.coin.image,
        quoteMint: message.coin.quoteMint,
      };
      setFeed((list) => [row, ...list.filter((entry) => entry.id !== row.id)].slice(0, 25));
    }
    // A brand-new coin belongs at the top of the "New" tab straight away.
    if (message.type === "coin" && sort === "new" && !term) coins.reload();
  });

  // Show each listed coin with the latest figures the stream has given us.
  const listed = (coins.data ?? []).map((coin) => fresh.get(coin.mint) ?? coin);
  const tab = TABS.find((entry) => entry.sort === sort)!;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section aria-label="Coins">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-line bg-panel p-1" role="tablist" aria-label="Sort coins">
            {TABS.map((entry) => (
              <button
                key={entry.sort}
                role="tab"
                aria-selected={sort === entry.sort && !term}
                onClick={() => {
                  setSort(entry.sort);
                  setSearch("");
                }}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  sort === entry.sort && !term ? "bg-accent text-ink" : "text-dim hover:text-text"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <input
            className="field max-w-xs"
            type="search"
            placeholder="Search by name, ticker or address"
            aria-label="Search coins"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {(network?.quotes?.length ?? 0) > 1 && (
            <select className="field w-auto" aria-label="Priced in" value={quote} onChange={(event) => setQuote(event.target.value)}>
              <option value="">Priced in anything</option>
              {network!.quotes!.map((asset) => (
                <option key={asset.mint} value={asset.mint}>
                  Priced in {asset.symbol}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="mt-4">
          {coins.loading && !coins.data ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-40" />
              ))}
            </div>
          ) : coins.error && !coins.data ? (
            <Notice tone="error">Could not load coins: {coins.error}</Notice>
          ) : listed.length === 0 ? (
            <Notice>
              {term ? `No coin matches “${term}”.` : tab.empty}{" "}
              <Link href="/create" className="text-accent hover:underline">
                Launch one
              </Link>
              .
            </Notice>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {listed.map((coin) => (
                  <CoinCard key={coin.mint} coin={coin} quote={quoteOf(coin.quoteMint)} now={now} />
                ))}
              </div>
              {listed.length >= limit && (
                <div className="mt-4 text-center">
                  <button className="button-quiet" onClick={() => setLimit((value) => Math.min(100, value + PAGE))} disabled={limit >= 100}>
                    Show more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <aside aria-label="Live trades">
        <div className="panel overflow-hidden">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Live trades</h2>
          <LiveFeed trades={feed} now={now} />
        </div>
      </aside>
    </div>
  );
}
