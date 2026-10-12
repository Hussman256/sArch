/**
 * The networks the launchpad can be operated on, and where each one's keys,
 * programs and published settings live in the repository.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type BitcoinNetwork, type Signer, ArchRpc, hexToBytes, keypairSigner } from "@archpad/sdk";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type NetworkName = "localnet" | "testnet" | "mainnet";

export interface Network {
  name: NetworkName;
  rpcUrl: string;
  /** The Bitcoin network wallets must be on to sign for this chain. */
  bitcoinNetwork: BitcoinNetwork;
  /** Whether the node hands out free lamports. */
  hasFaucet: boolean;
  /** Which directory under `keys/` holds this network's program keys by default. */
  defaultKeySet: string;
}

export const NETWORKS: Record<NetworkName, Network> = {
  localnet: {
    name: "localnet",
    rpcUrl: "http://127.0.0.1:9002",
    bitcoinNetwork: "regtest",
    hasFaucet: true,
    defaultKeySet: "dev",
  },
  testnet: {
    name: "testnet",
    rpcUrl: "https://rpc.testnet.arch.network",
    bitcoinNetwork: "testnet",
    hasFaucet: true,
    defaultKeySet: "testnet",
  },
  mainnet: {
    name: "mainnet",
    rpcUrl: "https://rpc.mainnet.arch.network",
    bitcoinNetwork: "mainnet",
    hasFaucet: false,
    defaultKeySet: "mainnet",
  },
};

/** A quote asset as the app and indexer need to know it. */
export interface QuoteAssetInfo {
  symbol: string;
  name: string;
  mint: Address;
  decimals: number;
}

/**
 * What a deployment publishes for the app and the indexer: where the chain is
 * and which assets coins can be priced in. Written by `bootstrap`.
 */
export interface Deployment {
  network: NetworkName;
  rpcUrl: string;
  bitcoinNetwork: BitcoinNetwork;
  programs: { config: Address; launch: Address; fees: Address; pool: Address };
  quotes: QuoteAssetInfo[];
  /** Height of the first block that can contain launchpad transactions. */
  startHeight: number;
}

export const deploymentPath = (network: NetworkName) => join(REPO_ROOT, "deploy", `${network}.json`);

export function readDeployment(network: NetworkName): Deployment | null {
  const path = deploymentPath(network);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Deployment) : null;
}

export function writeDeployment(deployment: Deployment): void {
  writeFileSync(deploymentPath(deployment.network), `${JSON.stringify(deployment, null, 2)}\n`);
}

/** Reads a key file: a 32-byte secret key in hex. */
export function loadSigner(path: string): Signer {
  if (!existsSync(path)) throw new Error(`key file not found: ${path}`);
  const secret = hexToBytes(readFileSync(path, "utf8").trim());
  if (secret.length !== 32) throw new Error(`${path} is not a 32-byte hex secret key`);
  return keypairSigner(secret);
}

export const PROGRAM_NAMES = ["config", "fees", "launch", "pool"] as const;
export type ProgramName = (typeof PROGRAM_NAMES)[number];

export interface KeySet {
  name: string;
  authority: Signer;
  programs: Record<ProgramName, Signer>;
}

export function loadKeySet(name: string): KeySet {
  const dir = join(REPO_ROOT, "keys", name);
  if (!existsSync(dir)) {
    throw new Error(
      name === "dev"
        ? "development keys not found: run `node scripts/program-keys.mjs dev`"
        : `no key set at keys/${name}: run \`node scripts/program-keys.mjs generate ${name}\``,
    );
  }
  return {
    name,
    authority: loadSigner(join(dir, "authority.key")),
    programs: Object.fromEntries(
      PROGRAM_NAMES.map((program) => [program, loadSigner(join(dir, `${program}.key`))]),
    ) as Record<ProgramName, Signer>,
  };
}

export const isLocalUrl = (url: string): boolean => {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
};

export interface Target {
  network: Network;
  rpc: ArchRpc;
  keys: KeySet;
}

/**
 * Resolves `--network`, `--rpc` and `--keys` from the command line.
 *
 * The development keys are public: anyone can derive their secrets. Using
 * them anywhere but a local chain would hand the deployment to whoever looked
 * first, so that combination is refused outright.
 */
export function resolveTarget(args: Record<string, string>): Target {
  const name = (args["network"] ?? "localnet") as NetworkName;
  const base = NETWORKS[name];
  if (!base) throw new Error(`unknown network "${name}": expected localnet, testnet or mainnet`);

  const network: Network = { ...base, rpcUrl: args["rpc"] ?? process.env["ARCH_RPC_URL"] ?? base.rpcUrl };
  const keySetName = args["keys"] ?? network.defaultKeySet;
  if (keySetName === "dev" && !(network.name === "localnet" && isLocalUrl(network.rpcUrl))) {
    throw new Error("the dev key set is public and may only be used against a local chain");
  }
  return { network, rpc: new ArchRpc(network.rpcUrl), keys: loadKeySet(keySetName) };
}

/** Parses `--name value` and `--flag` arguments. */
export function parseArgs(argv: string[]): { positional: string[]; options: Record<string, string> } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      options[arg.slice(2)] = "true";
    } else {
      options[arg.slice(2)] = next;
      i++;
    }
  }
  return { positional, options };
}
