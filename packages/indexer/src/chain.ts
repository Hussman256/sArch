/**
 * Reads that go straight to the chain rather than the database: who holds a
 * coin, and what a wallet holds.
 *
 * Balances change with every transfer, not only with trades, so the token
 * accounts themselves are the only complete record. The node filters them by
 * mint or by owner; results are cached briefly so a busy page does not turn
 * into a query per viewer.
 */
import {
  type Address,
  type ArchpadClient,
  TOKEN_ACCOUNT_LEN,
  TOKEN_PROGRAM_ID,
  addressToBytes,
  decodeTokenAccount,
} from "@archpad/sdk";

export interface Holder {
  /** The wallet, or the program address, that owns the tokens. */
  owner: Address;
  amount: string;
  /** Share of total supply, in basis points. */
  shareBps: number;
  /** What this holder is, when it is not an ordinary wallet. */
  label: "curve" | "pool" | "creator" | null;
}

export interface Holders {
  /** Wallets and program addresses with a balance above zero. */
  count: number;
  /** The largest holders, biggest first. */
  top: Holder[];
}

export interface Holding {
  mint: Address;
  amount: string;
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/** Remembers results for a short time, and shares one request between simultaneous callers. */
class ShortCache<T> {
  private readonly entries = new Map<string, Cached<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 2_000,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;

    const value = load();
    this.entries.set(key, { at: now, value });
    // A failed read should be retried, not remembered.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    if (this.entries.size > this.maxEntries) {
      for (const [stale, entry] of this.entries) {
        if (now - entry.at >= this.ttlMs) this.entries.delete(stale);
      }
      // Still too many: drop the oldest. Maps iterate in insertion order.
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return value;
  }
}

export class ChainReader {
  private readonly holders = new ShortCache<Holders>(5_000);
  private readonly holdings = new ShortCache<Holding[]>(5_000);

  constructor(private readonly client: ArchpadClient) {}

  /** Who holds a coin, largest first. */
  getHolders(coin: { mint: Address; creator: Address; totalSupply: string }, top = 20): Promise<Holders> {
    return this.holders.get(`${coin.mint}:${top}`, async () => {
      const accounts = await this.client.rpc.getProgramAccounts(TOKEN_PROGRAM_ID, [
        { dataSize: TOKEN_ACCOUNT_LEN },
        { dataContent: { offset: 0, bytes: addressToBytes(coin.mint) } },
      ]);

      // One wallet can have several token accounts for the same coin.
      const byOwner = new Map<Address, bigint>();
      for (const { account } of accounts) {
        const token = decodeTokenAccount(account.data);
        if (token.amount === 0n) continue;
        byOwner.set(token.owner, (byOwner.get(token.owner) ?? 0n) + token.amount);
      }

      const curve = this.client.addresses.curve(coin.mint);
      const pool = this.client.addresses.pool(coin.mint);
      const supply = BigInt(coin.totalSupply);
      const ranked = [...byOwner.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
      return {
        count: ranked.length,
        top: ranked.slice(0, top).map(([owner, amount]) => ({
          owner,
          amount: amount.toString(),
          shareBps: supply === 0n ? 0 : Number((amount * 10_000n) / supply),
          label: owner === curve ? "curve" : owner === pool ? "pool" : owner === coin.creator ? "creator" : null,
        })),
      };
    });
  }

  /** Every token balance a wallet holds, of any mint. */
  getHoldings(wallet: Address): Promise<Holding[]> {
    return this.holdings.get(wallet, async () => {
      const accounts = await this.client.rpc.getProgramAccounts(TOKEN_PROGRAM_ID, [
        { dataSize: TOKEN_ACCOUNT_LEN },
        { dataContent: { offset: 32, bytes: addressToBytes(wallet) } },
      ]);
      const byMint = new Map<Address, bigint>();
      for (const { account } of accounts) {
        const token = decodeTokenAccount(account.data);
        if (token.amount === 0n) continue;
        byMint.set(token.mint, (byMint.get(token.mint) ?? 0n) + token.amount);
      }
      return [...byMint.entries()].map(([mint, amount]) => ({ mint, amount: amount.toString() }));
    });
  }

  /** Creator fees waiting to be claimed, for each of the given coins. */
  async getUnclaimedCreatorFees(mints: Address[]): Promise<Map<Address, string>> {
    const vaults = mints.map((mint) => this.client.addresses.creatorVault(mint));
    const accounts = await this.client.rpc.getMultipleAccounts(vaults);
    return new Map(
      mints.map((mint, i) => {
        const account = accounts[i];
        return [mint, account ? decodeTokenAccount(account.data).amount.toString() : "0"];
      }),
    );
  }
}
