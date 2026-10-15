/**
 * Amounts as the SARCH screens show them: bitcoin in sats or ₿, dollars in $,
 * switchable between the two with the sats/USD toggle.
 *
 * Converting between bitcoin and dollars needs the bitcoin price. When it is
 * not known, an amount is shown in its own asset rather than guessed at.
 */
import type { Asset } from "./format.ts";
import { compactFixed, formatQuote, int, small } from "./format.ts";

export type DisplayUnit = "sats" | "usd";

export interface BtcPrice {
  usd: number;
  /** Change over the last 24 hours, in percent. */
  change24h: number | null;
}

type Kind = "btc" | "usd" | "other";

export function assetKind(asset: Asset): Kind {
  if (/usd/i.test(asset.symbol)) return "usd";
  if (/btc/i.test(asset.symbol) && asset.decimals === 8) return "btc";
  return "other";
}

const toNumber = (amount: bigint | string | number, decimals: number): number =>
  Number(typeof amount === "number" ? amount : BigInt(amount)) / 10 ** decimals;

/** An amount in sats, or null if it cannot be expressed in bitcoin. */
export function toSats(amount: bigint | string | number, asset: Asset, price: BtcPrice | null): number | null {
  const kind = assetKind(asset);
  if (kind === "btc") return Number(typeof amount === "number" ? amount : BigInt(amount));
  if (kind === "usd" && price) return (toNumber(amount, asset.decimals) / price.usd) * 1e8;
  return null;
}

/** An amount in dollars, or null if it cannot be expressed in dollars. */
export function toUsd(amount: bigint | string | number, asset: Asset, price: BtcPrice | null): number | null {
  const kind = assetKind(asset);
  if (kind === "usd") return toNumber(amount, asset.decimals);
  if (kind === "btc" && price) return (toNumber(amount, 8) * price.usd);
  return null;
}

/**
 * An amount typed in the display unit (sats, or dollars) as base units of
 * `asset`. Null when it would need a bitcoin price that is not known.
 */
export function fromDisplay(value: number, unit: DisplayUnit, asset: Asset, price: BtcPrice | null): bigint | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const kind = assetKind(asset);
  const usd = unit === "usd" ? value : price ? (value / 1e8) * price.usd : null;
  const sats = unit === "sats" ? value : price ? (value / price.usd) * 1e8 : null;
  if (kind === "btc" && sats !== null) return BigInt(Math.floor(sats));
  if (kind === "usd" && usd !== null) return BigInt(Math.floor(usd * 10 ** asset.decimals));
  return null;
}

/** ₿ with as many decimals as the size of the amount calls for. */
export function btcText(sats: number, decimals?: number): string {
  const b = sats / 1e8;
  if (decimals !== undefined) return `₿${b.toFixed(decimals)}`;
  return `₿${b >= 10 ? b.toFixed(1) : b >= 1 ? b.toFixed(2) : b >= 0.1 ? b.toFixed(3) : b.toFixed(4)}`;
}

export function usdText(usd: number): string {
  return usd < 1000 ? `$${usd.toFixed(2)}` : `$${compactFixed(usd)}`;
}

/** Formatters bound to the chosen unit and the current bitcoin price. */
export interface Money {
  unit: DisplayUnit;
  price: BtcPrice | null;
  /** Large figures: market caps, volumes, balances. "₿0.0625" or "$5.2K". */
  big: (amount: bigint | string | number, asset: Asset) => string;
  /** Trade sizes: "50,000 sats" or "$41.55". */
  size: (amount: bigint | string | number, asset: Asset) => string;
  /** ₿ with fixed decimals in sats mode, compact dollars otherwise. */
  fixed: (amount: bigint | string | number, asset: Asset, decimals?: number) => string;
  /** A coin's price per whole token: "0.0₄412 sats" or "$0.0₇34". */
  px: (price: number, tokenDecimals: number, asset: Asset, bare?: boolean) => string;
  /** The same amount in the other unit, for a secondary line. Empty if unknown. */
  alt: (amount: bigint | string | number, asset: Asset) => string;
}

export function money(unit: DisplayUnit, price: BtcPrice | null): Money {
  const big = (amount: bigint | string | number, asset: Asset): string => {
    if (unit === "usd") {
      const usd = toUsd(amount, asset, price);
      if (usd !== null) return `$${compactFixed(usd)}`;
    } else {
      const sats = toSats(amount, asset, price);
      if (sats !== null) return btcText(sats);
    }
    return native(amount, asset);
  };

  const size = (amount: bigint | string | number, asset: Asset): string => {
    if (unit === "usd") {
      const usd = toUsd(amount, asset, price);
      if (usd !== null) return usdText(usd);
    } else {
      const sats = toSats(amount, asset, price);
      if (sats !== null) return `${sats < 1e6 ? int(sats) : compactFixed(sats, 2)} sats`;
    }
    return native(amount, asset);
  };

  const fixed = (amount: bigint | string | number, asset: Asset, decimals = 4): string => {
    if (unit === "usd") {
      const usd = toUsd(amount, asset, price);
      if (usd !== null) return `$${compactFixed(usd)}`;
    } else {
      const sats = toSats(amount, asset, price);
      if (sats !== null) return btcText(sats, decimals);
    }
    return native(amount, asset);
  };

  const priceText = (p: number, tokenDecimals: number, asset: Asset, bare = false): string => {
    // Quote base units per whole token.
    const perToken = p * 10 ** tokenDecimals;
    if (unit === "usd") {
      const usd = toUsd(perToken, asset, price);
      if (usd !== null) return `$${small(usd)}`;
    } else {
      const sats = toSats(perToken, asset, price);
      if (sats !== null) return bare ? small(sats) : `${small(sats)} sats`;
    }
    const units = perToken / 10 ** asset.decimals;
    return assetKind(asset) === "usd" ? `$${small(units)}` : `${small(units)}${bare ? "" : ` ${asset.symbol}`}`;
  };

  const alt = (amount: bigint | string | number, asset: Asset): string => {
    if (unit === "usd") {
      const sats = toSats(amount, asset, price);
      return sats === null ? "" : btcText(sats);
    }
    const usd = toUsd(amount, asset, price);
    return usd === null ? "" : `≈ $${usd.toLocaleString("en-US", { maximumFractionDigits: usd < 100 ? 2 : 0 })}`;
  };

  return { unit, price, big, size, fixed, px: priceText, alt };
}

function native(amount: bigint | string | number, asset: Asset): string {
  const value = typeof amount === "number" ? BigInt(Math.round(amount)) : BigInt(amount);
  return formatQuote(value, asset, { compact: true });
}
