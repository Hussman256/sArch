/**
 * The indexer's API, as the app calls it. The response types are the
 * indexer's own, so the two cannot drift apart unnoticed.
 */
import type { Address, ProgramIds } from "@archpad/sdk";
import type { Candle, CoinSort, CoinView, Holders, Notification, Totals, TradeRecord } from "@archpad/indexer";

export type { Candle, CoinSort, CoinView, Holders, Totals, TradeRecord };

/** Where the indexer's API lives. Set NEXT_PUBLIC_API_URL to point somewhere else. */
export const API_URL = (process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:8787").replace(/\/$/, "");

export interface CoinLinks {
  website?: string;
  x?: string;
  telegram?: string;
}

/** A coin with what its off-chain metadata document adds. */
export interface CoinDetail extends CoinView {
  fullDescription: string;
  links: CoinLinks;
}

export interface QuoteAsset {
  mint: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** True while new launches against this asset are paused. */
  paused: boolean;
  virtualQuoteReserves: string;
  /** Quote a curve priced in this asset raises before it graduates. */
  graduationQuote: string;
}

export interface LaunchTerms {
  platformFeeBps: number;
  creatorFeeBps: number;
  minCreatorBuyBps: number;
  earlyWalletCapBps: number;
  earlyWindowSecs: number;
  tokenDecimals: number;
  totalSupply: string;
  curveSupply: string;
  virtualTokenReserves: string;
  poolFeeBps: number;
}

export interface NetworkInfo {
  network: string;
  bitcoinNetwork: "mainnet" | "testnet" | "regtest";
  programs: ProgramIds;
  indexer: { height: number; finalizedHeight: number };
  /** True on a local chain, where the API can hand out test funds. */
  devFaucet: boolean;
  /** False until the launchpad's config exists on this network. */
  initialised: boolean;
  launchesPaused?: boolean;
  admins?: { members: Address[]; threshold: number };
  timelockSecs?: number;
  treasury?: Address;
  launch?: LaunchTerms;
  quotes?: QuoteAsset[];
}

export interface FeedTrade extends TradeRecord {
  symbol: string;
  name: string;
  image: string;
  /** The asset the trade's amount is in. */
  quoteMint: Address;
}

export interface WalletProfile {
  wallet: Address;
  created: (CoinView & { unclaimedCreatorFees: string })[];
  holdings: { coin: CoinView; amount: string; valueQuote: string }[];
  quoteBalances: { mint: Address; amount: string }[];
  trades: (TradeRecord & { symbol: string; quoteMint: Address })[];
}

/** A message on the live stream: what happened, and the coin as it now stands. */
export type StreamMessage = Notification & { coin: CoinView | null };

/** The API answered, but with an error. `message` is safe to show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, init);
  } catch {
    throw new ApiError(0, "could not reach the launchpad's API");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? `the API returned an error (${response.status})`);
  }
  return (await response.json()) as T;
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const api = {
  network: () => request<NetworkInfo>("/v1/network"),

  coins: (params: { sort?: CoinSort; quote?: Address; creator?: Address; q?: string; limit?: number; offset?: number } = {}) =>
    request<{ coins: CoinView[] }>(`/v1/coins${query(params)}`).then((body) => body.coins),

  coin: (mint: Address) => request<{ coin: CoinDetail }>(`/v1/coins/${mint}`).then((body) => body.coin),

  trades: (mint: Address, params: { limit?: number; before?: string } = {}) =>
    request<{ trades: TradeRecord[] }>(`/v1/coins/${mint}/trades${query(params)}`).then((body) => body.trades),

  candles: (mint: Address, interval: number) =>
    request<{ candles: Candle[] }>(`/v1/coins/${mint}/candles${query({ interval })}`).then((body) => body.candles),

  holders: (mint: Address) => request<Holders>(`/v1/coins/${mint}/holders`),

  feed: (limit = 30, before?: string) =>
    request<{ trades: FeedTrade[] }>(`/v1/trades${query({ limit, before })}`).then((body) => body.trades),

  wallet: (address: Address) => request<WalletProfile>(`/v1/wallets/${address}`),

  stats: () => request<Totals>("/v1/stats"),

  /** Uploads a coin image. Returns the link that goes on chain. */
  uploadImage: (file: Blob) =>
    request<{ url: string; name: string }>("/v1/uploads/image", {
      method: "POST",
      headers: { "content-type": file.type || "image/png" },
      body: file,
    }),

  /** Stores a coin's metadata document. Returns the hash that goes on chain. */
  uploadMetadata: (document: { name: string; symbol: string; description: string; image: string; links: CoinLinks }) =>
    request<{ hash: string }>("/v1/uploads/metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(document),
    }),

  /** Local chains only: asks the API to send a wallet test funds. */
  fund: (address: Address) =>
    request<{ ok: true }>("/v1/dev/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    }),
};

/** The live stream's address, for everything or for one coin. */
export function streamUrl(mint?: Address): string {
  return `${API_URL.replace(/^http/, "ws")}/v1/stream${mint ? `?mint=${mint}` : ""}`;
}
