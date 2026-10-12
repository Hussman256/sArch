/**
 * Works out what a trade would do before anyone signs it: what comes back,
 * what it costs in fees, how far it moves the price, and the least the
 * trader will accept.
 *
 * The numbers come from the same integer math the programs run, so what is
 * shown is what the chain will do if nothing changes in between. The
 * slippage limit covers the case where something does.
 */
import {
  type Curve,
  type Pool,
  MathError,
  applySlippage,
  curveFeeRates,
  curveReserves,
  poolFeeRates,
  poolQuoteBuy,
  poolQuoteSell,
  poolReserves,
  quoteBuy,
  quoteInForTokensOut,
  quoteSell,
} from "@archpad/sdk";

export type Side = "buy" | "sell";

export interface TradePreview {
  venue: "curve" | "pool";
  side: Side;
  /** What the trader puts in: quote for a buy, tokens for a sell. */
  amountIn: bigint;
  /** What the trader gets: tokens for a buy, quote for a sell. */
  amountOut: bigint;
  /** The least the transaction will accept in place of `amountOut`. */
  minOut: bigint;
  /** Total fee, in the quote asset. */
  fee: bigint;
  /** For a buy, the quote actually taken. Less than `amountIn` when the buy takes the last tokens. */
  charged: bigint;
  /** How much worse the trade's average price is than the price before it, in basis points. */
  priceImpactBps: number;
  /** True when this buy sells out the curve and graduates the coin. */
  graduates: boolean;
}

export type PreviewResult = { ok: true; preview: TradePreview } | { ok: false; reason: string };

/** The state a trade is priced against, as read from the chain. */
export interface Market {
  curve: Curve;
  /** Present once the coin has graduated. */
  pool: Pool | null;
}

const fail = (reason: string): PreviewResult => ({ ok: false, reason });

/** How far `executed` (out per in) falls short of `spot`, in basis points. Never negative. */
function impactBps(spotNum: bigint, spotDen: bigint, outAmount: bigint, inAmount: bigint): number {
  if (spotNum === 0n || spotDen === 0n || inAmount === 0n) return 0;
  // spot = spotNum / spotDen (out per in). impact = 1 - (out/in) / spot.
  const scaled = (outAmount * spotDen * 1_000_000n) / (inAmount * spotNum);
  return Math.max(0, Math.round((1_000_000 - Number(scaled)) / 100));
}

/**
 * Prices a trade. `windowAllowance` is how many more tokens this wallet may
 * buy while the launch window is open, or undefined once it has closed.
 */
export function previewTrade(
  market: Market,
  side: Side,
  amountIn: bigint,
  slippageBps: number,
  windowAllowance?: bigint,
): PreviewResult {
  if (amountIn <= 0n) return fail("Enter an amount.");
  const { curve, pool } = market;

  try {
    if (pool) {
      const reserves = poolReserves(pool);
      const rates = poolFeeRates(pool);
      if (side === "buy") {
        const quote = poolQuoteBuy(reserves, rates, amountIn);
        const fee = quote.fees.lp + quote.fees.platform + quote.fees.creator;
        return {
          ok: true,
          preview: {
            venue: "pool",
            side,
            amountIn,
            amountOut: quote.tokensOut,
            minOut: applySlippage(quote.tokensOut, slippageBps),
            fee,
            charged: quote.quoteCharged,
            // Tokens per quote, before and after. The fee is a cost, not price impact.
            priceImpactBps: impactBps(reserves.token, reserves.quote, quote.tokensOut, quote.quoteToPool),
            graduates: false,
          },
        };
      }
      const quote = poolQuoteSell(reserves, rates, amountIn);
      const fee = quote.fees.lp + quote.fees.platform + quote.fees.creator;
      return {
        ok: true,
        preview: {
          venue: "pool",
          side,
          amountIn,
          amountOut: quote.quoteOut,
          minOut: applySlippage(quote.quoteOut, slippageBps),
          fee,
          charged: 0n,
          priceImpactBps: impactBps(reserves.quote, reserves.token, quote.quoteFromPool, amountIn),
          graduates: false,
        },
      };
    }

    const reserves = curveReserves(curve);
    const rates = curveFeeRates(curve);
    if (side === "buy") {
      const quote = quoteBuy(reserves, rates, amountIn);
      if (windowAllowance !== undefined && quote.tokensOut > windowAllowance) {
        return fail(
          windowAllowance === 0n
            ? "You have bought the most one wallet can during the launch window. Try again when it closes."
            : "That is more than one wallet can buy during the launch window. Use Max for the most you can buy now.",
        );
      }
      return {
        ok: true,
        preview: {
          venue: "curve",
          side,
          amountIn,
          amountOut: quote.tokensOut,
          minOut: applySlippage(quote.tokensOut, slippageBps),
          fee: quote.fees.platform + quote.fees.creator,
          charged: quote.quoteCharged,
          priceImpactBps: impactBps(reserves.virtualToken, reserves.virtualQuote, quote.tokensOut, quote.quoteToCurve),
          graduates: quote.completesCurve,
        },
      };
    }
    const quote = quoteSell(reserves, rates, amountIn);
    return {
      ok: true,
      preview: {
        venue: "curve",
        side,
        amountIn,
        amountOut: quote.quoteOut,
        minOut: applySlippage(quote.quoteOut, slippageBps),
        fee: quote.fees.platform + quote.fees.creator,
        charged: 0n,
        priceImpactBps: impactBps(reserves.virtualQuote, reserves.virtualToken, quote.quoteFromCurve, amountIn),
        graduates: false,
      },
    };
  } catch (error) {
    if (error instanceof MathError) {
      switch (error.code) {
        case "DustTrade":
        case "ZeroAmount":
          return fail("That amount is too small to trade.");
        case "InsufficientReserves":
          return fail(pool ? "The pool cannot fill a trade of that size." : "The curve does not hold that much to pay out.");
        case "CurveComplete":
          return fail("Every curve token is sold. The coin is graduating.");
        default:
          return fail("That amount is too large.");
      }
    }
    return fail("That amount cannot be traded.");
  }
}

/**
 * The most quote a wallet can usefully spend on a curve buy right now: enough
 * to take every token left, or every token its launch-window allowance
 * permits, whichever is less.
 */
export function maxUsefulBuy(curve: Curve, windowAllowance?: bigint): bigint {
  const reserves = curveReserves(curve);
  let tokens = reserves.realToken;
  if (windowAllowance !== undefined && windowAllowance < tokens) tokens = windowAllowance;
  if (tokens <= 0n) return 0n;
  try {
    let budget = quoteInForTokensOut(reserves, curveFeeRates(curve), tokens);
    // Paying for exactly `tokens` can return a few base units more, which the
    // allowance would then refuse. Step down until it fits.
    for (let i = 0; i < 64 && budget > 1n; i++) {
      if (quoteBuy(reserves, curveFeeRates(curve), budget).tokensOut <= tokens) break;
      budget -= 1n;
    }
    return budget;
  } catch {
    return 0n;
  }
}
