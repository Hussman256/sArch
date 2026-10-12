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
import { type ConnectedWallet, type WalletId, WALLETS, WalletError } from "./wallet/adapters.ts";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
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
  notify: (kind: Toast["kind"], text: string) => void;
  dismiss: (id: number) => void;
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

export function AppProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [activity, setActivity] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const notify = useCallback(
    (kind: Toast["kind"], text: string) => {
      const id = nextToast.current++;
      setToasts((list) => [...list.slice(-3), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 9_000 : 5_000);
    },
    [dismiss],
  );

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
      notify("info", `${describe.doing} Confirm it in your wallet.`);
      try {
        const processed = await client.sendAndConfirm(instructions, [wallet]);
        notify("success", describe.done);
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
  };
  return <AppContext.Provider value={state}>{children}</AppContext.Provider>;
}
