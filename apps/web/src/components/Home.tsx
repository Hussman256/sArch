"use client";

/**
 * Discover: coins by newest, by trading activity and by closeness to
 * graduating, the coins that just graduated, a filter for coins whose
 * supply is not concentrated, and a one-click buy that still shows the
 * numbers before anything is signed.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { type CoinView, type Holders, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { bpsPct, quoteToGraduate, sinceLaunch, top10Bps } from "@/lib/coin.ts";
import { DOWN_COLOR, UP_COLOR } from "@/lib/design-system.ts";
import { compactFixed, int, pct, shortAddress, timeAgo } from "@/lib/format.ts";
import { useHoldersFor, useLoaded, useNow, useStream } from "@/lib/hooks.ts";
import { fromDisplay } from "@/lib/money.ts";
import { Icon } from "./icons.tsx";
import { useWalletPicker } from "./Shell.tsx";
import { TradeDialog } from "./TradeDialog.tsx";
import { Bar, CoinImage, Skeleton } from "./ui.tsx";

const SAFE_TOP10_BPS = 2_500;
const ROWS = 7;

type Mode = "new" | "trend" | "grad";

export function Home() {
  const { network, quoteOf, wallet, money, unit, btcPrice, notify } = useApp();
  const openPicker = useWalletPicker();
  const now = useNow();
  const router = useRouter();
  const params = useSearchParams();
  const term = (params.get("q") ?? "").trim();

  const [quoteFilter, setQuoteFilter] = useState<string>("all");
  const [safe, setSafe] = useState(false);
  const [quick, setQuick] = useState<number>(50_000);
  const [buying, setBuying] = useState<{ coin: CoinView; amount: bigint } | null>(null);
  const [fresh, setFresh] = useState<Map<string, CoinView>>(new Map());
  const [born, setBorn] = useState<Map<string, number>>(new Map());

  // The quick-buy box is in sats or dollars, whichever unit is showing.
  const lastUnit = useRef(unit);
  useEffect(() => {
    if (lastUnit.current === unit) return;
    lastUnit.current = unit;
    setQuick(unit === "usd" ? 50 : 50_000);
  }, [unit]);

  const quoteParam = quoteFilter === "all" ? undefined : quoteFilter;
  const newest = useLoaded(`d:new:${quoteFilter}`, () => api.coins({ sort: "new", limit: 30, ...(quoteParam && { quote: quoteParam }) }), 15_000);
  const trending = useLoaded(`d:trend:${quoteFilter}`, () => api.coins({ sort: "trending", limit: 30, ...(quoteParam && { quote: quoteParam }) }), 15_000);
  const graduating = useLoaded(`d:grad:${quoteFilter}`, () => api.coins({ sort: "graduating", limit: 30, ...(quoteParam && { quote: quoteParam }) }), 15_000);
  const graduated = useLoaded(`d:done:${quoteFilter}`, () => api.coins({ sort: "graduated", limit: 5, ...(quoteParam && { quote: quoteParam }) }), 30_000);
  const results = useLoaded(term ? `d:q:${term}:${quoteFilter}` : null, () => api.coins({ sort: "new", q: term, limit: 30, ...(quoteParam && { quote: quoteParam }) }), 15_000);

  const reloadNew = newest.reload;
  useStream(undefined, (message) => {
    if (message.coin) setFresh((map) => new Map(map).set(message.coin!.mint, message.coin!));
    if (message.type === "coin") {
      setBorn((map) => new Map(map).set(message.mint, Date.now()));
      reloadNew();
    }
    if (message.type === "graduated") graduated.reload();
  });

  const latest = (coins: CoinView[] | null) => (coins ?? []).map((coin) => fresh.get(coin.mint) ?? coin);
  const newList = latest(newest.data).filter((coin) => coin.status === "trading");
  const trendList = latest(trending.data).filter((coin) => coin.status === "trading" && coin.tradeCount > 0);
  const gradList = latest(graduating.data).filter((coin) => coin.status === "trading");
  const resultList = latest(results.data);

  // Holder figures for every coin on screen: the meta line and the safety filter use them.
  const shown = term ? resultList : [...newList.slice(0, 20), ...trendList.slice(0, 20), ...gradList.slice(0, 20)];
  const holders = useHoldersFor(shown.map((coin) => coin.mint));
  const passes = (coin: CoinView) => {
    if (!safe) return true;
    const h = holders.get(coin.mint);
    return h !== undefined && top10Bps(h) < SAFE_TOP10_BPS;
  };

  const hourAgo = now - 3_600;
  const launchedThisHour = latest(newest.data).filter((coin) => coin.createdAt >= hourAgo).length;

  const quickBuy = (coin: CoinView) => {
    if (!wallet) return openPicker();
    const quote = quoteOf(coin.quoteMint);
    if (!quote) return;
    const amount = fromDisplay(quick, unit, quote, btcPrice);
    if (amount === null || amount <= 0n) {
      notify("error", quick > 0 ? `Quick buy cannot convert to ${quote.symbol} without the bitcoin price. Switch the unit or open the coin.` : "Set a quick-buy amount first.");
      return;
    }
    setBuying({ coin, amount });
  };

  const quotes = network?.quotes ?? [];
  const seg = (on: boolean) => `h-7 rounded-[6px] px-2.5 text-[12.5px] font-medium ${on ? "seg-on" : "seg-off"}`;

  const column = (title: string, sub: string, dot: string, count: string, list: CoinView[], mode: Mode, loading: boolean, empty: string) => {
    const rows = list.filter(passes).slice(0, ROWS);
    return (
      <section className="card flex min-w-0 flex-col overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2 whitespace-nowrap">
          <span className="h-2 w-2 flex-none rounded-full" style={{ background: dot }} />
          <h2 className="m-0 text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
          <span className="truncate text-[12px] text-faint">{sub}</span>
          <span className="tabular ml-auto text-[12px] text-faint">{count}</span>
        </div>
        <div className="flex flex-col px-1.5 pb-2">
          {loading
            ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="m-1 h-[64px]" />)
            : rows.length === 0
              ? <p className="px-3 py-8 text-center text-[12.5px] text-faint">{safe && list.length > 0 ? "No coin here passes the top-10 filter yet." : empty}</p>
              : rows.map((coin) => renderRow(coin, mode, holders.get(coin.mint)))}
        </div>
      </section>
    );
  };

  const renderRow = (coin: CoinView, mode: Mode, h: Holders | undefined) => {
    const quote = quoteOf(coin.quoteMint);
    const change = sinceLaunch(coin, network);
    const isNew = now - coin.createdAt < 60 || coin.tradeCount <= 1;
    const progress = Math.min(100, coin.progressBps / 100);
    const arrived = born.get(coin.mint);
    const flash = arrived !== undefined && Date.now() - arrived < 1_600;
    const meta = [
      shortAddress(coin.creator),
      h ? `${int(h.count)} ${h.count === 1 ? "holder" : "holders"}` : null,
      h ? `top 10 ${bpsPct(top10Bps(h))}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const qb = unit === "usd" ? `$${int(quick)}` : compactFixed(quick, 0);
    return (
      <div
        key={coin.mint}
        role="link"
        tabIndex={0}
        onClick={() => router.push(`/coin/${coin.mint}`)}
        onKeyDown={(event) => event.key === "Enter" && router.push(`/coin/${coin.mint}`)}
        className="grid cursor-pointer grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] p-2.5 transition-[background] duration-[1400ms] ease-out hover:bg-[rgba(245,241,232,0.04)]"
        style={flash ? { background: "rgba(247,147,26,0.14)", transition: "none" } : undefined}
      >
        <CoinImage coin={coin} size={48} radius={12} />
        <div className="flex min-w-0 flex-col gap-[5px]">
          <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
            <span className="truncate text-[14px] font-medium">{coin.name || "Unnamed"}</span>
            <span className="text-[12px] text-dim">{coin.symbol}</span>
            <span className="tabular text-[12px] text-faint">{now - coin.createdAt < 5 ? "now" : timeAgo(coin.createdAt, now)}</span>
          </div>
          <div className="tabular truncate text-[12px] text-faint">{meta}</div>
          <div className="flex items-center gap-2">
            <Bar percent={progress} className="flex-1" />
            <span className="tabular text-[11px] whitespace-nowrap text-dim">
              {progress.toFixed(0)}%{mode === "grad" && quote ? ` · ${money.fixed(quoteToGraduate(coin), quote)} to go` : ""}
            </span>
          </div>
        </div>
        <div className="tabular flex flex-col items-end gap-1.5 whitespace-nowrap">
          <span className="text-[13.5px] font-medium">{quote ? money.big(coin.marketCapQuote, quote) : "…"}</span>
          {isNew || change === null ? (
            <span className="text-[12px] text-amber">New</span>
          ) : (
            <span className="text-[12px]" style={{ color: change >= 0 ? UP_COLOR : DOWN_COLOR }}>
              {pct(change)}
            </span>
          )}
          <button
            onClick={(event) => {
              event.stopPropagation();
              quickBuy(coin);
            }}
            className="flex h-[26px] items-center gap-1 rounded-[7px] border border-[rgba(247,147,26,0.55)] bg-transparent px-[9px] text-[11.5px] font-medium text-amber hover:bg-[rgba(247,147,26,0.14)]"
            aria-label={`Quick buy ${coin.symbol}`}
          >
            <Icon name="bolt" size={11} />
            {qb}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 px-4 pt-[22px] pb-[18px]" data-screen-label="Discover">
      <div className="flex flex-wrap items-end justify-between gap-6 px-1">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[30px] leading-[1.1] font-medium tracking-[-0.03em]">{term ? `Results for “${term}”` : "Discover"}</h1>
          <p className="m-0 text-[13.5px] text-dim">
            {term ? (
              <Link href="/discover" className="text-amber hover:text-amber-pale">
                Clear the search
              </Link>
            ) : (
              "Every coin starts on the same curve. None can mint more supply or freeze holders."
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 whitespace-nowrap">
          <div className="seg">
            <button onClick={() => setQuoteFilter("all")} className={seg(quoteFilter === "all")}>
              All
            </button>
            {quotes.map((quote) => (
              <button key={quote.mint} onClick={() => setQuoteFilter(quote.mint)} className={seg(quoteFilter === quote.mint)}>
                {quote.symbol}
              </button>
            ))}
          </div>
          <button
            onClick={() => setSafe((value) => !value)}
            aria-pressed={safe}
            className={`flex h-8 items-center gap-[7px] rounded-[8px] border px-[11px] text-[12.5px] font-medium hover:bg-[rgba(245,241,232,0.06)] ${
              safe ? "border-text bg-[rgba(245,241,232,0.08)] text-text" : "border-[rgba(245,241,232,0.2)] text-mute"
            }`}
          >
            <span
              className={`grid h-3.5 w-3.5 place-items-center rounded-[4px] border-[1.5px] text-ground ${safe ? "border-text bg-text" : "border-[rgba(245,241,232,0.2)]"}`}
            >
              {safe && <Icon name="check" size={10} />}
            </span>
            Top 10 hold under 25%
          </button>
          <label className="flex h-8 cursor-text items-center gap-2 rounded-[8px] border border-[rgba(245,241,232,0.14)] px-2.5 text-[12.5px] text-dim">
            <Icon name="bolt" size={13} color="#F7931A" />
            Quick buy
            <input
              value={quick ? quick.toLocaleString("en-US") : ""}
              onChange={(event) => setQuick(parseInt(event.target.value.replace(/[^0-9]/g, ""), 10) || 0)}
              inputMode="numeric"
              aria-label={`Quick buy amount in ${unit === "usd" ? "dollars" : "sats"}`}
              className="tabular w-16 border-0 bg-transparent text-right text-[12.5px] font-medium text-text outline-none"
            />
            <span>{unit === "usd" ? "USD" : "sats"}</span>
          </label>
        </div>
      </div>

      {!term && (
        <div className="flex items-center gap-3.5 px-1 max-lg:flex-col max-lg:items-stretch">
          <span className="flex flex-none items-center gap-1.5 text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase">
            <Icon name="lock" size={13} color="#F7931A" />
            Just graduated
          </span>
          <div className="grid flex-1 grid-cols-5 gap-2 max-lg:grid-cols-2">
            {graduated.data && graduated.data.length === 0 && <span className="col-span-5 text-[12.5px] text-faint">No coin has graduated yet.</span>}
            {latest(graduated.data).map((coin) => {
              const quote = quoteOf(coin.quoteMint);
              return (
                <Link
                  key={coin.mint}
                  href={`/coin/${coin.mint}`}
                  className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] border border-line bg-panel px-2.5 py-2 hover:border-[rgba(247,147,26,0.5)]"
                >
                  <CoinImage coin={coin} size={32} radius={9} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-medium">{coin.symbol}</span>
                    <span className="truncate text-[11.5px] text-faint">Graduated {timeAgo(coin.graduatedAt ?? coin.createdAt, now)} ago</span>
                  </span>
                  <span className="tabular flex flex-col items-end gap-0.5">
                    <span className="text-[12.5px] font-medium">{quote ? money.big(coin.marketCapQuote, quote) : "…"}</span>
                    <span className="text-[11px] text-amber">Pool locked</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {term ? (
        <div className="grid grid-cols-3 items-start gap-3 max-lg:grid-cols-1">
          {results.loading && !results.data ? (
            <Skeleton className="h-40" />
          ) : resultList.filter(passes).length === 0 ? (
            <p className="card col-span-3 px-4 py-10 text-center text-[13px] text-faint">
              No coin matches “{term}”.{" "}
              <Link href="/create" className="text-amber">
                Launch one
              </Link>
              .
            </p>
          ) : (
            resultList.filter(passes).map((coin) => (
              <div key={coin.mint} className="card px-1.5 py-1">
                {renderRow(coin, coin.status === "trading" && coin.progressBps >= 5_000 ? "grad" : "new", holders.get(coin.mint))}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="grid grid-cols-3 items-start gap-3 max-lg:grid-cols-1">
          {column(
            "New",
            "Newest launches",
            UP_COLOR,
            newest.data ? `${launchedThisHour === 30 ? "30+" : launchedThisHour} this hour` : "",
            newList,
            "new",
            newest.loading && !newest.data,
            "No coin has launched yet.",
          )}
          {column("Trending", "Most traders in the last hour", "#F5F1E8", "", trendList, "trend", trending.loading && !trending.data, "Nothing has traded yet.")}
          {column("Graduating", "Closest to the target", "#F7931A", "", gradList, "grad", graduating.loading && !graduating.data, "No coin is on its curve yet.")}
        </div>
      )}

      {buying && quoteOf(buying.coin.quoteMint) && (
        <TradeDialog
          coin={buying.coin}
          quote={quoteOf(buying.coin.quoteMint)!}
          side="buy"
          amountIn={buying.amount}
          slippageBps={200}
          onClose={() => setBuying(null)}
        />
      )}
    </div>
  );
}
