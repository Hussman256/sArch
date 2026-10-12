/**
 * Turning base-unit amounts into text a person can read, and what a person
 * typed back into base units. Amounts are bigints throughout: token amounts
 * do not fit in a JavaScript number.
 */

/** An asset as the app needs to know it to show amounts. */
export interface Asset {
  symbol: string;
  decimals: number;
}

const GROUPS = /\B(?=(\d{3})+(?!\d))/g;

/**
 * A base-unit amount as a decimal string: `formatUnits(1234500n, 6)` is
 * "1.2345". Trailing zeros are dropped; at most `maxFraction` decimals are
 * kept, rounding down so a balance is never overstated.
 */
export function formatUnits(amount: bigint | string, decimals: number, maxFraction = decimals): string {
  let value = BigInt(amount);
  const negative = value < 0n;
  if (negative) value = -value;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  let fraction = (value % scale).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFraction));
  fraction = fraction.replace(/0+$/, "");
  const text = `${whole.toString().replace(GROUPS, ",")}${fraction ? `.${fraction}` : ""}`;
  return negative ? `-${text}` : text;
}

/**
 * What a person typed, as base units. Null if it is not a plain non-negative
 * decimal number, or has more decimals than the asset does.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return null;
  const [whole = "", fraction = ""] = cleaned.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** A large number in short form: 1.2K, 3.45M, 6.7B. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return trim(value);
}

const trim = (value: number): string => {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.?0+$/, "");
};

/** A positive number with `significant` meaningful digits and no exponent, however small it is. */
export function significant(value: number, digits = 4): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, digits - 1 - magnitude);
  return value.toFixed(Math.min(decimals, 30)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

const isDollar = (asset: Asset) => asset.symbol.toUpperCase().includes("USD");

/** An amount of a quote asset, in the form people expect for that asset. */
export function formatQuote(amount: bigint | string, asset: Asset, options: { compact?: boolean } = {}): string {
  const value = BigInt(amount);
  const number = Number(value) / 10 ** asset.decimals;
  if (isDollar(asset)) {
    if (options.compact && number >= 1_000) return `$${compact(number)}`;
    return `$${formatUnits(value, asset.decimals, number >= 1 ? 2 : 4)}`;
  }
  if (options.compact && number >= 1_000) return `${compact(number)} ${asset.symbol}`;
  // Small bitcoin amounts read better with more decimals than large ones.
  const fraction = number >= 100 ? 2 : number >= 1 ? 4 : asset.decimals;
  return `${formatUnits(value, asset.decimals, fraction)} ${asset.symbol}`;
}

/**
 * The unit a coin's price is shown in, and what to multiply the API's price
 * (quote base units per token base unit) by to get there.
 *
 * One token of a new coin costs a few hundred-millionths of a bitcoin, which
 * written in BTC is a row of zeros. Bitcoin-quoted prices are shown in sats.
 */
export function priceUnit(tokenDecimals: number, quote: Asset): { label: string; scale: number; prefix: string; suffix: string } {
  if (isDollar(quote)) {
    return { label: "USD", scale: 10 ** (tokenDecimals - quote.decimals), prefix: "$", suffix: "" };
  }
  if (quote.decimals === 8 && /btc/i.test(quote.symbol)) {
    // The base unit of an 8-decimal bitcoin asset is the sat.
    return { label: "sats", scale: 10 ** tokenDecimals, prefix: "", suffix: " sats" };
  }
  return { label: quote.symbol, scale: 10 ** (tokenDecimals - quote.decimals), prefix: "", suffix: ` ${quote.symbol}` };
}

/** A coin's price per whole token, from the API's price. */
export function formatPrice(price: number, tokenDecimals: number, quote: Asset): string {
  const unit = priceUnit(tokenDecimals, quote);
  return `${unit.prefix}${significant(price * unit.scale)}${unit.suffix}`;
}

/** A token amount in short form, for feeds and tables. */
export function formatTokens(amount: bigint | string, decimals: number): string {
  return compact(Number(BigInt(amount)) / 10 ** decimals);
}

/** "8xKf…3mPq": enough of an address to recognise it. */
export function shortAddress(address: string, edge = 4): string {
  return address.length <= edge * 2 + 1 ? address : `${address.slice(0, edge)}…${address.slice(-edge)}`;
}

/** How long ago a Unix time was, in a few characters: 12s, 4m, 3h, 2d. */
export function timeAgo(unixSeconds: number, now: number = Date.now() / 1000): string {
  const seconds = Math.max(0, Math.floor(now - unixSeconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Basis points as a percentage: 225 is "2.25%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** A length of time in words: "10 seconds", "1 hour", "1 day". */
export function formatDuration(seconds: number): string {
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? "" : "s"}`;
  if (seconds < 60) return unit(seconds, "second");
  if (seconds < 3_600) return unit(Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return unit(Math.round(seconds / 3_600), "hour");
  return unit(Math.round(seconds / 86_400), "day");
}
