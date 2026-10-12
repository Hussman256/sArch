"use client";

/** The frame around every page: navigation, the wallet, and messages. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api.ts";
import { explain, useApp } from "@/lib/app.tsx";
import { formatQuote, formatUnits, shortAddress } from "@/lib/format.ts";
import { useBalances } from "@/lib/hooks.ts";
import { WALLETS } from "@/lib/wallet/adapters.ts";

const NAV = [
  { href: "/", label: "Coins" },
  { href: "/create", label: "Launch a coin" },
];

function WalletPicker({ onClose }: { onClose: () => void }) {
  const { connect, connecting, network } = useApp();
  const bitcoinNetwork = network?.bitcoinNetwork ?? "mainnet";
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    dialog.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Connect a wallet" className="panel w-full max-w-sm p-5">
        <h2 className="text-lg font-semibold">Connect a wallet</h2>
        <p className="mt-1 text-sm text-dim">
          Your wallet signs every transaction itself. This app never holds your keys or your funds.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {WALLETS.filter((adapter) => adapter.id !== "test" || bitcoinNetwork !== "mainnet").map((adapter) => {
            const available = adapter.available(bitcoinNetwork);
            return (
              <div key={adapter.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised p-3">
                <div className="min-w-0">
                  <div className="font-medium">{adapter.name}</div>
                  <div className="text-xs text-dim">{adapter.blurb}</div>
                </div>
                {available ? (
                  <button
                    className="button-primary shrink-0"
                    disabled={connecting}
                    onClick={async () => {
                      await connect(adapter.id);
                      onClose();
                    }}
                  >
                    Connect
                  </button>
                ) : (
                  <a className="button-quiet shrink-0" href={adapter.installUrl} target="_blank" rel="noreferrer noopener">
                    Install
                  </a>
                )}
              </div>
            );
          })}
        </div>
        <button className="button-quiet mt-4 w-full" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function WalletMenu() {
  const { wallet, disconnect, network, notify, client, activity } = useApp();
  const [open, setOpen] = useState(false);
  const [funding, setFunding] = useState(false);
  const quotes = network?.quotes ?? [];
  const { balances, reload } = useBalances(quotes.map((quote) => quote.mint));
  const [lamports, setLamports] = useState<bigint | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  // The network's own coin pays transaction fees, so show that balance too.
  useEffect(() => {
    if (!wallet || !client) return;
    let current = true;
    client.rpc
      .getAccount(wallet.address)
      .then((account) => current && setLamports(account?.lamports ?? 0n))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [wallet, client, activity, open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !menu.current?.contains(event.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (!wallet) return null;

  const fund = async () => {
    setFunding(true);
    try {
      await api.fund(wallet.address);
      notify("success", "Test funds sent to your wallet.");
      reload();
      setLamports(null);
      const account = await client?.rpc.getAccount(wallet.address);
      setLamports(account?.lamports ?? 0n);
    } catch (error) {
      notify("error", explain(error));
    } finally {
      setFunding(false);
    }
  };

  return (
    <div className="relative" ref={menu}>
      <button className="button-quiet" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="h-2 w-2 rounded-full bg-up" aria-hidden="true" />
        <span className="font-mono">{shortAddress(wallet.address)}</span>
      </button>
      {open && (
        <div className="panel absolute right-0 z-30 mt-2 w-72 p-4 shadow-xl">
          <div className="text-xs text-dim">{wallet.name}</div>
          <button
            className="mt-1 break-all text-left font-mono text-xs hover:text-accent"
            title="Copy address"
            onClick={() => {
              void navigator.clipboard.writeText(wallet.address);
              notify("info", "Address copied.");
            }}
          >
            {wallet.address}
          </button>

          <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
            {quotes.map((quote) => (
              <div key={quote.mint} className="flex justify-between">
                <span className="text-dim">{quote.symbol}</span>
                <span className="tabular">{formatQuote(balances.get(quote.mint) ?? 0n, quote)}</span>
              </div>
            ))}
            <div className="flex justify-between">
              <span className="text-dim" title="The network's own coin, which pays transaction fees">
                ARCH (for fees)
              </span>
              <span className="tabular">{lamports === null ? "…" : formatUnits(lamports, 9, 6)}</span>
            </div>
          </div>
          {lamports === 0n && (
            <p className="mt-2 text-xs text-accent">
              This wallet has no ARCH yet. Every transaction needs a little to pay the network fee.
            </p>
          )}

          <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
            {network?.devFaucet && (
              <button className="button-quiet w-full" onClick={fund} disabled={funding}>
                {funding ? "Sending…" : "Get test funds"}
              </button>
            )}
            <Link className="button-quiet w-full" href={`/profile/${wallet.address}`} onClick={() => setOpen(false)}>
              My profile
            </Link>
            <button
              className="button-quiet w-full"
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => dismiss(toast.id)}
          className={`panel px-4 py-3 text-left text-sm shadow-xl ${
            toast.kind === "error" ? "border-down text-down" : toast.kind === "success" ? "border-up" : ""
          }`}
        >
          {toast.text}
        </button>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { wallet, network, networkError, connecting } = useApp();
  const [picking, setPicking] = useState(false);
  const pathname = usePathname();
  const isAdmin = wallet && network?.admins?.members.includes(wallet.address);

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line py-4">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-ink" aria-hidden="true">
            ₿
          </span>
          Archpad
        </Link>
        <nav className="flex gap-1 text-sm" aria-label="Main">
          {[...NAV, ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : [])].map((item) => {
            const current = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 ${current ? "bg-raised text-text" : "text-dim hover:text-text"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {network && network.network !== "mainnet" && (
            <span className="rounded-md border border-line px-2 py-1 text-xs text-dim" title="Not real money">
              {network.network}
            </span>
          )}
          {wallet ? (
            <WalletMenu />
          ) : (
            <button className="button-primary" onClick={() => setPicking(true)} disabled={!network || connecting}>
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </header>

      {networkError && !network && (
        <div className="mt-4 rounded-lg border border-down px-4 py-3 text-sm text-down">
          {networkError} The app cannot show coins until it can.
        </div>
      )}
      {network?.launchesPaused && (
        <div className="mt-4 rounded-lg border border-accent px-4 py-3 text-sm text-accent">
          New launches are paused. Coins that already exist trade as usual.
        </div>
      )}

      <main className="flex-1 py-6">{children}</main>

      <footer className="border-t border-line py-4 text-xs text-dim">
        Coins here are launched by anyone and can lose all their value. Nothing on this site is advice.
      </footer>

      {picking && <WalletPicker onClose={() => setPicking(false)} />}
      <Toasts />
    </div>
  );
}
