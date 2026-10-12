import type { Metadata } from "next";
import { CoinPage } from "@/components/CoinPage.tsx";
import { API_URL, type CoinDetail } from "@/lib/api.ts";

interface Props {
  params: Promise<{ mint: string }>;
}

/** Gives a shared link the coin's own name and picture. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { mint } = await params;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return { title: "Coin not found" };
  try {
    const response = await fetch(`${API_URL}/v1/coins/${mint}`, { next: { revalidate: 30 } });
    if (!response.ok) return { title: "Coin not found" };
    const { coin } = (await response.json()) as { coin: CoinDetail };
    const title = `${coin.name} (${coin.symbol})`;
    const description = coin.description || `Trade ${coin.symbol} on its bonding curve.`;
    return {
      title,
      description,
      openGraph: {
        title,
        description,
        ...(/^https:\/\//i.test(coin.image) && { images: [{ url: coin.image }] }),
      },
    };
  } catch {
    return { title: "Coin" };
  }
}

export default async function Page({ params }: Props) {
  const { mint } = await params;
  return <CoinPage mint={mint} />;
}
