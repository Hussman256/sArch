"use client";

/**
 * Confirming a trade: the same numbers the wallet will be asked to sign,
 * priced against the chain's latest state, before anything is sent.
 */
import { useEffect, useState } from "react";
import type { CoinState } from "@archpad/sdk";
import type { CoinView, QuoteAsset } from "@/lib/api.ts";
import { useApp } from "@/lib/app.tsx";
import { formatBps, formatQuote, formatTokens } from "@/lib/format.ts";
import { useNow } from "@/lib/hooks.ts";
import { type Side, type TradePreview, previewTrade } from "@/lib/quote.ts";
import { CoinImage, Modal } from "./ui.tsx";

export interface TradeResult {
  graduated: boolean;
  preview: TradePreview;
}

export function TradeDialog({
  coin,
  quote,
  side,
  amountIn,
  slippageBps,
  onClose,
  onDone,
}: {
  coin: CoinView;
  quote: QuoteAsset;
  side: Side;
  amountIn: bigint;
  slippageBps: number;
  onClose: () => void;
  onDone?: (result: TradeResult) => void;
}) {
  const { client, wallet, send, money } = useApp();
  const now = useNow();
  const [state, setState] = useState<{ coin: CoinState; windowBought: bigint } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!client) return;
    let live = true;
    (async () => {
      try {
        const latest = await client.getCoin(coin.mint);
        if (!latest) throw new Error("This coin could not be read from the chain.");
        const position = wallet ? await client.getPosition(coin.mint, wallet.address) : null;
        if (live) setState({ coin: latest, windowBought: position?.windowBought ?? 0n });
      } catch (error) {
        if (live) setLoadError(error instanceof Error ? error.message : "Could not read the coin from the chain.");
      }
    })();
    return () => {
      live = false;
    };
  }, [client, wallet, coin.mint]);

  const market = state ? { curve: state.coin.curve, pool: state.coin.pool } : null;
  const windowOpen = market !== null && !market.pool && BigInt(now) < market.curve.earlyWindowEnd;
  const allowance =
    windowOpen && market && state
      ? state.windowBought >= market.curve.earlyWalletCap
        ? 0n
        : market.curve.earlyWalletCap - state.windowBought
      : undefined;
  const result = market ? previewTrade(market, side, amountIn, slippageBps, side === "buy" ? allowance : undefined) : null;
  const preview = result?.ok ? result.preview : null;

  const buy = side === "buy";
  const symbol = coin.symbol || "tokens";
  const tokens = (amount: bigint) => `${formatTokens(amount, coin.tokenDecimals)} ${symbol}`;
  const quoteText = (amount: bigint) => money.size(amount, quote);
  const exact = (amount: bigint) => formatQuote(amount, quote);
  const feeBps = market?.pool ? coin.poolFeeBps : coin.platformFeeBps + coin.creatorFeeBps;

  const sign = async () => {
    if (!client || !wallet || !preview || pending) return;
    setPending(true);
    try {
      // Plan against the freshest state there is; the slippage limit covers anything in between.
      const latest = await client.getCoin(coin.mint);
      if (!latest) return;
      const plan = latest.pool
        ? client.planPoolSwap(wallet.address, latest.pool, buy, amountIn, slippageBps)
        : buy
          ? client.planCurveBuy(wallet.address, latest.curve, amountIn, slippageBps)
          : client.planCurveSell(wallet.address, latest.curve, amountIn, slippageBps);
      const done = buy
        ? `Bought ${tokens(preview.amountOut)} for ${quoteText(preview.charged || amountIn)}`
        : `Sold ${tokens(amountIn)} for ${quoteText(preview.amountOut)}`;
      const processed = await send(plan.instructions, { doing: buy ? `Buying ${symbol}.` : `Selling ${symbol}.`, done });
      if (processed) {
        onDone?.({ graduated: !latest.pool && preview.graduates, preview });
        onClose();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal label="Confirm trade" onClose={pending ? undefined : onClose}>
      <div className="flex flex-col gap-3.5 rounded-[14px] border border-[rgba(245,241,232,0.12)] bg-panel p-5 shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
        <div className="flex items-center gap-3">
          <CoinImage coin={coin} size={40} radius={10} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[16px] font-medium">
              {buy ? "Buy" : "Sell"} {symbol}
            </span>
            <span className="text-[12px] text-dim">Your wallet shows the same numbers. Nothing moves until you approve.</span>
          </div>
        </div>

        <div className="tabular flex flex-col gap-2 rounded-[10px] bg-deep p-3 text-[12.5px] whitespace-nowrap">
          {loadError ? (
            <span className="text-down">{loadError}</span>
          ) : !market ? (
            <span className="text-faint">Reading the coin from the chain…</span>
          ) : result && !result.ok ? (
            <span className="whitespace-normal text-down">{result.reason}</span>
          ) : preview ? (
            <>
              <Row label="You pay">
                <span className="font-medium" title={buy ? exact(preview.charged || amountIn) : undefined}>
                  {buy ? quoteText(preview.charged || amountIn) : tokens(amountIn)}
                </span>
              </Row>
              <Row label="You receive">
                <span className="font-medium">{buy ? tokens(preview.amountOut) : quoteText(preview.amountOut)}</span>
              </Row>
              <Row label="Minimum received">{buy ? tokens(preview.minOut) : quoteText(preview.minOut)}</Row>
              <Row label="Price impact">{(preview.priceImpactBps / 100).toFixed(2)}%</Row>
              <Row label={`Fee ${formatBps(feeBps)}`}>{quoteText(preview.fee)}</Row>
              <div className="-mt-[5px] self-end text-[11.5px] text-faint">
                Creator {quoteText(preview.fees.creator)} · SARCH {quoteText(preview.fees.platform)}
                {preview.fees.lp > 0n && <> · Pool {quoteText(preview.fees.lp)}</>}
              </div>
            </>
          ) : null}
        </div>

        {preview?.graduates && (
          <div className="rounded-[8px] bg-[rgba(247,147,26,0.12)] px-2.5 py-[9px] text-[12px] leading-[1.45] text-amber-pale">
            This buy fills the curve, so {symbol} graduates in the same transaction.
            {preview.charged < amountIn && <> You pay only for what is left: {exact(preview.charged)}.</>}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-[12px] text-mute">
            <span>{pending ? "Waiting for your wallet, then submitting to Arch…" : "Check the numbers, then sign in your wallet"}</span>
            <span className="text-faint">Slippage limit {formatBps(slippageBps)}</span>
          </div>
          <div className="h-[3px] overflow-hidden rounded-[2px] bg-[rgba(245,241,232,0.08)]">
            <div className="h-full bg-orange transition-[width] duration-[900ms] ease-linear" style={{ width: pending ? "100%" : "0%" }} />
          </div>
        </div>

        <div className="grid grid-cols-[1fr_1.4fr] gap-2">
          <button className="btn-outline h-10 text-[13.5px]" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button className="btn-primary h-10 text-[13.5px]" onClick={sign} disabled={!preview || pending || !wallet} style={{ opacity: pending ? 0.6 : undefined }}>
            {pending ? "Approve in wallet…" : "Sign in wallet"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2.5">
      <span className="text-dim">{label}</span>
      <span>{children}</span>
    </div>
  );
}
