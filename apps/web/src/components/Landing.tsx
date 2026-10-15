"use client";

/**
 * The landing page: the pitch, how the curve works, the safety rules, what
 * creators earn, settlement, and the risks. Every fee, cap and target on it is
 * read from the launchpad's live config, and the card in the hero is a real
 * coin trading right now.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { initialReserves } from "@archpad/sdk";
import { type CoinView, type QuoteAsset, type TradeRecord, api } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { quoteToGraduate, sinceLaunch } from "@/lib/coin.ts";
import { DOWN_COLOR, UP_COLOR, ident } from "@/lib/design-system.ts";
import { formatBps, formatDuration, pct, shortAddress, timeAgo } from "@/lib/format.ts";
import { btcText } from "@/lib/money.ts";
import { useLoaded, useNow, useStream } from "@/lib/hooks.ts";
import { Icon, Logo } from "./icons.tsx";
import { Bar, CoinImage } from "./ui.tsx";

const H2 = "m-0 text-[clamp(40px,4.6vw,64px)] leading-[1.02] font-medium tracking-[-0.042em] balance";
const KICKER = "text-[12.5px] font-medium tracking-[0.12em] uppercase";

function LiveCard() {
  const { network, quoteOf, money } = useApp();
  const now = useNow();
  const trending = useLoaded("landing:coin", () => api.coins({ sort: "trending", limit: 10 }), 30_000);
  const coin0 = (trending.data ?? []).find((coin) => coin.status === "trading") ?? null;
  const [coin, setCoin] = useState<CoinView | null>(null);
  const [trades, setTrades] = useState<(TradeRecord & { fresh?: boolean })[]>([]);
  const mint = coin0?.mint;

  useEffect(() => setCoin(coin0), [coin0]);
  useEffect(() => {
    setTrades([]);
    if (!mint) return;
    api.trades(mint, { limit: 5 }).then(setTrades).catch(() => undefined);
  }, [mint]);
  useStream(mint, (message) => {
    if (!mint) return;
    if (message.coin && message.coin.mint === mint) setCoin(message.coin);
    if (message.type === "trade" && message.trade.mint === mint) {
      setTrades((list) => [{ ...message.trade, fresh: true }, ...list.filter((t) => t.id !== message.trade.id)].slice(0, 5));
      window.setTimeout(() => setTrades((list) => list.map((t) => (t.id === message.trade.id ? { ...t, fresh: false } : t))), 200);
    }
  });

  const frame =
    "relative flex flex-col gap-4 rounded-[20px] border border-[rgba(245,241,232,0.1)] bg-panel p-5 text-[13px] leading-[1.4] shadow-[0_40px_100px_rgba(0,0,0,0.45)]";
  const chips = (
    <div className="flex flex-wrap gap-1.5">
      {["Mint authority: none", "Freeze authority: none", "Pool locked at graduation"].map((text) => (
        <span key={text} className="flex items-center gap-1.5 rounded-[7px] bg-[rgba(245,241,232,0.06)] px-[9px] py-[5px] text-[12px] text-soft">
          <Icon name="check" size={12} color={UP_COLOR} />
          {text}
        </span>
      ))}
    </div>
  );

  if (!coin) {
    return (
      <div className={frame}>
        <div className="flex flex-col gap-2 py-6">
          <span className="text-[16px] font-medium">{trending.data ? "No coin is on its curve yet." : "Loading the market…"}</span>
          <span className="text-[13px] text-faint">
            {trending.data ? "Launch the first one. It shows up here, live, the moment it trades." : "Live coins appear here as they trade."}
          </span>
        </div>
        {chips}
      </div>
    );
  }

  const quote = quoteOf(coin.quoteMint);
  const change = sinceLaunch(coin, network);
  const progress = Math.min(100, coin.progressBps / 100);
  return (
    <Link href={`/coin/${coin.mint}`} className={`${frame} hover:border-[rgba(247,147,26,0.4)]`}>
      <div className="flex items-center gap-3">
        <CoinImage coin={coin} size={48} radius={13} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[16px] font-medium">
            {coin.name} <span className="ml-1 text-[12px] text-dim">{coin.symbol}</span>
          </span>
          <span className="text-[12px] text-faint">
            by {shortAddress(coin.creator)} · {timeAgo(coin.createdAt, now)}
          </span>
        </span>
        <span className="tabular ml-auto flex flex-col items-end gap-0.5">
          <span className="text-[16px] font-medium">{quote ? money.big(coin.marketCapQuote, quote) : "…"}</span>
          {change !== null && <span className="text-[12px]" style={{ color: change >= 0 ? UP_COLOR : DOWN_COLOR }}>{pct(change)}</span>}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="tabular flex justify-between text-[12px] text-dim">
          <span>
            Bonding curve <span className="font-medium text-text">{progress.toFixed(1)}%</span>
          </span>
          <span className="text-amber">{quote ? `${money.fixed(quoteToGraduate(coin), quote)} to graduate` : ""}</span>
        </div>
        <Bar percent={progress} height={8} />
      </div>
      <div className="flex flex-col border-t border-[rgba(245,241,232,0.07)]">
        {trades.length === 0 && <div className="py-3 text-[12.5px] text-faint">No trades yet. The first one shows up here.</div>}
        {trades.map((trade) => {
          const buy = trade.side === "buy";
          return (
            <div
              key={trade.id}
              className="tabular grid h-[38px] grid-cols-[20px_minmax(0,1fr)_auto_36px] items-center gap-2.5 border-b border-[rgba(245,241,232,0.05)] px-1 text-[12.5px]"
              style={{
                background: trade.fresh ? (buy ? "rgba(102,222,142,0.1)" : "rgba(255,107,122,0.1)") : "transparent",
                transition: trade.fresh ? "none" : "background 1.4s ease",
              }}
            >
              <span className="h-[18px] w-[18px] rounded-full" style={{ background: ident(trade.trader) }} />
              <span className="truncate text-mute">
                {shortAddress(trade.trader)} <span style={{ color: buy ? UP_COLOR : DOWN_COLOR }}>{buy ? "bought" : "sold"}</span>
              </span>
              <span className="font-medium" style={{ color: buy ? UP_COLOR : DOWN_COLOR }}>
                {quote ? money.size(trade.quoteAmount, quote) : ""}
              </span>
              <span className="text-right text-faint">{timeAgo(trade.timestamp, now)}</span>
            </div>
          );
        })}
      </div>
      {chips}
    </Link>
  );
}

/** The price along the curve as the quote raised goes from nothing to the target. */
function useCurve(quote: QuoteAsset | undefined) {
  const { network } = useApp();
  const launch = network?.launch;
  return useMemo(() => {
    if (!launch || !quote) return null;
    try {
      const reserves = initialReserves({
        totalSupply: BigInt(launch.totalSupply),
        curveSupply: BigInt(launch.curveSupply),
        virtualTokenReserves: BigInt(launch.virtualTokenReserves),
        virtualQuoteReserves: BigInt(quote.virtualQuoteReserves),
      });
      const q0 = Number(reserves.virtualQuote);
      const k = q0 * Number(reserves.virtualToken);
      const target = Number(quote.graduationQuote);
      const priceAt = (p: number) => {
        const q = q0 + target * p;
        return q / (k / q);
      };
      return { priceAt, target };
    } catch {
      return null;
    }
  }, [launch, quote]);
}

function CurveDiagram({ quote }: { quote: QuoteAsset | undefined }) {
  const curve = useCurve(quote);
  if (!curve || !quote) return <div className="h-[300px]" />;
  const ymax = curve.priceAt(1) * 1.08;
  const X = (q: number) => 40 + q * 1120;
  const Y = (price: number) => 276 - (price / ymax) * 246;
  let d = "";
  for (let i = 0; i <= 60; i++) {
    const q = i / 60;
    d += `${i ? "L" : "M"}${X(q).toFixed(1)} ${Y(curve.priceAt(q)).toFixed(1)}`;
  }
  const marks = [
    [0, "01"],
    [0.5, "02"],
    [1, "03"],
  ] as const;
  const target = /btc/i.test(quote.symbol) && quote.decimals === 8 ? btcText(curve.target, 2) : `$${(curve.target / 10 ** quote.decimals).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return (
    <div className="relative h-[300px]">
      <svg viewBox="0 0 1200 300" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
        <defs>
          <linearGradient id="lpFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#F7931A" stopOpacity="0.22" />
            <stop offset="1" stopColor="#F7931A" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${d}L1160 276L40 276Z`} fill="url(#lpFill)" />
        <path d={d} fill="none" stroke="#F7931A" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        <path d="M40 276H1160" fill="none" stroke="rgba(245,241,232,0.16)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      {marks.map(([q, n]) => (
        <span
          key={n}
          className="absolute grid h-[34px] w-[34px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-[1.5px] border-orange bg-ground text-[13px] font-medium"
          style={{ left: `${((X(q) / 1200) * 100).toFixed(2)}%`, top: `${((Y(curve.priceAt(q)) / 300) * 100).toFixed(2)}%` }}
        >
          {n}
        </span>
      ))}
      <span className="absolute -bottom-7 left-[3.3%] text-[12px] text-faint">Launch</span>
      <span className="tabular absolute right-[3.3%] -bottom-7 text-[12px] text-faint">Target, {target} raised</span>
    </div>
  );
}

function Earnings() {
  const { network } = useApp();
  const launch = network?.launch;
  const [vol, setVol] = useState(100_000);
  const creator = (launch?.creatorFeeBps ?? 0) / 10_000;
  const platform = (launch?.platformFeeBps ?? 0) / 10_000;
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  return (
    <div className="flex flex-col gap-[22px] rounded-[20px] border border-[rgba(245,241,232,0.1)] bg-panel p-7">
      <div className="tabular flex items-baseline justify-between">
        <span className="text-[14px] text-dim">If your coin trades</span>
        <span className="text-[22px] font-medium tracking-[-0.02em]">{usd(vol)}</span>
      </div>
      <input
        type="range"
        min={10_000}
        max={1_000_000}
        step={10_000}
        value={vol}
        onChange={(event) => setVol(Number(event.target.value))}
        aria-label="Trading volume on the curve, in dollars"
        className="w-full"
      />
      <div className="flex flex-col gap-1 pt-1.5">
        <span className="text-[14px] text-dim">on its curve, you earn</span>
        <span className="tabular text-[clamp(48px,5vw,72px)] leading-none font-medium tracking-[-0.045em] text-orange">{usd(vol * creator)}</span>
      </div>
      <div className="tabular grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-[3px] rounded-[12px] bg-deep px-3.5 py-3">
          <span className="text-[12.5px] text-faint">Traders pay in fees, {launch ? formatBps(launch.platformFeeBps + launch.creatorFeeBps) : "…"}</span>
          <span className="text-[17px] font-medium">{usd(vol * (creator + platform))}</span>
        </div>
        <div className="flex flex-col gap-[3px] rounded-[12px] bg-deep px-3.5 py-3">
          <span className="text-[12.5px] text-faint">SARCH keeps, {launch ? formatBps(launch.platformFeeBps) : "…"}</span>
          <span className="text-[17px] font-medium">{usd(vol * platform)}</span>
        </div>
      </div>
    </div>
  );
}

export function Landing() {
  const { network } = useApp();
  const launch = network?.launch;
  const quotes = network?.quotes ?? [];
  const btc = quotes.find((quote) => /btc/i.test(quote.symbol) && quote.decimals === 8) ?? quotes[0];

  const creatorPct = launch ? formatBps(launch.creatorFeeBps) : "1.25%";
  const feePct = launch ? formatBps(launch.platformFeeBps + launch.creatorFeeBps) : "2.25%";
  const minBuy = launch ? formatBps(launch.minCreatorBuyBps) : "0.5%";
  const cap = launch ? formatBps(launch.earlyWalletCapBps) : "2%";
  const windowText = launch ? formatDuration(launch.earlyWindowSecs) : "10 seconds";

  const fair: [string, string, string][] = [
    ["01", "No hidden supply.", "Mint and freeze authority are set to none in the same transaction that creates the coin."],
    ["02", "No pulled pools.", "At graduation the starting liquidity is locked, so nobody can withdraw it."],
    ["03", "No exemptions.", `Every trade pays the same ${feePct} through one code path, including the creator's first buy.`],
    ["04", "No first-block sweep.", `For the first ${windowText}, one wallet can buy at most ${cap} of the curve.`],
    ["05", "No custody.", "SARCH never holds your keys or funds. You sign every transaction in your own wallet."],
  ];

  const navLink = "text-mute hover:text-text";
  const primary = "btn-primary h-[52px] rounded-[12px] px-6 text-[16px]";
  const secondary = "inline-flex h-[52px] items-center rounded-[12px] border border-[rgba(245,241,232,0.24)] px-6 text-[16px] font-medium text-text hover:bg-[rgba(245,241,232,0.06)]";

  return (
    <div className="flex flex-col overflow-hidden bg-ground text-[15px] leading-[1.55] text-text" data-screen-label="Landing">
      <header className="mx-auto box-border flex w-full max-w-[1280px] items-center gap-8 px-10 py-[22px] max-md:px-4">
        <span className="flex items-center gap-[11px]">
          <Logo size={24} />
          <span className="text-[17px] font-medium tracking-[0.16em]">SARCH</span>
        </span>
        <nav className="flex gap-7 text-[14px] max-md:hidden" aria-label="Sections">
          <a href="#how" className={navLink}>How it works</a>
          <a href="#safety" className={navLink}>Safety</a>
          <a href="#creators" className={navLink}>Creators</a>
          <a href="#risks" className={navLink}>Risks</a>
        </nav>
        <Link href="/discover" className="btn-primary ml-auto h-10 rounded-[10px] px-[18px] text-[14px]">
          Open app
        </Link>
      </header>

      <section className="relative mx-auto box-border grid w-full max-w-[1280px] grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] items-center gap-16 px-10 pt-16 pb-[104px] max-lg:grid-cols-1 max-md:px-4">
        <div className="pointer-events-none absolute -top-[120px] -right-[180px] h-[720px] w-[720px] rounded-full bg-[radial-gradient(closest-side,rgba(247,147,26,0.16),rgba(247,147,26,0)_70%)]" />
        <div className="relative flex flex-col gap-7">
          <span className={`flex items-center gap-2 text-dim ${KICKER}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-orange" />
            Meme coin launchpad · Built on Arch
          </span>
          <h1 className="balance m-0 text-[clamp(56px,7vw,100px)] leading-[0.98] font-medium tracking-[-0.048em]">
            Launch a coin <span className="text-orange">on Bitcoin</span> in one step.
          </h1>
          <p className="pretty m-0 max-w-[540px] text-[19px] leading-[1.55] text-mute">
            Every coin starts on a fair bonding curve, pays its creator {creatorPct} of every trade, and graduates to a locked pool on Arch Swap.
            Trades are final in about 0.3 seconds.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/create" className={primary}>Launch a coin</Link>
            <Link href="/discover" className={secondary}>Explore coins</Link>
            <span className="text-[13.5px] text-faint">Free to create. You pay only for your first buy.</span>
          </div>
        </div>
        <LiveCard />
      </section>

      <section className="bg-text text-ground">
        <div className="mx-auto box-border grid max-w-[1280px] grid-cols-4 gap-10 px-10 py-14 max-lg:grid-cols-2 max-md:px-4">
          {[
            ["Free", "to create a coin. Your only cost is your first buy."],
            [creatorPct, "of every curve trade goes to the coin's creator."],
            ["0.3s", "block finality on Arch, with settlement on Bitcoin."],
            ["Locked", "starting liquidity when a coin graduates to Arch Swap."],
          ].map(([big, line]) => (
            <div key={line} className="flex flex-col gap-2.5">
              <span className="text-[clamp(40px,4.4vw,60px)] leading-none font-medium tracking-[-0.045em]">{big}</span>
              <span className="pretty text-[15px] leading-[1.5] text-ink">{line}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="mx-auto box-border flex w-full max-w-[1280px] flex-col gap-12 px-10 pt-[120px] pb-28 max-md:px-4">
        <div className="flex max-w-[760px] flex-col gap-4">
          <span className={`text-orange ${KICKER}`}>How it works</span>
          <h2 className={H2}>Every coin follows the same curve, from launch to pool.</h2>
        </div>
        <CurveDiagram quote={btc} />
        <div className="grid grid-cols-3 gap-10 pt-6 max-lg:grid-cols-1">
          {[
            ["01", "Launch", `Name, ticker, image and a line about your coin. Your first buy, at least ${minBuy} of the curve, goes in the same transaction.`],
            ["02", "Trade on the curve", "The price rises with every buy and falls with every sell. Before you sign, you see the price, price impact, fee and the minimum you will receive."],
            ["03", "Graduate", "At the target, reserves and the remaining supply move into a new Arch Swap pool and the starting liquidity is locked. No fee and no manual step."],
          ].map(([n, title, text]) => (
            <div key={n} className="flex flex-col gap-2.5">
              <span className="text-[13px] font-medium text-orange">{n}</span>
              <h3 className="m-0 text-[24px] font-medium tracking-[-0.02em]">{title}</h3>
              <p className="pretty m-0 text-[16px] leading-[1.55] text-mute">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="safety" className="bg-text text-ground">
        <div className="mx-auto box-border grid max-w-[1280px] grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-[72px] px-10 py-[120px] max-lg:grid-cols-1 max-md:px-4">
          <div className="flex flex-col gap-[18px]">
            <span className={`text-ink ${KICKER}`}>Safety</span>
            <h2 className={H2}>Fair by code, not by promise.</h2>
            <p className="pretty m-0 max-w-[420px] text-[17px] leading-[1.55] text-ink">
              The rules live in the launch program. Once a coin exists, nobody can change them for it, including us.
            </p>
          </div>
          <div className="flex flex-col">
            {fair.map(([n, lead, line]) => (
              <div key={n} className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 border-t border-[rgba(11,43,34,0.14)] py-[26px]">
                <span className="tabular pt-1 text-[13px] font-medium text-ink">{n}</span>
                <span className="flex flex-col gap-1.5">
                  <span className="text-[18px] text-ink">{lead}</span>
                  <span className="pretty text-[clamp(22px,2.1vw,28px)] leading-[1.2] font-medium tracking-[-0.025em]">{line}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="creators" className="mx-auto box-border grid w-full max-w-[1280px] grid-cols-2 items-center gap-[72px] px-10 py-[120px] max-lg:grid-cols-1 max-md:px-4">
        <div className="flex flex-col gap-[18px]">
          <span className={`text-orange ${KICKER}`}>For creators</span>
          <h2 className={H2}>Earn {creatorPct} of every trade on your coin.</h2>
          <p className="pretty m-0 max-w-[480px] text-[17px] leading-[1.55] text-mute">
            Creating a coin is free. Earnings build up per coin, in the coin's quote asset, and you can claim them whenever you like.
          </p>
        </div>
        <Earnings />
      </section>

      <section className="mx-auto box-border flex w-full max-w-[1280px] flex-col gap-11 px-10 pt-10 pb-[120px] max-md:px-4">
        <div className="grid grid-cols-2 items-end gap-[72px] max-lg:grid-cols-1 max-lg:gap-6">
          <h2 className={H2}>
            Final on Arch. <span className="text-orange">Settled on Bitcoin.</span>
          </h2>
          <p className="pretty m-0 text-[17px] leading-[1.55] text-mute">
            Trades confirm on Arch in about 0.3 seconds, so prices move as fast as people trade. Arch settles to Bitcoin, and every coin is priced in
            BTC or a dollar asset, never in a launchpad token.
          </p>
        </div>
        <div className="flex flex-col gap-[18px] rounded-[20px] border border-[rgba(245,241,232,0.1)] p-7">
          <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-5">
            <span className="flex flex-col gap-0.5">
              <span className="text-[14px] font-medium">Arch</span>
              <span className="text-[12px] text-faint">a block every 0.3s</span>
            </span>
            <div className="relative flex h-[30px] gap-1">
              {Array.from({ length: 48 }, (_, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-[3px]"
                  style={{ background: i === 30 ? "#F7931A" : i < 30 ? "rgba(245,241,232,0.24)" : "rgba(245,241,232,0.08)" }}
                />
              ))}
              <span className="absolute bottom-[calc(100%+8px)] left-[62%] -translate-x-[30%] text-[12px] whitespace-nowrap text-amber">Your trade is final here</span>
            </div>
          </div>
          <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-5">
            <span className="flex flex-col gap-0.5">
              <span className="text-[14px] font-medium">Bitcoin</span>
              <span className="text-[12px] text-faint">settlement</span>
            </span>
            <div className="grid h-[30px] grid-cols-3 gap-1">
              <span className="rounded-[3px] bg-[rgba(245,241,232,0.1)]" />
              <span className="rounded-[3px] border border-[rgba(247,147,26,0.7)] bg-[rgba(247,147,26,0.22)]" />
              <span className="rounded-[3px] border border-dashed border-[rgba(245,241,232,0.2)] bg-[rgba(245,241,232,0.06)]" />
            </div>
          </div>
          <span className="self-end text-[12px] text-faint">Diagram not to scale</span>
        </div>
      </section>

      <section className="mx-auto box-border w-full max-w-[1280px] px-10 pb-[120px] max-md:px-4">
        <div className="relative flex flex-wrap items-end justify-between gap-10 overflow-hidden rounded-[24px] border border-[rgba(245,241,232,0.1)] bg-[radial-gradient(120%_140%_at_100%_100%,rgba(247,147,26,0.22),rgba(247,147,26,0.04)_55%,transparent_80%),#0F342A] px-14 py-16 max-md:px-6">
          <h2 className="balance m-0 max-w-[720px] text-[clamp(40px,4.8vw,68px)] leading-[1.02] font-medium tracking-[-0.045em]">
            Your coin, priced in bitcoin, live in one transaction.
          </h2>
          <div className="flex gap-3">
            <Link href="/create" className={primary}>Launch a coin</Link>
            <Link href="/discover" className={secondary}>Explore coins</Link>
          </div>
        </div>
      </section>

      <section id="risks" className="mx-auto box-border grid w-full max-w-[1280px] grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-[72px] px-10 pb-24 max-lg:grid-cols-1 max-lg:gap-8 max-md:px-4">
        <h2 className="m-0 text-[32px] leading-[1.1] font-medium tracking-[-0.03em]">Before you trade</h2>
        <div className="grid grid-cols-2 gap-x-10 gap-y-8 max-md:grid-cols-1">
          {[
            ["Meme coins can go to zero.", "Prices move with every trade and most coins never graduate. Only trade what you can afford to lose."],
            ["You keep your keys.", "SARCH never holds your keys or funds. If the site goes down, your coins stay safe on chain."],
            ["Not available everywhere.", "SARCH is blocked in some countries and regions, and screens wallets against sanctions lists."],
            ["Not advice.", "Nothing on this site is investment, legal or tax advice, or an offer to buy or sell any asset."],
          ].map(([lead, text]) => (
            <p key={lead} className="pretty m-0 text-[15px] leading-[1.6] text-dim">
              <span className="font-medium text-text">{lead}</span> {text}
            </p>
          ))}
        </div>
      </section>

      <footer className="mx-auto box-border flex w-full max-w-[1280px] flex-col gap-9 border-t border-line px-10 pt-11 max-md:px-4">
        <div className="flex flex-wrap items-center gap-7 text-[14px] text-dim">
          <Link href="/discover" className="text-mute hover:text-text">Discover</Link>
          <Link href="/create" className="text-mute hover:text-text">Launch</Link>
          <a href="#risks" className="text-mute hover:text-text">Risk warning</a>
          <span className="ml-auto text-faint">© {new Date().getFullYear()} SARCH · Built on Arch</span>
        </div>
        <div className="-mb-[3.2vw] flex items-end gap-[2.4vw] leading-[0.8]" aria-hidden="true">
          <Logo className="mb-[3.6vw] h-auto w-[13vw] max-w-[170px] flex-none" />
          <span className="text-[min(19vw,250px)] font-medium tracking-[-0.02em] text-raised">SARCH</span>
        </div>
      </footer>
    </div>
  );
}
