"use client";

/** Small pieces used all over the app. */
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CoinView } from "@/lib/api.ts";
import { getCoinGlyph, ident } from "@/lib/design-system.ts";
import { shortAddress } from "@/lib/format.ts";

/**
 * A coin's picture in a rounded tile, or a glyph on a colour picked from its
 * ticker when it has no usable picture.
 */
export function CoinImage({
  coin,
  size = 48,
  radius,
  className = "",
  style,
}: {
  coin: Pick<CoinView, "image" | "symbol" | "name">;
  size?: number;
  radius?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const [broken, setBroken] = useState(false);
  // Only plain web links are loaded; anything else a creator put on chain gets the fallback.
  const usable = /^https?:\/\//i.test(coin.image) && !broken;
  const r = radius ?? Math.round(size * 0.26);
  const box: CSSProperties = { width: size, height: size, borderRadius: r, ...style };
  if (!usable) {
    const { glyph, bg } = getCoinGlyph(coin.symbol, coin.name);
    const icon = Math.round(size * 0.59);
    return (
      <span style={{ ...box, background: bg }} className={`grid flex-none place-items-center text-panel ${className}`} aria-hidden="true">
        <svg viewBox="0 0 256 256" width={icon} height={icon} fill="currentColor">
          <path d={glyph} />
        </svg>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={coin.image}
      alt=""
      style={box}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={`flex-none bg-raised object-cover ${className}`}
      onError={() => setBroken(true)}
    />
  );
}

/** A thin progress track with an orange fill. */
export function Bar({
  percent,
  height = 4,
  color = "#F7931A",
  className = "",
  label,
}: {
  percent: number;
  height?: number;
  color?: string;
  className?: string;
  label?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <span
      className={`block overflow-hidden bg-[rgba(245,241,232,0.08)] ${className}`}
      style={{ height, borderRadius: height / 2 }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-label={label ?? "Progress to graduation"}
    >
      <span className="block h-full transition-[width] duration-500 ease-out" style={{ width: `${value}%`, background: color, borderRadius: height / 2 }} />
    </span>
  );
}

/** A wallet's round avatar. */
export function Avatar({ address, size = 18, me = false }: { address: string; size?: number; me?: boolean }) {
  return (
    <span
      className="flex-none rounded-full"
      style={{ width: size, height: size, background: me ? "linear-gradient(135deg,#FFB257,#7A4A0E)" : ident(address) }}
      aria-hidden="true"
    />
  );
}

export function WalletLink({ address, className = "" }: { address: string; className?: string }) {
  return (
    <Link href={`/profile/${address}`} className={`tabular hover:text-amber-pale ${className}`} title={address}>
      {shortAddress(address)}
    </Link>
  );
}

/** What to show in place of content that has not arrived, is empty, or failed. */
export function Notice({ children, tone = "dim", className = "" }: { children: ReactNode; tone?: "dim" | "error"; className?: string }) {
  return (
    <div className={`card px-4 py-8 text-center text-[13px] ${tone === "error" ? "text-down" : "text-faint"} ${className}`}>{children}</div>
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div className={`animate-pulse rounded-[10px] bg-[rgba(245,241,232,0.05)] ${className}`} style={style} aria-hidden="true" />;
}

/** A dimmed backdrop with a dialog card, closed with Escape or a click outside. */
export function Modal({
  label,
  onClose,
  children,
  width = 420,
  top = 150,
  className = "",
  dim = 0.66,
}: {
  label: string;
  onClose?: (() => void) | undefined;
  children: ReactNode;
  width?: number;
  top?: number;
  className?: string;
  dim?: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    card.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pb-10"
      style={{ paddingTop: `min(${top}px, 12vh)`, background: `rgba(4,20,15,${dim})` }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`flex max-w-full flex-col ${className}`}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}

/** A label and value on one line, as in the receipts and quote breakdowns. */
export function Line({ label, children, className = "" }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`flex justify-between gap-2.5 ${className}`}>
      <span className="text-dim">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/** Copies text and briefly says so. */
export function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [
    copied,
    (key, text) => {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      setCopied(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1_800);
    },
  ];
}
