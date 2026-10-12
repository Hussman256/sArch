"use client";

/**
 * Buying and selling a coin. Shows, before anything is signed, what the trade
 * returns, what it costs, how far it moves the price and the least it will
 * accept, then sends it with that limit attached.
 */
import { useEffect, useMemo, useState } from "react";
import type { Position } from "@archpad/sdk";
import type { CoinView, QuoteAsset } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { formatBps, formatDuration, formatQuote, formatTokens, formatUnits, parseUnits } from "@/lib/format.ts";
import { useBalances, useNow } from "@/lib/hooks.ts";
import { type Market, type Side, maxUsefulBuy, previewTrade } from "@/lib/quote.ts";

const SLIPPAGE_CHOICES = [50, 100, 300];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="text-dim" title={hint}>
        {label}
      </dt>
      <dd className="tabular text-right">{children}</dd>
    </div>
  );
}

export function TradeBox({
  coin,
  quote,
  market,
  position,
  onTraded,
}: {
  coin: CoinView;
  quote: QuoteAsset;
  /** The coin's curve and pool as last read from the chain. Null while loading. */
  market: Market | null;
  /** The connected wallet's launch-window record for this coin, if it has one. */
  position: Position | null;
  onTraded: () => void;
}) {
  const { wallet, client, send } = useApp();
  const now = useNow();
  const [side, setSide] = useState<Side>("buy");
  const [text, setText] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [customSlippage, setCustomSlippage] = useState("");
  const [busy, setBusy] = useState(false);
  const { balances } = useBalances([coin.quoteMint, coin.mint]);

  const quoteBalance = balances.get(coin.quoteMint) ?? 0n;
  const tokenBalance = balances.get(coin.mint) ?? 0n;
  const inputDecimals = side === "buy" ? quote.decimals : coin.tokenDecimals;
  const amountIn = parseUnits(text, inputDecimals);

  // While the launch window is open each wallet has a limited allowance.
  const windowOpen = market !== null && !market.pool && BigInt(now) < market.curve.earlyWindowEnd;
  const windowAllowance = useMemo(() => {
    if (!windowOpen || !market) return undefined;
    const used = position?.windowBought ?? 0n;
    return used >= market.curve.earlyWalletCap ? 0n : market.curve.earlyWalletCap - used;
  }, [windowOpen, market, position]);

  const result = useMemo(() => {
    if (!market) return null;
    if (text.trim() === "") return null;
    if (amountIn === null) return { ok: false as const, reason: `Enter a number with at most ${inputDecimals} decimals.` };
    return previewTrade(market, side, amountIn, slippageBps, side === "buy" ? windowAllowance : undefined);
  }, [market, side, text, amountIn, slippageBps, windowAllowance, inputDecimals]);

  // Clear the box when switching between buying and selling: the unit changes.
  useEffect(() => setText(""), [side]);

  const balance = side === "buy" ? quoteBalance : tokenBalance;
  const shortOfFunds = wallet !== null && amountIn !== null && amountIn > balance;

  const fill = (fraction: bigint) => {
    if (!market) return;
    let amount = (balance * fraction) / 100n;
    if (side === "buy" && !market.pool) {
      // No point offering more than the curve can sell this wallet.
      const useful = maxUsefulBuy(market.curve, windowAllowance);
      if (amount > useful) amount = useful;
    }
    setText(amount === 0n ? "" : formatUnits(amount, inputDecimals).replace(/,/g, ""));
  };

  const submit = async () => {
    if (!wallet || !client || !market || !result?.ok || amountIn === null) return;
    setBusy(true);
    try {
      // Plan against the freshest state there is. The slippage limit still
      // guards against anything that lands in between.
      const latest = await client.getCoin(coin.mint);
      if (!latest) return;
      const plan = latest.pool
        ? client.planPoolSwap(wallet.address, latest.pool, side === "buy", amountIn, slippageBps)
        : side === "buy"
          ? client.planCurveBuy(wallet.address, latest.curve, amountIn, slippageBps)
          : client.planCurveSell(wallet.address, latest.curve, amountIn, slippageBps);
      const symbol = coin.symbol || "tokens";
      const processed = await send(plan.instructions, {
        doing: side === "buy" ? `Buying ${symbol}.` : `Selling ${symbol}.`,
        done: side === "buy" ? `Bought ${symbol}.` : `Sold ${symbol}.`,
      });
      if (processed) {
        setText("");
        onTraded();
      }
    } finally {
      setBusy(false);
    }
  };

  const preview = result?.ok ? result.preview : null;
  const outAsset = side === "buy" ? coin.symbol || "tokens" : quote.symbol;
  const formatOut = (amount: bigint) =>
    side === "buy" ? `${formatUnits(amount, coin.tokenDecimals, 2)} ${outAsset}` : formatQuote(amount, quote);

  let action = side === "buy" ? `Buy ${coin.symbol}` : `Sell ${coin.symbol}`;
  let blocked: string | null = null;
  if (!wallet) blocked = "Connect a wallet to trade";
  else if (!market) blocked = "Loading…";
  else if (result && !result.ok) blocked = result.reason;
  else if (shortOfFunds) blocked = `Not enough ${side === "buy" ? quote.symbol : coin.symbol}`;
  if (busy) action = "Waiting for your wallet…";

  return (
    <section className="panel p-4" aria-label="Trade">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-ink p-1" role="tablist">
        {(["buy", "sell"] as const).map((option) => (
          <button
            key={option}
            role="tab"
            aria-selected={side === option}
            onClick={() => setSide(option)}
            className={`rounded-md py-2 text-sm font-semibold capitalize ${
              side === option ? (option === "buy" ? "bg-up text-ink" : "bg-down text-ink") : "text-dim hover:text-text"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <label className="label" htmlFor="trade-amount">
            {side === "buy" ? `You pay (${quote.symbol})` : `You sell (${coin.symbol})`}
          </label>
          {wallet && (
            <span className="tabular text-xs text-dim">
              Balance:{" "}
              {side === "buy" ? formatQuote(quoteBalance, quote) : `${formatTokens(tokenBalance, coin.tokenDecimals)} ${coin.symbol}`}
            </span>
          )}
        </div>
        <input
          id="trade-amount"
          className="field tabular text-lg"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {wallet && (
          <div className="mt-2 flex gap-2">
            {[25n, 50n, 100n].map((percent) => (
              <button key={percent} className="button-quiet flex-1 px-2 py-1 text-xs" onClick={() => fill(percent)}>
                {percent === 100n ? "Max" : `${percent}%`}
              </button>
            ))}
          </div>
        )}
      </div>

      {windowOpen && market && side === "buy" && (
        <p className="mt-3 rounded-lg border border-accent/50 px-3 py-2 text-xs text-accent">
          Launch window: for the next {formatDuration(Math.max(1, Number(market.curve.earlyWindowEnd) - now))} each wallet can
          buy at most {formatTokens(market.curve.earlyWalletCap, coin.tokenDecimals)} {coin.symbol}
          {windowAllowance !== undefined && position
            ? ` (you have ${formatTokens(windowAllowance, coin.tokenDecimals)} left)`
            : ""}
          . Everyone pays the same fee.
        </p>
      )}

      <dl className="mt-4 space-y-2">
        <Row label="You receive">{preview ? formatOut(preview.amountOut) : "–"}</Row>
        <Row
          label="Minimum received"
          hint="If the price moves so far that you would get less than this, the trade is cancelled and you keep your funds."
        >
          {preview ? formatOut(preview.minOut) : "–"}
        </Row>
        <Row label="Price impact" hint="How much this trade moves the price against you, on top of the fee.">
          {preview ? (
            <span className={preview.priceImpactBps >= 500 ? "text-down" : preview.priceImpactBps >= 100 ? "text-accent" : ""}>
              {formatBps(preview.priceImpactBps)}
            </span>
          ) : (
            "–"
          )}
        </Row>
        <Row
          label={`Fee (${formatBps(market?.pool ? coin.poolFeeBps : coin.platformFeeBps + coin.creatorFeeBps)})`}
          hint={
            market?.pool
              ? "Shared between the pool's liquidity, the platform and the coin's creator."
              : `${formatBps(coin.platformFeeBps)} to the platform and ${formatBps(coin.creatorFeeBps)} to the coin's creator.`
          }
        >
          {preview ? formatQuote(preview.fee, quote) : "–"}
        </Row>
        {preview?.graduates && (
          <p className="rounded-lg border border-up/50 px-3 py-2 text-xs text-up">
            This buy takes the last tokens on the curve and graduates the coin. You pay only for what is left:{" "}
            {formatQuote(preview.charged, quote)}.
          </p>
        )}
      </dl>

      <div className="mt-4 flex items-center gap-2 text-xs text-dim">
        <span title="How far the price may move before your trade is cancelled instead of filled.">Slippage limit</span>
        {SLIPPAGE_CHOICES.map((bps) => (
          <button
            key={bps}
            onClick={() => {
              setSlippageBps(bps);
              setCustomSlippage("");
            }}
            aria-pressed={slippageBps === bps && customSlippage === ""}
            className={`rounded-md border px-2 py-1 ${
              slippageBps === bps && customSlippage === "" ? "border-accent text-accent" : "border-line hover:border-dim"
            }`}
          >
            {formatBps(bps)}
          </button>
        ))}
        <input
          className="field w-16 px-2 py-1 text-xs"
          inputMode="decimal"
          placeholder="%"
          aria-label="Custom slippage limit, in percent"
          value={customSlippage}
          onChange={(event) => {
            setCustomSlippage(event.target.value);
            const percent = Number(event.target.value);
            if (Number.isFinite(percent) && percent >= 0 && percent <= 50) setSlippageBps(Math.round(percent * 100));
          }}
        />
      </div>

      <button
        className={`button mt-4 w-full py-3 text-base ${side === "buy" ? "bg-up text-ink" : "bg-down text-ink"}`}
        disabled={busy || blocked !== null || !preview}
        onClick={submit}
      >
        {blocked ?? action}
      </button>
    </section>
  );
}
