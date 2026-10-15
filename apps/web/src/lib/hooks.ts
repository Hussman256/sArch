"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, associatedTokenAddress, decodeTokenAccount } from "@archpad/sdk";
import { type Holders, type StreamMessage, api, streamUrl } from "./api.ts";
import { useApp } from "./app.tsx";

export interface Loaded<T> {
  data: T | null;
  /** Set when the last attempt failed. Earlier data, if any, is kept. */
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads something and keeps it fresh: again whenever `key` changes, every
 * `everyMs` if given, and on demand. A slow answer to an old question is
 * dropped rather than shown over a newer one.
 */
export function useLoaded<T>(key: string | null, load: () => Promise<T>, everyMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(key !== null);
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const run = useCallback(() => {
    if (key === null) return;
    const ticket = ++latest.current;
    loader.current().then(
      (value) => {
        if (ticket !== latest.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (ticket !== latest.current) return;
        setError(reason instanceof Error ? reason.message : "could not load");
        setLoading(false);
      },
    );
  }, [key]);

  useEffect(() => {
    setData(null);
    setLoading(key !== null);
    run();
    if (!everyMs || key === null) return;
    const timer = window.setInterval(run, everyMs);
    return () => window.clearInterval(timer);
  }, [key, run, everyMs]);

  return { data, error, loading, reload: run };
}

/**
 * Listens to the live stream, for everything or for one coin, and reconnects
 * if the connection drops. `onMessage` may change between renders.
 */
export function useStream(mint: Address | undefined, onMessage: (message: StreamMessage) => void): boolean {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let attempts = 0;
    let closed = false;

    const open = () => {
      socket = new WebSocket(streamUrl(mint));
      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
      };
      socket.onmessage = (event) => {
        try {
          handler.current(JSON.parse(String(event.data)) as StreamMessage);
        } catch {
          // Not a message we understand; ignore it.
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = window.setTimeout(open, Math.min(15_000, 500 * 2 ** attempts++));
      };
      socket.onerror = () => socket?.close();
    };
    open();

    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [mint]);

  return connected;
}

/**
 * The connected wallet's balances of the given mints, read from the chain.
 * Reloads after every transaction the app sends.
 */
export function useBalances(mints: Address[]): { balances: Map<Address, bigint>; reload: () => void } {
  const { client, wallet, activity } = useApp();
  const key = wallet && client ? `${wallet.address}:${mints.join(",")}` : null;
  const { data, reload } = useLoaded(
    key,
    async () => {
      const accounts = await client!.rpc.getMultipleAccounts(
        mints.map((mint) => associatedTokenAddress(wallet!.address, mint)),
      );
      return new Map(mints.map((mint, i) => [mint, accounts[i] ? decodeTokenAccount(accounts[i]!.data).amount : 0n]));
    },
    10_000,
  );
  // A transaction just went through: read again, keeping the old figures on
  // screen until the new ones arrive.
  useEffect(() => {
    if (activity > 0) reload();
  }, [activity, reload]);
  return { balances: wallet ? (data ?? new Map()) : new Map(), reload };
}

/**
 * Holders for several coins at once. Each lookup reads the chain, so results
 * are kept for a minute and at most three are in flight at a time.
 */
const holdersCache = new Map<Address, { at: number; value: Holders }>();
const HOLDERS_TTL = 60_000;
const inFlight = new Map<Address, Promise<Holders | null>>();

function fetchHolders(mint: Address): Promise<Holders | null> {
  const cached = holdersCache.get(mint);
  if (cached && Date.now() - cached.at < HOLDERS_TTL) return Promise.resolve(cached.value);
  const pending = inFlight.get(mint);
  if (pending) return pending;
  const run = api.holders(mint).then(
    (value) => {
      holdersCache.set(mint, { at: Date.now(), value });
      return value;
    },
    () => null,
  );
  const tracked = run.finally(() => inFlight.delete(mint));
  inFlight.set(mint, tracked);
  return tracked;
}

export function useHoldersFor(mints: Address[]): Map<Address, Holders> {
  const [found, setFound] = useState<Map<Address, Holders>>(() => new Map());
  const key = [...new Set(mints)].sort().join(",");

  useEffect(() => {
    if (!key) return;
    let live = true;
    const list = key.split(",");
    const workers = 3;
    let next = 0;
    const work = async () => {
      while (live && next < list.length) {
        const mint = list[next++]!;
        const holders = await fetchHolders(mint);
        if (holders && live) setFound((map) => (map.get(mint) === holders ? map : new Map(map).set(mint, holders)));
      }
    };
    let sweeping = false;
    const sweep = async () => {
      if (sweeping) return;
      sweeping = true;
      next = 0;
      await Promise.all(Array.from({ length: workers }, work));
      sweeping = false;
    };
    void sweep();
    const timer = window.setInterval(() => void sweep(), HOLDERS_TTL);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [key]);

  return found;
}

/** The current Unix time, updated every second, for countdowns and "5s ago". */
export function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
