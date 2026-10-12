/**
 * Wallets the app can sign with.
 *
 * An Arch account is a taproot key, and a transaction is authorised by a
 * BIP-322 message signature over its hash, which is something Bitcoin wallets
 * already know how to produce. So connecting a wallet means two things: learn
 * its taproot public key (that is the Arch account), and ask it to sign
 * messages. The app never sees a private key, except in the test wallet,
 * which exists only for trying things out on a test network.
 */
import {
  type Address,
  type BitcoinNetwork,
  type Signer,
  accountAddress,
  bytesToAddress,
  bytesToHex,
  extractSignature,
  hexToBytes,
  keypairSigner,
  taprootAddress,
} from "@archpad/sdk";

export type WalletId = "test" | "unisat" | "xverse";

/** A connected wallet: an Arch account that can sign for itself. */
export interface ConnectedWallet extends Signer {
  id: WalletId;
  name: string;
  /** The Bitcoin taproot address the wallet shows for this account. */
  taproot: string;
}

export interface WalletAdapter {
  id: WalletId;
  name: string;
  /** One line on what this is, shown in the wallet picker. */
  blurb: string;
  /** True when the wallet can be used in this browser on this network. */
  available(network: BitcoinNetwork): boolean;
  /** Where to get it, when it is not installed. */
  installUrl?: string;
  connect(network: BitcoinNetwork): Promise<ConnectedWallet>;
}

/** Something went wrong that the person can act on. `message` is written for them. */
export class WalletError extends Error {
  override readonly name = "WalletError";
}

/**
 * Turns the public key a wallet reports into an Arch account, and checks the
 * wallet's address really is the plain taproot address of that key. If it is
 * not (a different address type, or a script-path address), signatures from
 * it would be rejected by the chain, so it is better to say so now.
 */
function accountFromWallet(publicKeyHex: string, address: string, network: BitcoinNetwork, wallet: string): Address {
  let key: Uint8Array;
  try {
    key = hexToBytes(publicKeyHex);
  } catch {
    throw new WalletError(`${wallet} returned a public key that could not be read.`);
  }
  // Wallets give either the 32-byte x-only key or the 33-byte compressed one.
  if (key.length === 33) key = key.subarray(1);
  if (key.length !== 32) throw new WalletError(`${wallet} returned a public key of an unexpected length.`);
  const account = bytesToAddress(key);
  if (taprootAddress(account, network) !== address) {
    throw new WalletError(
      `${wallet} is not on a Taproot address for this network. Switch it to a Taproot (P2TR) address ` +
        `on Bitcoin ${network} and connect again.`,
    );
  }
  return account;
}

function rejected(error: unknown, wallet: string): never {
  const message = error instanceof Error ? error.message : typeof error === "object" && error !== null ? String((error as { message?: unknown }).message ?? "") : String(error);
  if (/reject|denied|cancel/i.test(message)) throw new WalletError("The request was declined in the wallet.");
  throw new WalletError(`${wallet} could not complete the request${message ? `: ${message}` : "."}`);
}

// --- test wallet --------------------------------------------------------------

const TEST_KEY = "archpad.test-wallet";

/**
 * A key kept in this browser's storage. Anyone with access to the browser
 * profile can read it, so it is offered only off mainnet.
 */
export const testWallet: WalletAdapter = {
  id: "test",
  name: "Test wallet",
  blurb: "A throwaway key kept in this browser. For test networks only.",
  available: (network) => network !== "mainnet" && typeof window !== "undefined",
  async connect(network) {
    if (network === "mainnet") throw new WalletError("The test wallet cannot be used on mainnet.");
    let stored = window.localStorage.getItem(TEST_KEY);
    if (!stored || !/^[0-9a-f]{64}$/.test(stored)) {
      stored = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      window.localStorage.setItem(TEST_KEY, stored);
    }
    const secret = hexToBytes(stored);
    const signer = keypairSigner(secret);
    return {
      id: "test",
      name: "Test wallet",
      address: accountAddress(secret),
      taproot: taprootAddress(signer.address, network),
      sign: signer.sign,
    };
  },
};

// --- UniSat -------------------------------------------------------------------

interface UnisatProvider {
  requestAccounts(): Promise<string[]>;
  getPublicKey(): Promise<string>;
  signMessage(message: string, type?: string): Promise<string>;
}

const unisatProvider = (): UnisatProvider | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { unisat?: UnisatProvider }).unisat;

export const unisat: WalletAdapter = {
  id: "unisat",
  name: "UniSat",
  blurb: "Browser extension wallet.",
  installUrl: "https://unisat.io/download",
  available: () => unisatProvider() !== undefined,
  async connect(network) {
    const provider = unisatProvider();
    if (!provider) throw new WalletError("UniSat is not installed in this browser.");
    let address: string;
    let publicKey: string;
    try {
      [address = ""] = await provider.requestAccounts();
      publicKey = await provider.getPublicKey();
    } catch (error) {
      rejected(error, "UniSat");
    }
    const account = accountFromWallet(publicKey, address, network, "UniSat");
    return {
      id: "unisat",
      name: "UniSat",
      address: account,
      taproot: address,
      async sign(payload) {
        try {
          return extractSignature(await provider.signMessage(payload, "bip322-simple"));
        } catch (error) {
          rejected(error, "UniSat");
        }
      },
    };
  },
};

// --- Xverse -------------------------------------------------------------------

interface XverseAddress {
  address: string;
  publicKey: string;
  purpose?: string;
  addressType?: string;
}

interface XverseProvider {
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { message?: string } }>;
}

const xverseProvider = (): XverseProvider | undefined => {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as {
    XverseProviders?: { BitcoinProvider?: XverseProvider };
    BitcoinProvider?: XverseProvider;
  };
  return scope.XverseProviders?.BitcoinProvider ?? scope.BitcoinProvider;
};

async function xverseRequest<T>(provider: XverseProvider, method: string, params?: unknown): Promise<T> {
  let reply: Awaited<ReturnType<XverseProvider["request"]>>;
  try {
    reply = await provider.request(method, params);
  } catch (error) {
    rejected(error, "Xverse");
  }
  if (reply.error) rejected(new Error(reply.error.message ?? "request failed"), "Xverse");
  return reply.result as T;
}

export const xverse: WalletAdapter = {
  id: "xverse",
  name: "Xverse",
  blurb: "Browser extension and mobile wallet.",
  installUrl: "https://www.xverse.app/download",
  available: () => xverseProvider() !== undefined,
  async connect(network) {
    const provider = xverseProvider();
    if (!provider) throw new WalletError("Xverse is not installed in this browser.");

    // Newer versions answer `wallet_connect`; older ones only `getAccounts`.
    let addresses: XverseAddress[];
    try {
      const connected = await xverseRequest<{ addresses: XverseAddress[] }>(provider, "wallet_connect", {
        addresses: ["ordinals"],
        message: "Connect to trade and launch coins.",
      });
      addresses = connected.addresses;
    } catch (error) {
      if (error instanceof WalletError && /declined/.test(error.message)) throw error;
      addresses = await xverseRequest<XverseAddress[]>(provider, "getAccounts", {
        purposes: ["ordinals"],
        message: "Connect to trade and launch coins.",
      });
    }
    // The "ordinals" address is the wallet's taproot address.
    const taproot = addresses.find((entry) => entry.purpose === "ordinals" || entry.addressType === "p2tr");
    if (!taproot) throw new WalletError("Xverse did not share a Taproot address.");
    const account = accountFromWallet(taproot.publicKey, taproot.address, network, "Xverse");
    return {
      id: "xverse",
      name: "Xverse",
      address: account,
      taproot: taproot.address,
      async sign(payload) {
        const signed = await xverseRequest<{ signature: string }>(provider, "signMessage", {
          address: taproot.address,
          message: payload,
          protocol: "BIP322",
        });
        return extractSignature(signed.signature);
      },
    };
  },
};

/** Every wallet the app knows, in the order the picker shows them. */
export const WALLETS: WalletAdapter[] = [xverse, unisat, testWallet];
