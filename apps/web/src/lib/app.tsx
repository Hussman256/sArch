"use client";

/**
 * What every page shares: which network the app is on and how its launchpad
 * is configured, the connected wallet, and a way to tell the person how a
 * transaction went.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type Address,
  type Instruction,
  type ProcessedTransaction,
  ArchRpc,
  ArchpadClient,
  TransactionFailedError,
} from "@archpad/sdk";
import { type NetworkInfo, type QuoteAsset, ApiError, api } from "./api.ts";
import { type BtcPrice, type DisplayUnit, type Money, money } from "./money.ts";
import { type ConnectedWallet, type WalletId, WALLETS, WalletError } from "./wallet/adapters.ts";

/**
 * Where the bitcoin price comes from, for showing amounts in dollars. It must
 * answer in CoinGecko's simple-price shape. Set NEXT_PUBLIC_BTC_PRICE_URL to
 * use another source, or to an empty string to switch dollar conversion off.
 */
const BTC_PRICE_URL =
  process.env["NEXT_PUBLIC_BTC_PRICE_URL"] ??
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  sub?: string;
}

interface AppState {
  /** Null until the API has answered. */
  network: NetworkInfo | null;
  /** Set when the API could not be reached. */
  networkError: string | null;
  /** Talks to the chain through the app's own proxy. Null until the network is known. */
  client: ArchpadClient | null;
  /** The quote asset with this mint, if the network accepts it. */
  quoteOf: (mint: Address) => QuoteAsset | undefined;
  refreshNetwork: () => Promise<void>;

  wallet: ConnectedWallet | null;
  connecting: boolean;
  connect: (id: WalletId) => Promise<void>;
  disconnect: () => void;
  /** Bumped after every confirmed transaction, so balances know to reload. */
  activity: number;

  /**
   * Signs and sends a transaction with the connected wallet and waits for the
   * result. Tells the person what happened either way; resolves to null if it
   * did not go through.
   */
  send: (instructions: Instruction[], describe: { doing: string; done: string }) => Promise<ProcessedTransaction | null>;

  toasts: Toast[];
  notify: (kind: Toast["kind"], text: string, sub?: string) => void;
  dismiss: (id: number) => void;

  /** Whether amounts are shown in bitcoin or dollars. */
  unit: DisplayUnit;
  setUnit: (unit: DisplayUnit) => void;
  /** The bitcoin price, or null until it is known (or if it cannot be had). */
  btcPrice: BtcPrice | null;
  /** Formatters for the chosen unit. */
  money: Money;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error("useApp must be used inside <AppProvider>");
  return state;
}

/** Explains a failure in words the person can act on. */
export function explain(error: unknown): string {
  if (error instanceof TransactionFailedError) {
    if (error.programError) return sentence(error.programError.message);
    if (/insufficient|0x1\b/i.test(error.reason)) return "Your balance is too low for that.";
    return "The network rejected the transaction.";
  }
  if (error instanceof WalletError || error instanceof ApiError) return error.message;
  if (error instanceof Error) {
    if (/was not processed within/.test(error.message)) {
      return "The network has not confirmed the transaction yet. Check your balance before trying again.";
    }
    if (/no signer provided|does not verify/.test(error.message)) {
      return "The wallet's signature was not valid for this account. Reconnect the wallet and try again.";
    }
    return sentence(error.message);
  }
  return "Something went wrong.";
}

const sentence = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) return "Something went wrong.";
  const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

const LAST_WALLET = "archpad.last-wallet";
const UNIT_KEY = "sarch.unit";

export function AppProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [activity, setActivity] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  const [unit, setUnitState] = useState<DisplayUnit>("sats");
  const [btcPrice, setBtcPrice] = useState<BtcPrice | null>(null);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const notify = useCallback(
    (kind: Toast["kind"], text: string, sub?: string) => {
      const id = nextToast.current++;
      setToasts((list) => [...list.slice(-2), { id, kind, text, ...(sub ? { sub } : {}) }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 9_000 : 5_000);
    },
    [dismiss],
  );

  useEffect(() => {
    try {
      if (window.localStorage.getItem(UNIT_KEY) === "usd") setUnitState("usd");
    } catch {
      // Storage can be unavailable; sats is the default.
    }
  }, []);
  const setUnit = useCallback((next: DisplayUnit) => {
    setUnitState(next);
    try {
      window.localStorage.setItem(UNIT_KEY, next);
    } catch {
      // Remembering the choice is a convenience only.
    }
  }, []);

  useEffect(() => {
    if (!BTC_PRICE_URL) return;
    let live = true;
    const load = async () => {
      try {
        const response = await fetch(BTC_PRICE_URL, { referrerPolicy: "no-referrer" });
        if (!response.ok) return;
        const body = (await response.json()) as { bitcoin?: { usd?: unknown; usd_24h_change?: unknown } };
        const usd = Number(body.bitcoin?.usd);
        const change = Number(body.bitcoin?.usd_24h_change);
        if (live && Number.isFinite(usd) && usd > 0) {
          setBtcPrice({ usd, change24h: Number.isFinite(change) ? change : null });
        }
      } catch {
        // Keep the last price; amounts fall back to their own asset without one.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const formatters = useMemo(() => money(unit, btcPrice), [unit, btcPrice]);

  const refreshNetwork = useCallback(async () => {
    try {
      setNetwork(await api.network());
      setNetworkError(null);
    } catch (error) {
      setNetworkError(explain(error));
    }
  }, []);

  useEffect(() => {
    void refreshNetwork();
    const timer = window.setInterval(() => void refreshNetwork(), 20_000);
    return () => window.clearInterval(timer);
  }, [refreshNetwork]);

  // One client per set of program IDs. Requests go to the app's own /api/rpc,
  // which forwards them to the node.
  const programs = network?.programs;
  const programKey = programs ? Object.values(programs).join(",") : "";
  const client = useMemo(
    () => (programs ? new ArchpadClient(new ArchRpc("/api/rpc"), { programIds: programs }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [programKey],
  );

  const quoteOf = useCallback(
    (mint: Address) => network?.quotes?.find((quote) => quote.mint === mint),
    [network],
  );

  const bitcoinNetwork = network?.bitcoinNetwork;
  const connect = useCallback(
    async (id: WalletId) => {
      const adapter = WALLETS.find((candidate) => candidate.id === id);
      if (!adapter || !bitcoinNetwork) return;
      setConnecting(true);
      try {
        setWallet(await adapter.connect(bitcoinNetwork));
        window.localStorage.setItem(LAST_WALLET, id);
      } catch (error) {
        notify("error", explain(error));
      } finally {
        setConnecting(false);
      }
    },
    [bitcoinNetwork, notify],
  );

  const disconnect = useCallback(() => {
    setWallet(null);
    window.localStorage.removeItem(LAST_WALLET);
  }, []);

  // Reconnect the test wallet on reload. Extension wallets are left alone:
  // reconnecting them can pop a window up before the person has done anything.
  useEffect(() => {
    if (!bitcoinNetwork || wallet) return;
    if (window.localStorage.getItem(LAST_WALLET) === "test" && bitcoinNetwork !== "mainnet") void connect("test");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bitcoinNetwork]);

  const send = useCallback<AppState["send"]>(
    async (instructions, describe) => {
      if (!client || !wallet) {
        notify("error", "Connect a wallet first.");
        return null;
      }
      notify("info", "Confirm in your wallet", describe.doing);
      try {
        const processed = await client.sendAndConfirm(instructions, [wallet]);
        notify("success", describe.done, "Final on Arch");
        setActivity((count) => count + 1);
        return processed;
      } catch (error) {
        notify("error", explain(error));
        return null;
      }
    },
    [client, wallet, notify],
  );

  const state: AppState = {
    network,
    networkError,
    client,
    quoteOf,
    refreshNetwork,
    wallet,
    connecting,
    connect,
    disconnect,
    activity,
    send,
    toasts,
    notify,
    dismiss,
    unit,
    setUnit,
    btcPrice,
    money: formatters,
  };
  return <AppContext.Provider value={state}>{children}</AppContext.Provider>;
}
