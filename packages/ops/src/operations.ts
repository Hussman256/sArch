/**
 * The operations behind the command line: deploy the programs, set a network
 * up to use them, and govern the config.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  type AdminAction,
  type ConfigData,
  type GlobalConfig,
  type LaunchParams,
  type Proposal,
  type QuoteAsset,
  type Signer,
  ArchpadClient,
  DEFAULT_PROGRAM_IDS,
  EMPTY_ADDRESS,
  INITIAL_AUTHORITY,
  IS_DEV_KEY_SET,
  MAX_ADMINS,
  MAX_QUOTE_ASSETS,
  MAX_WRITE_LEN,
  PROGRAM_DATA_OFFSET,
  approvers,
  associatedTokenAddress,
  configuredQuotes,
  createAssociatedTokenAccountIdempotent,
  decodeMint,
  decodeProgramState,
  deployProgram,
  graduationQuote,
  isAddress,
  launchCurveParams,
  loaderFinalize,
  minimumRent,
  proposalState,
  TOKEN_PROGRAM_ID,
  validateCurveParams,
} from "@archpad/sdk";
import { devMintSigner, ensureMint, fundFromFaucet, lamportsOf } from "./funding.ts";
import {
  type Deployment,
  type QuoteAssetInfo,
  type Target,
  PROGRAM_NAMES,
  REPO_ROOT,
  writeDeployment,
} from "./network.ts";

export type Log = (line: string) => void;

const FEE_PER_SIGNATURE = 5_000n;

function readJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface LaunchConfigFile {
  admins: Record<string, { members: string[]; threshold: number } | string>;
  timelockSecs: Record<string, number>;
  launch: Omit<LaunchParams, "totalSupply" | "curveSupply" | "virtualTokenReserves"> & {
    totalSupply: string;
    curveSupply: string;
    virtualTokenReserves: string;
  };
}

interface QuoteFileEntry {
  symbol: string;
  name: string;
  /** A real mint address, or `devMint` naming a test asset to create locally. */
  mint?: Address;
  devMint?: string;
  decimals: number;
  virtualQuoteReserves: string;
  unconfirmed?: boolean;
}

function programElf(name: string): Uint8Array {
  const path = join(REPO_ROOT, "programs", "target", "deploy", `archpad_${name}.so`);
  if (!existsSync(path)) throw new Error(`${path} not found: build the programs first (scripts/build-programs.sh)`);
  return readFileSync(path);
}

/** The key set must be the one the programs and SDK were built for. */
function assertKeysMatchBuild(target: Target): void {
  for (const name of PROGRAM_NAMES) {
    if (target.keys.programs[name].address !== DEFAULT_PROGRAM_IDS[name]) {
      throw new Error(
        `key set "${target.keys.name}" does not match the program IDs this build uses. ` +
          `Run \`node scripts/program-keys.mjs use ${target.keys.name}\`, rebuild the programs, and try again.`,
      );
    }
  }
  if (target.keys.authority.address !== INITIAL_AUTHORITY) {
    throw new Error(`key set "${target.keys.name}" has a different authority than the programs were built with`);
  }
  if (IS_DEV_KEY_SET && target.network.name !== "localnet") {
    throw new Error("this build uses the public development keys and can only be deployed to a local chain");
  }
}

/** Lamports the authority needs to deploy a program of this size. */
function deploymentCost(elfLength: number): bigint {
  const writes = BigInt(Math.ceil(elfLength / MAX_WRITE_LEN));
  return minimumRent(PROGRAM_DATA_OFFSET + elfLength) + (writes + 4n) * FEE_PER_SIGNATURE * 2n;
}

async function ensureLamports(target: Target, needed: bigint, log: Log): Promise<void> {
  const { rpc, keys, network } = target;
  const balance = await lamportsOf(rpc, keys.authority.address);
  if (balance >= needed) return;
  if (!network.hasFaucet) {
    throw new Error(
      `the authority ${keys.authority.address} holds ${balance} lamports and needs about ${needed}. ` +
        `${network.name} has no faucet: fund it from another account first.`,
    );
  }
  log(`funding the authority from the faucet (${balance} -> ${needed} lamports)`);
  await fundFromFaucet(rpc, keys.authority, needed);
}

/** Deploys all four programs. Programs already deployed with identical code are skipped. */
export async function deployPrograms(target: Target, log: Log): Promise<void> {
  assertKeysMatchBuild(target);
  const elfs = PROGRAM_NAMES.map((name) => ({ name, elf: programElf(name) }));
  const cost = elfs.reduce((total, { elf }) => total + deploymentCost(elf.length), 0n);
  await ensureLamports(target, cost + 1_000_000n, log);

  for (const { name, elf } of elfs) {
    const program = target.keys.programs[name];
    let lastReported = -1;
    const changed = await deployProgram(target.rpc, program, target.keys.authority, elf, {
      onProgress: (written, total) => {
        const percent = Math.floor((written * 100) / total / 25) * 25;
        if (percent !== lastReported) {
          lastReported = percent;
          log(`  ${name}: ${percent}%`);
        }
      },
    });
    log(`${name.padEnd(7)} ${program.address}  ${changed ? "deployed" : "already up to date"} (${elf.length} bytes)`);
  }
}

export interface ConfigOptions {
  /** Wallet that receives platform fees. Defaults to the authority, or the current treasury. */
  treasury?: Address;
  allowUnconfirmed?: boolean;
  /** Accept a mainnet config that one key alone can change. */
  allowSingleAdmin?: boolean;
}

/** Reads a network's admin keys from `launch-config.json`. */
function readAdmins(target: Target, file: LaunchConfigFile, options: ConfigOptions): ConfigData["admins"] {
  const entry = file.admins?.[target.network.name];
  if (!entry || typeof entry === "string") {
    throw new Error(`launch-config.json names no admins for ${target.network.name}`);
  }
  const members = entry.members.map((member) => (member === "$authority" ? target.keys.authority.address : member));
  for (const member of members) {
    if (!isAddress(member)) throw new Error(`"${member}" in launch-config.json is not a base58 address`);
  }
  if (members.length === 0) {
    throw new Error(`launch-config.json lists no admin keys for ${target.network.name}: add them before going on`);
  }
  if (members.length > MAX_ADMINS) throw new Error(`at most ${MAX_ADMINS} admin keys are supported`);
  if (new Set(members).size !== members.length) throw new Error("an admin key is listed twice");
  if (!Number.isInteger(entry.threshold) || entry.threshold < 1 || entry.threshold > members.length) {
    throw new Error(`a threshold of ${entry.threshold} cannot be met by ${members.length} admin key(s)`);
  }
  // One key that can change the fees and the treasury is not a multisig. Fine
  // for a test network, not for real money unless someone decides so knowingly.
  if (target.network.name === "mainnet" && entry.threshold < 2 && !options.allowSingleAdmin) {
    throw new Error(
      "this mainnet config could be changed by a single key. List at least two admin keys with a threshold " +
        "of two or more in deploy/launch-config.json, or pass --allow-single-admin to accept that.",
    );
  }
  return { members, threshold: entry.threshold };
}

function buildConfig(
  target: Target,
  treasury: Address,
  quotes: (QuoteFileEntry & { mint: Address })[],
  options: ConfigOptions,
): ConfigData {
  const file = readJson<LaunchConfigFile>(join(REPO_ROOT, "deploy", "launch-config.json"));
  const timelockSecs = file.timelockSecs[target.network.name];
  if (timelockSecs === undefined) throw new Error(`launch-config.json has no timelock for ${target.network.name}`);
  if (quotes.length > MAX_QUOTE_ASSETS) throw new Error(`at most ${MAX_QUOTE_ASSETS} quote assets are supported`);

  const launch: LaunchParams = {
    ...file.launch,
    totalSupply: BigInt(file.launch.totalSupply),
    curveSupply: BigInt(file.launch.curveSupply),
    virtualTokenReserves: BigInt(file.launch.virtualTokenReserves),
  };
  const slots: QuoteAsset[] = quotes.map((quote) => ({
    mint: quote.mint,
    virtualQuoteReserves: BigInt(quote.virtualQuoteReserves),
  }));
  // Catch a bad shape here, with a readable message, rather than on chain.
  for (const [i, slot] of slots.entries()) {
    try {
      validateCurveParams(launchCurveParams(launch, slot));
    } catch {
      throw new Error(`the curve shape for ${quotes[i]!.symbol} is invalid: check launch-config.json and the quotes file`);
    }
  }
  while (slots.length < MAX_QUOTE_ASSETS) slots.push({ mint: EMPTY_ADDRESS, virtualQuoteReserves: 0n });
  return { admins: readAdmins(target, file, options), treasury, timelockSecs, launch, quotes: slots };
}

async function resolveQuotes(
  target: Target,
  client: ArchpadClient,
  log: Log,
  allowUnconfirmed: boolean,
): Promise<(QuoteFileEntry & { mint: Address })[]> {
  const path = join(REPO_ROOT, "deploy", `quotes.${target.network.name}.json`);
  const entries = readJson<{ quotes: QuoteFileEntry[] }>(path).quotes;
  const resolved: (QuoteFileEntry & { mint: Address })[] = [];

  for (const entry of entries) {
    let mint = entry.mint;
    if (entry.devMint) {
      if (target.network.name !== "localnet") throw new Error("test assets can only be created on a local chain");
      const signer = devMintSigner(entry.devMint);
      if (await ensureMint(client, target.keys.authority, signer, entry.decimals)) {
        log(`created test asset ${entry.symbol} at ${signer.address}`);
      }
      mint = signer.address;
    }
    if (!mint) throw new Error(`quote ${entry.symbol} has neither a mint nor a devMint`);
    if (entry.unconfirmed && !allowUnconfirmed) {
      throw new Error(
        `the ${entry.symbol} mint in ${path} is marked unconfirmed. Confirm it is the right asset, ` +
          `then remove the flag or pass --allow-unconfirmed.`,
      );
    }

    // A coin priced in the wrong asset cannot be repriced later, so check the
    // mint is real and has the decimals the curve shape assumes.
    const account = await target.rpc.getAccount(mint);
    if (!account || account.owner !== TOKEN_PROGRAM_ID) {
      throw new Error(`${entry.symbol} mint ${mint} is not a token mint on ${target.network.name}`);
    }
    const onChain = decodeMint(account.data);
    if (onChain.decimals !== entry.decimals) {
      throw new Error(`${entry.symbol} mint has ${onChain.decimals} decimals on chain, not ${entry.decimals}`);
    }
    // Every coin's reserves sit in token accounts of its quote asset, so what
    // that asset's issuer can do matters to everyone who trades here.
    if (target.network.name !== "localnet") {
      if (onChain.freezeAuthority) {
        log(
          `warning: ${entry.symbol} has a freeze authority (${onChain.freezeAuthority}). Its holder can freeze ` +
            `any account of this asset, including a coin's reserves and the fee vaults.`,
        );
      }
      if (onChain.mintAuthority) {
        log(`note: ${entry.symbol} can still be minted by ${onChain.mintAuthority}`);
      }
    }
    resolved.push({ ...entry, mint });
  }
  return resolved;
}

/**
 * Sets a network up for the launchpad: quote assets, the config account, and
 * the platform's fee vault for each quote asset. Safe to re-run.
 */
export async function bootstrap(target: Target, options: ConfigOptions, log: Log): Promise<Deployment> {
  assertKeysMatchBuild(target);
  const client = new ArchpadClient(target.rpc);
  const authority = target.keys.authority;
  await ensureLamports(target, 500_000n, log);

  const quotes = await resolveQuotes(target, client, log, options.allowUnconfirmed ?? false);

  let config = await client.getConfig();
  if (!config) {
    const treasury = options.treasury ?? authority.address;
    if (!options.treasury && target.network.name !== "localnet") {
      log("warning: no --treasury given; platform fees will be payable to the authority key");
    }
    const data = buildConfig(target, treasury, quotes, options);
    await client.sendAndConfirm([client.instructions.initializeConfig(authority.address, data)], [authority]);
    config = await client.getConfig();
    if (!config) throw new Error("config account was not created");
    log(`config initialised at ${client.addresses.config()}`);
  } else {
    log(`config already initialised at ${client.addresses.config()}`);
  }

  for (const quote of configuredQuotes(config.active)) {
    const vault = client.addresses.platformVault(quote.mint);
    if (await target.rpc.getAccount(vault)) continue;
    await client.sendAndConfirm([client.instructions.initPlatformVault(authority.address, quote.mint)], [authority]);
    log(`platform fee vault created for ${quote.mint}`);
  }

  const known = new Map(quotes.map((quote) => [quote.mint, quote]));
  const published: QuoteAssetInfo[] = [];
  for (const quote of configuredQuotes(config.active)) {
    const info = known.get(quote.mint);
    const account = await target.rpc.getAccount(quote.mint);
    published.push({
      symbol: info?.symbol ?? quote.mint.slice(0, 4),
      name: info?.name ?? quote.mint,
      mint: quote.mint,
      decimals: account ? decodeMint(account.data).decimals : (info?.decimals ?? 0),
    });
  }

  const deployment: Deployment = {
    network: target.network.name,
    rpcUrl: target.network.rpcUrl,
    bitcoinNetwork: target.network.bitcoinNetwork,
    programs: { ...DEFAULT_PROGRAM_IDS },
    quotes: published,
    // Nothing of ours exists before the config does, so indexing can start here.
    startHeight: Math.max(0, (await target.rpc.getBlockCount()) - 2_000),
  };
  writeDeployment(deployment);
  log(`wrote deploy/${target.network.name}.json`);
  return deployment;
}

/** A human-readable summary of what is deployed and how it is configured. */
export async function status(target: Target, log: Log): Promise<void> {
  const client = new ArchpadClient(target.rpc);
  log(`network   ${target.network.name}  ${target.network.rpcUrl}  (node ${await target.rpc.getVersion()})`);
  log(`height    ${await target.rpc.getBlockCount()}`);

  log("programs");
  for (const name of PROGRAM_NAMES) {
    const address = DEFAULT_PROGRAM_IDS[name];
    const account = await target.rpc.getAccount(address);
    if (!account) {
      log(`  ${name.padEnd(7)} ${address}  not deployed`);
      continue;
    }
    const state = decodeProgramState(account.data);
    const mutability = state.isFinalized ? "immutable" : `upgradeable by ${state.authority}`;
    log(`  ${name.padEnd(7)} ${address}  ${account.isExecutable ? "live" : "not executable"}, ${mutability}`);
  }

  const config = await client.getConfig();
  if (!config) {
    log("config    not initialised");
    return;
  }
  describeConfig(config, log);
  for (const quote of configuredQuotes(config.active)) {
    const fees = await client.getUnwithdrawnPlatformFees(quote.mint);
    log(`  platform fees waiting in ${quote.mint}: ${fees}`);
  }

  const now = await target.rpc.getChainTime();
  const open = (await client.getProposals()).filter((proposal) => {
    const state = proposalState(proposal, config, now).status;
    return state !== "executed" && state !== "stale";
  });
  if (open.length > 0) {
    log("open proposals");
    for (const proposal of open) log(`  ${describeProposal(proposal, config, now)}`);
  }
}

function describeConfig(config: GlobalConfig, log: Log): void {
  const { launch, admins } = config.active;
  log(`config    ${admins.threshold} of ${admins.members.length} admin key(s) must approve a change`);
  for (const member of admins.members) log(`  admin ${member}`);
  log(`  treasury ${config.active.treasury}, config changes wait ${config.active.timelockSecs}s after approval`);
  log(`  launches ${config.launchesPaused ? "PAUSED" : "open"}`);
  log(
    `  curve fee ${launch.platformFeeBps + launch.creatorFeeBps} bps ` +
      `(platform ${launch.platformFeeBps}, creator ${launch.creatorFeeBps}); ` +
      `pool fee ${launch.poolLpFeeBps + launch.poolPlatformFeeBps + launch.poolCreatorFeeBps} bps`,
  );
  log(
    `  creator must buy >= ${launch.minCreatorBuyBps} bps; wallet cap ${launch.earlyWalletCapBps} bps ` +
      `for the first ${launch.earlyWindowSecs}s`,
  );
  for (const quote of configuredQuotes(config.active)) {
    const paused = (config.pausedQuotes & (1 << quote.index)) !== 0;
    const target = graduationQuote(launchCurveParams(launch, quote));
    log(`  quote ${quote.mint}: graduates at ${target} base units raised${paused ? " (PAUSED)" : ""}`);
  }
}

function describeAction(action: AdminAction): string {
  switch (action.type) {
    case "SetConfig":
      return "replace the config";
    case "SetLaunchesPaused":
      return action.paused ? "pause new launches" : "resume new launches";
    case "SetQuotePaused":
      return `${action.paused ? "pause" : "resume"} launches against ${action.mint}`;
  }
}

const isoTime = (unixSeconds: bigint) => new Date(Number(unixSeconds) * 1000).toISOString();

function describeProposal(proposal: Proposal, config: GlobalConfig, now: bigint): string {
  const state = proposalState(proposal, config, now);
  const standing = (() => {
    switch (state.status) {
      case "executed":
        return `executed ${isoTime(state.at)}`;
      case "stale":
        return "retired: the config was replaced after it was made";
      case "needs-approvals":
        return `${state.have} of ${state.need} approvals`;
      case "waiting":
        return `approved; can be executed from ${isoTime(state.readyAt)}`;
      case "ready":
        return "approved and ready to execute";
    }
  })();
  return `#${proposal.id} ${describeAction(proposal.action)} — ${standing}`;
}

/** Lists every proposal, newest first. */
export async function listProposals(target: Target, log: Log): Promise<void> {
  const client = new ArchpadClient(target.rpc);
  const config = await client.getConfig();
  if (!config) throw new Error("config is not initialised: run bootstrap first");
  const proposals = await client.getProposals();
  if (proposals.length === 0) {
    log("no proposals have been made");
    return;
  }
  const now = await target.rpc.getChainTime();
  for (const proposal of proposals) {
    log(describeProposal(proposal, config, now));
    if (proposal.epoch === config.epoch && proposal.executedAt === 0n) {
      for (const approver of approvers(proposal, config.active.admins)) log(`    approved by ${approver}`);
    }
  }
}

/**
 * Proposes an admin action as `admin`. If that one approval is enough and
 * nothing makes the action wait, it is executed in the same transaction.
 */
async function proposeAction(target: Target, admin: Signer, action: AdminAction, log: Log): Promise<bigint> {
  const client = new ArchpadClient(target.rpc);
  const plan = await client.planProposal(admin.address, action);
  await client.sendAndConfirm(plan.instructions, [admin]);
  if (plan.executes) {
    log(`proposal #${plan.id}: ${describeAction(action)} — done`);
  } else {
    const config = (await client.getConfig())!;
    const proposal = (await client.getProposal(plan.id))!;
    log(describeProposal(proposal, config, await target.rpc.getChainTime()));
    log(`  other admins approve with: pnpm ops approve ${plan.id} --network ${target.network.name} --signer <key file>`);
  }
  return plan.id;
}

/** Proposes pausing or resuming new launches. */
export async function setPaused(target: Target, admin: Signer, paused: boolean, log: Log): Promise<bigint> {
  return proposeAction(target, admin, { type: "SetLaunchesPaused", paused }, log);
}

/** Proposes pausing or resuming new launches against one quote asset. */
export async function setQuotePaused(
  target: Target,
  admin: Signer,
  mint: Address,
  paused: boolean,
  log: Log,
): Promise<bigint> {
  return proposeAction(target, admin, { type: "SetQuotePaused", mint, paused }, log);
}

/**
 * The config that `deploy/launch-config.json` and the network's quotes file
 * describe. The treasury stays as it is on chain unless one is given.
 */
export async function desiredConfig(target: Target, options: ConfigOptions, log: Log): Promise<ConfigData> {
  const client = new ArchpadClient(target.rpc);
  const current = await client.getConfig();
  const quotes = await resolveQuotes(target, client, log, options.allowUnconfirmed ?? false);
  const treasury = options.treasury ?? current?.active.treasury ?? target.keys.authority.address;
  return buildConfig(target, treasury, quotes, options);
}

/** Proposes the config in `deploy/launch-config.json` and the quotes file. */
export async function proposeConfig(target: Target, admin: Signer, options: ConfigOptions, log: Log): Promise<bigint> {
  const client = new ArchpadClient(target.rpc);
  if (!(await client.getConfig())) throw new Error("config is not initialised: run bootstrap first");
  const config = await desiredConfig(target, options, log);
  return proposeAction(target, admin, { type: "SetConfig", config }, log);
}

/** Adds `admin`'s approval to a proposal. */
export async function approveProposal(target: Target, admin: Signer, id: bigint, log: Log): Promise<void> {
  const client = new ArchpadClient(target.rpc);
  await client.sendAndConfirm([client.instructions.approve(admin.address, id)], [admin]);
  const [config, proposal] = [await client.getConfig(), await client.getProposal(id)];
  log(describeProposal(proposal!, config!, await target.rpc.getChainTime()));
}

/** Withdraws `admin`'s approval from a proposal. */
export async function revokeApproval(target: Target, admin: Signer, id: bigint, log: Log): Promise<void> {
  const client = new ArchpadClient(target.rpc);
  await client.sendAndConfirm([client.instructions.revoke(admin.address, id)], [admin]);
  const [config, proposal] = [await client.getConfig(), await client.getProposal(id)];
  log(describeProposal(proposal!, config!, await target.rpc.getChainTime()));
}

/** Carries out an approved proposal. Anyone can pay for this; `payer` only covers the fee. */
export async function executeProposal(target: Target, payer: Signer, id: bigint, log: Log): Promise<void> {
  const client = new ArchpadClient(target.rpc);
  const proposal = await client.getProposal(id);
  if (!proposal) throw new Error(`there is no proposal #${id}`);
  await client.sendAndConfirm([client.instructions.execute(id)], [payer]);
  log(`proposal #${id}: ${describeAction(proposal.action)} — done`);
}

/** Sends every platform fee vault's balance to the treasury. Anyone can run this. */
export async function withdrawPlatformFees(target: Target, log: Log): Promise<void> {
  const client = new ArchpadClient(target.rpc);
  const payer = target.keys.authority;
  const config = await client.getConfig();
  if (!config) throw new Error("config is not initialised");
  for (const quote of configuredQuotes(config.active)) {
    const amount = await client.getUnwithdrawnPlatformFees(quote.mint);
    if (amount === 0n) {
      log(`${quote.mint}: nothing to withdraw`);
      continue;
    }
    const destination = associatedTokenAddress(config.active.treasury, quote.mint);
    await client.sendAndConfirm(
      [
        createAssociatedTokenAccountIdempotent(payer.address, config.active.treasury, quote.mint),
        client.instructions.withdrawPlatformFees(quote.mint, destination),
      ],
      [payer],
    );
    log(`${quote.mint}: sent ${amount} to the treasury`);
  }
}

/**
 * Makes all four programs immutable. After this nobody can change them, the
 * authority included. There is no undo.
 */
export async function finalizePrograms(target: Target, log: Log): Promise<void> {
  assertKeysMatchBuild(target);
  const client = new ArchpadClient(target.rpc);
  const authority = target.keys.authority;
  for (const name of PROGRAM_NAMES) {
    const program = target.keys.programs[name];
    const account = await target.rpc.getAccount(program.address);
    if (!account) throw new Error(`${name} is not deployed`);
    if (decodeProgramState(account.data).isFinalized) {
      log(`${name.padEnd(7)} already immutable`);
      continue;
    }
    await client.sendAndConfirm(
      [loaderFinalize(program.address, authority.address, program.address)],
      [authority, program],
    );
    log(`${name.padEnd(7)} is now immutable`);
  }
}
