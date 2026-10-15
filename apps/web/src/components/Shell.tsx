"use client";

/**
 * The frame around every app page: the navigation bar with search, the unit
 * toggle, the wallet and the trending ticker; the status bar; the wallet
 * picker; and transaction messages. The landing page and the admin page draw
 * their own headers.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { type CoinView, api } from "@/lib/api.ts";
import { explain, useApp } from "@/lib/app.tsx";
import { sinceLaunch } from "@/lib/coin.ts";
import { DOWN_COLOR, UP_COLOR } from "@/lib/design-system.ts";
import { formatBps, formatQuote, formatUnits, int, pct, shortAddress } from "@/lib/format.ts";
import { useBalances, useLoaded } from "@/lib/hooks.ts";
import { WALLETS } from "@/lib/wallet/adapters.ts";
import { Icon, Logo } from "./icons.tsx";
import { CoinImage } from "./ui.tsx";

/** Lets any page open the wallet picker. */
const PickerContext = createContext<() => void>(() => undefined);
export const useWalletPicker = () => useContext(PickerContext);

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(4,20,15,0.66)] px-4 pt-[min(150px,12vh)]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="flex w-[420px] max-w-full flex-col gap-3.5 rounded-[14px] border border-[rgba(245,241,232,0.12)] bg-panel p-5 shadow-[0_24px_70px_rgba(0,0,0,0.55)]"
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[16px] font-medium">Connect a wallet</span>
          <span className="text-[12px] text-dim">Your wallet signs every transaction itself. SARCH never holds your keys or funds.</span>
        </div>
        <div className="flex flex-col gap-2">
          {WALLETS.filter((adapter) => adapter.id !== "test" || bitcoinNetwork !== "mainnet").map((adapter) => {
            const available = adapter.available(bitcoinNetwork);
            return (
              <div key={adapter.id} className="flex items-center justify-between gap-3 rounded-[10px] bg-deep p-3">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium">{adapter.name}</div>
                  <div className="text-[12px] text-faint">{adapter.blurb}</div>
                </div>
                {available ? (
                  <button
                    className="btn-primary h-8 flex-none rounded-[8px] px-3 text-[12.5px]"
                    disabled={connecting}
                    onClick={async () => {
                      await connect(adapter.id);
                      onClose();
                    }}
                  >
                    Connect
                  </button>
                ) : (
                  <a className="btn-outline h-8 flex-none rounded-[8px] px-3 text-[12.5px]" href={adapter.installUrl} target="_blank" rel="noreferrer noopener">
                    Install
                  </a>
                )}
              </div>
            );
          })}
        </div>
        <button className="btn-outline h-10 text-[13.5px]" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function WalletButton() {
  const { wallet, disconnect, network, notify, client, activity, money, connecting } = useApp();
  const openPicker = useWalletPicker();
  const [open, setOpen] = useState(false);
  const [funding, setFunding] = useState(false);
  const quotes = network?.quotes ?? [];
  const { balances, reload } = useBalances(quotes.map((quote) => quote.mint));
  const [lamports, setLamports] = useState<bigint | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  // The network's own coin pays transaction fees, so its balance matters too.
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

  if (!wallet) {
    return (
      <button
        onClick={openPicker}
        disabled={!network || connecting}
        className="flex h-8 items-center gap-2 rounded-[8px] border border-[rgba(245,241,232,0.1)] bg-deep px-3 text-[12.5px] font-medium text-text hover:bg-raised disabled:opacity-50"
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

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

  // The pill shows the bitcoin balance, as the design does; else the first quote asset.
  const primary = quotes.find((quote) => /btc/i.test(quote.symbol)) ?? quotes[0];
  const pill = primary ? money.fixed(balances.get(primary.mint) ?? 0n, primary, 4) : "…";

  return (
    <div className="relative" ref={menu}>
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-8 items-center gap-2 rounded-[8px] border border-[rgba(245,241,232,0.1)] bg-deep pr-2.5 pl-1.5 text-[12.5px] text-text hover:bg-raised"
      >
        <span className="h-5 w-5 rounded-full bg-[linear-gradient(135deg,#FFB257,#7A4A0E)]" />
        <span className="tabular">{shortAddress(wallet.taproot || wallet.address, 4)}</span>
        <span className="h-3.5 w-px bg-[rgba(245,241,232,0.16)]" />
        <span className="tabular text-mute">{pill}</span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 rounded-[12px] border border-[rgba(245,241,232,0.12)] bg-panel p-4 shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
          <div className="flex items-center justify-between">
            <span className="kicker">{wallet.name}</span>
            <span className="flex items-center gap-1.5 text-[11.5px] text-up">
              <span className="h-1.5 w-1.5 rounded-full bg-up" /> Connected
            </span>
          </div>
          <button
            className="mt-1.5 block w-full text-left font-mono text-[11.5px] break-all text-soft hover:text-amber"
            title="Copy address"
            onClick={() => {
              void navigator.clipboard.writeText(wallet.address);
              notify("info", "Address copied.");
            }}
          >
            {wallet.address}
          </button>
          <div className="rule-top mt-3 flex flex-col gap-1.5 pt-3 text-[12.5px]">
            {quotes.map((quote) => (
              <div key={quote.mint} className="flex justify-between">
                <span className="text-faint">{quote.symbol}</span>
                <span className="tabular">{formatQuote(balances.get(quote.mint) ?? 0n, quote)}</span>
              </div>
            ))}
            <div className="flex justify-between">
              <span className="text-faint" title="The network's own coin, which pays transaction fees">
                ARCH, for network fees
              </span>
              <span className="tabular">{lamports === null ? "…" : formatUnits(lamports, 9, 6)}</span>
            </div>
          </div>
          {lamports === 0n && (
            <p className="mt-2 rounded-[8px] bg-[rgba(247,147,26,0.12)] p-2 text-[12px] text-amber-pale">
              This wallet has no ARCH yet. Every transaction needs a little to pay the network fee.
            </p>
          )}
          <div className="rule-top mt-3 flex flex-col gap-2 pt-3">
            {network?.devFaucet && (
              <button className="btn-outline h-8 rounded-[8px] text-[12.5px]" onClick={fund} disabled={funding}>
                {funding ? "Sending…" : "Get test funds"}
              </button>
            )}
            <Link className="btn-outline h-8 rounded-[8px] text-[12.5px]" href={`/profile/${wallet.address}`} onClick={() => setOpen(false)}>
              Portfolio
            </Link>
            <button
              className="btn-outline h-8 rounded-[8px] text-[12.5px] text-down"
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

function Search() {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Keep the box in step with the Discover page's search.
  useEffect(() => {
    if (pathname === "/discover") setText(params.get("q") ?? "");
  }, [pathname, params]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = text.trim();
    router.push(query ? `/discover?q=${encodeURIComponent(query)}` : "/discover");
  };

  return (
    <form
      onSubmit={submit}
      role="search"
      className="flex h-[34px] max-w-[460px] min-w-[160px] flex-1 cursor-text items-center gap-[9px] rounded-[8px] border border-[rgba(245,241,232,0.1)] bg-deep pr-2 pl-[11px] text-faint focus-within:border-[rgba(247,147,26,0.6)]"
      onClick={() => input.current?.focus()}
    >
      <Icon name="search" size={15} />
      <input
        ref={input}
        type="search"
        aria-label="Search coins"
        placeholder="Search by name, ticker or mint address"
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-text outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <kbd className="rounded-[5px] border border-[rgba(245,241,232,0.16)] px-1.5 py-[3px] font-sans text-[11px] leading-none text-dim">/</kbd>
    </form>
  );
}

function Ticker() {
  const { network } = useApp();
  const trending = useLoaded("nav:trending", () => api.coins({ sort: "trending", limit: 24 }), 30_000);
  const coins = (trending.data ?? []).filter((coin) => coin.status === "trading").slice(0, 12);
  return (
    <div className="rule-top flex h-[34px] items-center gap-4 px-4 text-[12px]">
      <span className="flex flex-none items-center gap-1.5 text-[10.5px] font-medium tracking-[0.08em] text-faint uppercase">
        <Icon name="trend" size={13} color="#F7931A" />
        Trending
      </span>
      <div className="fade-right no-scrollbar flex min-w-0 flex-1 gap-[22px] overflow-hidden">
        {trending.data && coins.length === 0 && <span className="text-faint">Nothing is trading on a curve yet.</span>}
        {coins.map((coin: CoinView, index) => {
          const change = sinceLaunch(coin, network);
          return (
            <Link key={coin.mint} href={`/coin/${coin.mint}`} className="flex flex-none items-center gap-1.5 text-text hover:text-amber-pale">
              <span className="tabular text-ghost">#{index + 1}</span>
              <CoinImage coin={coin} size={18} radius={5} />
              <span className="font-medium">{coin.symbol}</span>
              {change !== null && (
                <span className="tabular" style={{ color: change >= 0 ? UP_COLOR : DOWN_COLOR }}>
                  {pct(change)}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function AppNav() {
  const { wallet, unit, setUnit, btcPrice } = useApp();
  const openPicker = useWalletPicker();
  const pathname = usePathname();
  const active = pathname.startsWith("/create") ? "launch" : pathname.startsWith("/profile") ? "portfolio" : "discover";
  const linkClass = (key: string) =>
    `flex h-8 items-center rounded-[8px] px-[11px] text-[13.5px] font-medium hover:text-text ${
      active === key ? "bg-[rgba(245,241,232,0.08)] text-text" : "text-dim"
    }`;

  return (
    <header className="sticky top-0 z-30 flex flex-col border-b border-line bg-ground text-text">
      <div className="flex h-14 items-center gap-5 px-4">
        <Link href="/discover" aria-label="SARCH home" className="flex flex-none items-center gap-2.5 rounded-[6px] px-0.5 py-1">
          <Logo size={20} />
          <span className="text-[15px] font-medium tracking-[0.16em]">SARCH</span>
        </Link>
        <nav className="flex flex-none gap-0.5" aria-label="Main">
          <Link href="/discover" className={linkClass("discover")} aria-current={active === "discover" ? "page" : undefined}>
            Discover
          </Link>
          <Link href="/create" className={linkClass("launch")} aria-current={active === "launch" ? "page" : undefined}>
            Launch
          </Link>
          {wallet ? (
            <Link href={`/profile/${wallet.address}`} className={linkClass("portfolio")} aria-current={active === "portfolio" ? "page" : undefined}>
              Portfolio
            </Link>
          ) : (
            <button onClick={openPicker} className={linkClass("portfolio")}>
              Portfolio
            </button>
          )}
        </nav>
        <Suspense fallback={<div className="h-[34px] max-w-[460px] flex-1" />}>
          <Search />
        </Suspense>
        <div className="ml-auto flex flex-none items-center gap-2.5 whitespace-nowrap">
          <div className="seg">
            <button onClick={() => setUnit("sats")} className={`h-[26px] rounded-[6px] px-[9px] text-[12px] font-medium ${unit === "sats" ? "seg-on" : "seg-off"}`}>
              sats
            </button>
            <button
              onClick={() => setUnit("usd")}
              title={btcPrice ? undefined : "The bitcoin price is not available, so bitcoin amounts stay in sats."}
              className={`h-[26px] rounded-[6px] px-[9px] text-[12px] font-medium ${unit === "usd" ? "seg-on" : "seg-off"}`}
            >
              USD
            </button>
          </div>
          <Link href="/create" className="btn-primary h-8 rounded-[8px] px-3 text-[13px]">
            <Icon name="plus" size={14} />
            Launch a coin
          </Link>
          <WalletButton />
        </div>
      </div>
      <Ticker />
    </header>
  );
}

export function StatusBar() {
  const { network, networkError, btcPrice } = useApp();
  const [pulse, setPulse] = useState(1);
  useEffect(() => {
    const timer = window.setInterval(() => setPulse((value) => (value === 1 ? 0.35 : 1)), 600);
    return () => window.clearInterval(timer);
  }, []);

  const launch = network?.launch;
  const behind = network ? Math.max(0, network.indexer.finalizedHeight - network.indexer.height) : 0;
  const health = networkError && !network
    ? { text: "Cannot reach the SARCH API", color: DOWN_COLOR }
    : behind > 30
      ? { text: `Indexer catching up, ${int(behind)} blocks behind`, color: "#F2C46D" }
      : network
        ? { text: "All systems normal", color: UP_COLOR }
        : { text: "Connecting…", color: "#8E9B93" };

  return (
    <footer className="no-scrollbar flex h-[30px] flex-none items-center gap-3.5 overflow-x-auto border-t border-line bg-bar px-4 text-[11.5px] whitespace-nowrap text-dim tabular">
      {btcPrice && (
        <>
          <span className="flex items-center gap-1.5">
            <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-orange text-[9px] font-semibold text-ground">₿</span>
            <span className="text-text">${int(btcPrice.usd)}</span>
            {btcPrice.change24h !== null && (
              <span style={{ color: btcPrice.change24h >= 0 ? UP_COLOR : DOWN_COLOR }}>{pct(btcPrice.change24h, 2)}</span>
            )}
          </span>
          <span className="h-3 w-px bg-[rgba(245,241,232,0.12)]" />
        </>
      )}
      {network && (
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-up transition-opacity duration-300" style={{ opacity: pulse }} />
          Arch block <span className="text-text">{int(network.indexer.height)}</span>
          <span className="text-ghost">·</span>
          0.3s finality
        </span>
      )}
      {launch && (
        <>
          <span className="h-3 w-px bg-[rgba(245,241,232,0.12)]" />
          <span>
            Curve fee {formatBps(launch.platformFeeBps + launch.creatorFeeBps)}: {formatBps(launch.creatorFeeBps)} to the creator,{" "}
            {formatBps(launch.platformFeeBps)} to SARCH
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-1.5 text-soft">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: health.color }} />
        {health.text}
      </span>
      <Link href="/#risks" className="hover:text-text">
        Risk warning
      </Link>
      <Link href="/admin" className="hover:text-text">
        Admin
      </Link>
    </footer>
  );
}

const OK_ICON = "check" as const;

function Toasts({ top }: { top: number }) {
  const { toasts, dismiss } = useApp();
  return (
    <div className="pointer-events-none fixed left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" style={{ top }} aria-live="polite">
      {toasts.map((toast) => {
        const tone =
          toast.kind === "success"
            ? { bg: "rgba(102,222,142,0.16)", color: UP_COLOR, icon: OK_ICON }
            : toast.kind === "error"
              ? { bg: "rgba(255,107,122,0.16)", color: DOWN_COLOR, icon: "info" as const }
              : { bg: "rgba(247,147,26,0.16)", color: "#F7931A", icon: "clock" as const };
        return (
          <button
            key={toast.id}
            onClick={() => dismiss(toast.id)}
            className="pointer-events-auto flex max-w-[min(720px,calc(100vw-32px))] items-center gap-2.5 rounded-[10px] border border-[rgba(245,241,232,0.14)] bg-raised py-2.5 pr-4 pl-3 text-left shadow-[0_14px_36px_rgba(0,0,0,0.45)]"
          >
            <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full" style={{ background: tone.bg, color: tone.color }}>
              <Icon name={tone.icon} size={13} />
            </span>
            <span className="text-[13px] font-medium text-text">{toast.text}</span>
            {toast.sub && <span className="text-[12px] text-dim">{toast.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Banners() {
  const { network, networkError } = useApp();
  return (
    <>
      {networkError && !network && (
        <div className="mx-4 mt-3 rounded-[10px] border border-[rgba(255,107,122,0.5)] bg-[rgba(255,107,122,0.08)] px-4 py-2.5 text-[12.5px] text-down">
          {networkError} Coins cannot be shown until the API answers.
        </div>
      )}
      {network?.launchesPaused && (
        <div className="mx-4 mt-3 rounded-[10px] bg-[rgba(247,147,26,0.12)] px-4 py-2.5 text-[12.5px] text-amber-pale">
          New launches are paused. Coins that already exist trade as usual.
        </div>
      )}
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [picking, setPicking] = useState(false);
  const pathname = usePathname();
  // The landing page and the admin dashboard bring their own headers.
  const bare = pathname === "/" || pathname.startsWith("/admin");

  return (
    <PickerContext.Provider value={() => setPicking(true)}>
      {bare ? (
        children
      ) : (
        <div className="flex min-h-screen flex-col bg-ground text-text">
          <AppNav />
          <Banners />
          <div className="flex flex-1 flex-col">{children}</div>
          <StatusBar />
        </div>
      )}
      {picking && <WalletPicker onClose={() => setPicking(false)} />}
      <Toasts top={bare ? 24 : 104} />
    </PickerContext.Provider>
  );
}
