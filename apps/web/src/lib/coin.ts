/**
 * Figures the screens show about a coin that the API does not hand over
 * directly but that follow exactly from what it does.
 *
 * While a coin trades, its price reserves are the curve's virtual reserves,
 * and every buy or sell moves the virtual and real reserves by the same
 * amount. So the opening reserves are the current ones minus what the curve
 * has taken in and plus what it has sold.
 */
import type { CoinView, Holders, NetworkInfo } from "./api.ts";

/** The price the coin launched at, in quote base units per token base unit. */
export function launchPrice(coin: CoinView, network: NetworkInfo | null): number | null {
  if (coin.status === "trading") {
    const sold = BigInt(coin.curveSupply) - BigInt(coin.curveTokensLeft);
    const quote = BigInt(coin.priceQuote) - BigInt(coin.raisedQuote);
    const token = BigInt(coin.priceToken) + sold;
    if (quote > 0n && token > 0n) return Number(quote) / Number(token);
  }
  // A graduated coin's price comes from its pool. Its opening price is the
  // one the network launches coins in this asset at.
  const asset = network?.quotes?.find((quote) => quote.mint === coin.quoteMint);
  const tokens = network?.launch?.virtualTokenReserves;
  if (!asset || !tokens) return null;
  return Number(asset.virtualQuoteReserves) / Number(tokens);
}

/** Change in price since launch, in percent. */
export function sinceLaunch(coin: CoinView, network: NetworkInfo | null): number | null {
  const start = launchPrice(coin, network);
  if (!start || !coin.price) return null;
  return (coin.price / start - 1) * 100;
}

/** The price at which the curve sells out and the coin graduates. Null once it has. */
export function graduationPrice(coin: CoinView): number | null {
  if (coin.status !== "trading") return null;
  const sold = BigInt(coin.curveSupply) - BigInt(coin.curveTokensLeft);
  const startQuote = BigInt(coin.priceQuote) - BigInt(coin.raisedQuote);
  const startToken = BigInt(coin.priceToken) + sold;
  const endQuote = startQuote + BigInt(coin.graduationQuote);
  const endToken = startToken - BigInt(coin.curveSupply);
  if (endToken <= 0n) return null;
  return Number(endQuote) / Number(endToken);
}

/** Quote the curve still has to take in before it graduates. */
export function quoteToGraduate(coin: CoinView): bigint {
  const left = BigInt(coin.graduationQuote) - BigInt(coin.raisedQuote);
  return left > 0n ? left : 0n;
}

/** Share of supply held by the ten largest wallets, in basis points. Program accounts are not wallets. */
export function top10Bps(holders: Holders): number {
  return holders.top
    .filter((holder) => holder.label !== "curve" && holder.label !== "pool")
    .slice(0, 10)
    .reduce((total, holder) => total + holder.shareBps, 0);
}

/** Basis points as the design writes shares: "18.6%". */
export const bpsPct = (bps: number, decimals = 1): string => `${(bps / 100).toFixed(decimals)}%`;

/** The share of the curve a token amount is. */
export function curveShareBps(tokens: bigint | string, coin: Pick<CoinView, "curveSupply">): number {
  const supply = BigInt(coin.curveSupply);
  return supply === 0n ? 0 : Number((BigInt(tokens) * 10_000n) / supply);
}
