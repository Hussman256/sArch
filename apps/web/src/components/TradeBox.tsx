"use client";

/**
 * Buying and selling a coin. Shows, before anything is signed, what the trade
 * returns, what it costs, how far it moves the price, the least it will
 * accept, and where it leaves the curve.
 */
import { useEffect, useMemo, useState } from "react";
import type { Position } from "@archpad/sdk";
import type { CoinView, QuoteAsset } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { DOWN_COLOR, UP_COLOR } from "@/lib/design-system.ts";
import { formatBps, formatDuration, formatTokens, formatUnits, parseUnits } from "@/lib/format.ts";
import { useBalances, useNow } from "@/lib/hooks.ts";
import { assetKind } from "@/lib/money.ts";
import { type Market, type Side, maxUsefulBuy, previewTrade } from "@/lib/quote.ts";
import { Icon } from "./icons.tsx";
import { useWalletPicker } from "./Shell.tsx";

const SLIPPAGE = [50, 100, 200, 500];

export interface TradeRequest {
  side: Side;
  amountIn: bigint;
  slippageBps: number;
}

export function TradeBox({
  coin,
  quote,
  market,
  position,
  busy,
  onTrade,
}: {
  coin: CoinView;
  quote: QuoteAsset;
  /** The coin's curve and pool as last read from the chain. Null while loading. */
  market: Market | null;
  /** The connected wallet's launch-window record for this coin, if it has one. */
  position: Position | null;
  busy: boolean;
  onTrade: (request: TradeRequest) => void;
}) {
  const { wallet, money } = useApp();
  const openPicker = useWalletPicker();
  const now = useNow();
  const [side, setSide] = useState<Side>("buy");
  const [text, setText] = useState("");
  const [slip, setSlip] = useState(200);
  const { balances } = useBalances([coin.quoteMint, coin.mint]);

  const kind = assetKind(quote);
  // Bitcoin is typed in sats, dollars in dollars, tokens in whole tokens.
  const quoteInputDecimals = kind === "btc" ? 0 : quote.decimals;
  const buy = side === "buy";
  const inputDecimals = buy ? quoteInputDecimals : coin.tokenDecimals;
  // A sat is the base unit of an 8-decimal bitcoin asset, so sats typed are base units.
  const amountIn = parseUnits(text, inputDecimals);
  const unitLabel = buy ? (kind === "btc" ? "sats" : kind === "usd" ? "USD" : quote.symbol) : coin.symbol;

  const quoteBalance = balances.get(coin.quoteMint) ?? 0n;
  const tokenBalance = balances.get(coin.mint) ?? 0n;
  const balance = buy ? quoteBalance : tokenBalance;

  const windowOpen = market !== null && !market.pool && BigInt(now) < market.curve.earlyWindowEnd;
  const allowance = useMemo(() => {
    if (!windowOpen || !market) return undefined;
    const used = position?.windowBought ?? 0n;
    return used >= market.curve.earlyWalletCap ? 0n : market.curve.earlyWalletCap - used;
  }, [windowOpen, market, position]);

  const result = useMemo(() => {
    if (!market || text.trim() === "") return null;
    if (amountIn === null) return { ok: false as const, reason: "Enter a plain number." };
    return previewTrade(market, side, amountIn, slip, buy ? allowance : undefined);
  }, [market, side, text, amountIn, slip, allowance, buy]);
  const preview = result?.ok ? result.preview : null;

  useEffect(() => setText(""), [side]);

  const toText = (amount: bigint, decimals: number) => (amount === 0n ? "" : formatUnits(amount, decimals).replace(/,/g, ""));

  const presets: { label: string; on: boolean; pick: () => void }[] = buy
    ? (kind === "usd" ? [10n, 50n, 100n, 500n] : [10_000n, 50_000n, 100_000n, 500_000n]).map((value) => {
        const base = kind === "usd" ? value * 10n ** BigInt(quote.decimals) : value;
        return {
          label: kind === "usd" ? `$${value}` : `${Number(value) / 1000}K`,
          on: amountIn === base,
          pick: () => setText(toText(base, quoteInputDecimals)),
        };
      })
    : [25n, 50n, 75n, 100n].map((percent) => {
        const amount = (tokenBalance * percent) / 100n;
        return {
          label: percent === 100n ? "Max" : `${percent}%`,
          on: amountIn !== null && amountIn > 0n && amountIn === amount,
          pick: () => setText(toText(amount, coin.tokenDecimals)),
        };
      });

  // What it takes to buy every token left on the curve, once the launch window is over.
  const fillNeed = buy && market && !market.pool && !windowOpen ? maxUsefulBuy(market.curve) : 0n;
  const showFill = wallet !== null && fillNeed > 0n && fillNeed <= quoteBalance && amountIn !== fillNeed;

  const color = buy ? UP_COLOR : DOWN_COLOR;
  const impact = preview ? preview.priceImpactBps / 100 : 0;
  const tokensText = (amount: bigint) => `${formatTokens(amount, coin.tokenDecimals)} ${coin.symbol}`;
  const quoteText = (amount: bigint) => money.size(amount, quote);
  const feeBps = market?.pool ? coin.poolFeeBps : coin.platformFeeBps + coin.creatorFeeBps;

  let average: string | null = null;
  if (preview) {
    const quoteSide = buy ? preview.charged - preview.fee : preview.amountOut + preview.fee;
    const tokenSide = buy ? preview.amountOut : preview.amountIn;
    if (tokenSide > 0n) average = money.px(Number(quoteSide) / Number(tokenSide), coin.tokenDecimals, quote);
  }
  let curveAfter: string | null = null;
  if (preview && market && !market.pool) {
    const supply = market.curve.curveSupply;
    const before = Number(((supply - market.curve.realToken) * 10_000n) / supply) / 100;
    const left = buy ? market.curve.realToken - preview.amountOut : market.curve.realToken + preview.amountIn;
    const after = Number(((supply - left) * 10_000n) / supply) / 100;
    curveAfter = `${before.toFixed(1)}% → ${preview.graduates ? "graduates" : `${after.toFixed(1)}%`}`;
  }

  let blocked: string | null = null;
  if (!market) blocked = "Loading…";
  else if (result && !result.ok) blocked = result.reason;
  else if (wallet && amountIn !== null && amountIn > balance) blocked = `Not enough ${buy ? quote.symbol : coin.symbol}`;
  else if (!preview) blocked = "Enter an amount";
  const cta = !wallet ? "Connect a wallet to trade" : busy ? "Waiting for your wallet…" : (blocked ?? `${buy ? "Buy" : "Sell"} ${coin.symbol}`);
  const disabled = wallet !== null && (busy || blocked !== null);

  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-3.5 text-[13px]" aria-label="Trade">
      <div className="grid grid-cols-2 gap-1 rounded-[10px] bg-deep p-[3px]" role="tablist">
        {(["buy", "sell"] as const).map((option) => (
          <button
            key={option}
            role="tab"
            aria-selected={side === option}
            onClick={() => setSide(option)}
            className="h-[34px] rounded-[8px] text-[13.5px] font-medium capitalize"
            style={
              side === option
                ? { background: option === "buy" ? "rgba(102,222,142,0.14)" : "rgba(255,107,122,0.14)", color: option === "buy" ? UP_COLOR : DOWN_COLOR }
                : { color: "#A3ACA3" }
            }
          >
            {option}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between text-[12px] whitespace-nowrap text-dim">
        <span>{buy ? "You pay" : "You sell"}</span>
        <div className="flex items-center gap-2.5">
          {wallet && (
            <span>
              Balance <span className="tabular text-soft">{buy ? money.size(quoteBalance, quote) : tokensText(tokenBalance)}</span>
            </span>
          )}
          <button
            onClick={() => setSlip((value) => SLIPPAGE[(SLIPPAGE.indexOf(value) + 1) % SLIPPAGE.length]!)}
            title="Slippage limit. The trade fails if the price moves more than this."
            className="flex h-6 items-center gap-[5px] rounded-[6px] border border-[rgba(245,241,232,0.14)] px-[7px] text-[11.5px] text-mute hover:bg-[rgba(245,241,232,0.06)]"
          >
            <Icon name="sliders" size={12} />
            Slippage {formatBps(slip)}
          </button>
        </div>
      </div>

      <label className="flex h-14 cursor-text items-center gap-2.5 rounded-[10px] border border-[rgba(245,241,232,0.12)] bg-deep pr-2.5 pl-3.5 focus-within:border-[rgba(247,147,26,0.6)]">
        <input
          value={text}
          onChange={(event) => setText(event.target.value.replace(/[^0-9.,]/g, ""))}
          inputMode="decimal"
          placeholder="0"
          aria-label={buy ? `Amount to pay, in ${unitLabel}` : `Amount of ${coin.symbol} to sell`}
          className="tabular min-w-0 flex-1 border-0 bg-transparent text-[24px] font-medium tracking-[-0.015em] text-text outline-none"
        />
        <span className="rounded-[7px] bg-[rgba(245,241,232,0.07)] px-[9px] py-[5px] text-[12px] font-medium text-mute">{unitLabel}</span>
      </label>

      <div className="grid grid-cols-4 gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.label}
            onClick={preset.pick}
            className="tabular h-[30px] rounded-[8px] border text-[12px] font-medium hover:bg-[rgba(245,241,232,0.06)]"
            style={{
              borderColor: preset.on ? color : "rgba(245,241,232,0.14)",
              background: preset.on ? (buy ? "rgba(102,222,142,0.1)" : "rgba(255,107,122,0.1)") : "transparent",
              color: preset.on ? color : "#B9BFB4",
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {showFill && (
        <button
          onClick={() => setText(toText(fillNeed, quoteInputDecimals))}
          className="tabular -mt-1 flex items-center gap-1.5 self-start py-0.5 text-[12px] text-amber hover:text-amber-pale"
        >
          <Icon name="grad" size={13} />
          Fill the curve · {quoteText(fillNeed)}
        </button>
      )}

      {windowOpen && market && buy && (
        <div className="rounded-[8px] bg-[rgba(247,147,26,0.12)] px-2.5 py-[9px] text-[12px] leading-[1.45] text-amber-pale">
          Launch window: for the next {formatDuration(Math.max(1, Number(market.curve.earlyWindowEnd) - now))} each wallet can buy at most{" "}
          {tokensText(market.curve.earlyWalletCap)}
          {allowance !== undefined && position ? ` (you have ${tokensText(allowance)} left)` : ""}.
        </div>
      )}

      <div className="rule-top tabular flex flex-col gap-2 px-0.5 pt-3 pb-0.5 text-[12.5px] whitespace-nowrap">
        <Row label="You receive">
          <span className="font-medium">{preview ? (buy ? tokensText(preview.amountOut) : quoteText(preview.amountOut)) : "–"}</span>
        </Row>
        <Row label="Average price">{average ?? "–"}</Row>
        <Row label="Price impact">
          <span style={{ color: !preview ? undefined : impact < 1 ? "#D5D7CB" : impact < 5 ? "#F2C46D" : DOWN_COLOR }}>
            {preview ? `${buy ? "+" : "−"}${impact.toFixed(2)}%` : "–"}
          </span>
        </Row>
        <div className="flex flex-col gap-[3px]">
          <Row label={`Fee ${formatBps(feeBps)}`}>{preview ? quoteText(preview.fee) : "–"}</Row>
          {preview && (
            <div className="self-end text-[11.5px] text-faint">
              Creator {quoteText(preview.fees.creator)} · SARCH {quoteText(preview.fees.platform)}
              {preview.fees.lp > 0n && <> · Pool {quoteText(preview.fees.lp)}</>}
            </div>
          )}
        </div>
        <Row label="Minimum received">{preview ? (buy ? tokensText(preview.minOut) : quoteText(preview.minOut)) : "–"}</Row>
        {market && !market.pool ? <Row label="Curve after trade">{curveAfter ?? "–"}</Row> : <Row label="Venue">Arch Swap pool</Row>}
      </div>

      {preview?.graduates && (
        <div className="flex gap-2 rounded-[8px] bg-[rgba(247,147,26,0.12)] px-2.5 py-[9px] text-[12px] leading-[1.45] text-amber-pale">
          <Icon name="info" size={15} className="mt-px flex-none" />
          <span>This buy fills the curve. Graduation runs in the same transaction, with no extra fee.</span>
        </div>
      )}

      <button
        onClick={() => {
          if (!wallet) return openPicker();
          if (!disabled && amountIn !== null) onTrade({ side, amountIn, slippageBps: slip });
        }}
        disabled={disabled}
        className="h-11 rounded-[10px] border text-[14px] font-medium text-ground hover:brightness-[1.08] active:brightness-[0.92] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
        style={{ background: buy ? "#F7931A" : DOWN_COLOR, borderColor: buy ? "#F7931A" : DOWN_COLOR }}
      >
        {cta}
      </button>
      <div className="flex items-center justify-center gap-1.5 text-[11.5px] text-faint">
        <Icon name="boltOutline" size={12} />
        You sign in your wallet. Final on Arch in about 0.3s.
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-dim">{label}</span>
      <span>{children}</span>
    </div>
  );
}
