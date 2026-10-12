/**
 * Command line for operating the launchpad.
 *
 *   pnpm ops <command> [--network localnet|testnet|mainnet] [--rpc URL] [--keys NAME]
 */
import { ArchpadClient, isAddress, systemTransfer } from "@archpad/sdk";
import { fundFromFaucet, lamportsOf, mintTestTokens } from "./funding.ts";
import { loadSigner, parseArgs, readDeployment, resolveTarget } from "./network.ts";
import {
  approveProposal,
  bootstrap,
  deployPrograms,
  executeProposal,
  finalizePrograms,
  listProposals,
  proposeConfig,
  revokeApproval,
  setPaused,
  setQuotePaused,
  status,
  withdrawPlatformFees,
} from "./operations.ts";

const USAGE = `Usage: pnpm ops <command> [options]

Setup
  deploy                 Deploy the four programs (skips any already up to date)
  bootstrap              Create the config account and the platform fee vaults
                           --treasury <address>   wallet that receives platform fees
                           --allow-unconfirmed    accept quote mints marked unconfirmed
                           --allow-single-admin   accept a mainnet config one key can change
  status                 Show what is deployed, how it is configured, and open proposals
  fund <address>         Local chain only: send lamports and test assets to a wallet
                           --lamports <n>         default 10000000
                           --tokens <n>           whole units of each test asset, default 10

Governance (each admin signs with their own key; see --signer)
  pause | unpause        Propose stopping or resuming new launches
                           --quote <mint>         only launches against this quote asset
  propose-config         Propose deploy/launch-config.json and the quotes file as the config
  proposals              List every proposal and where it stands
  approve <number>       Add your approval to a proposal
  revoke <number>        Withdraw your approval from a proposal
  execute <number>       Carry out a proposal that has enough approvals and has waited
                         out the timelock. Needs no admin key.

  A proposal carries its proposer's approval. When that is all the config asks
  for and nothing makes the action wait, proposing also executes it.

Other
  withdraw-fees          Send accrued platform fees to the treasury
  finalize-programs      Make all four programs immutable, permanently
                           --yes-make-immutable   required confirmation

Options
  --network <name>       localnet (default), testnet or mainnet
  --rpc <url>            override the network's RPC endpoint
  --keys <name>          key set under keys/ (default: dev on localnet)
  --signer <file>        key file to sign governance commands with
                         (default: the key set's authority key)
`;

const log = (line: string) => console.log(line);

async function main(): Promise<void> {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || options["help"]) {
    console.log(USAGE);
    return;
  }
  const target = resolveTarget(options);
  const configOptions = {
    ...(options["treasury"] ? { treasury: options["treasury"] } : {}),
    allowUnconfirmed: options["allow-unconfirmed"] === "true",
    allowSingleAdmin: options["allow-single-admin"] === "true",
  };
  if (configOptions.treasury && !isAddress(configOptions.treasury)) {
    throw new Error("--treasury must be a base58 address");
  }
  // Governance commands are signed by one admin at a time. Each admin runs
  // the command with their own key file.
  const signer = () => (options["signer"] ? loadSigner(options["signer"]) : target.keys.authority);
  const proposalNumber = (): bigint => {
    const raw = positional[1];
    if (!raw || !/^\d+$/.test(raw)) throw new Error(`usage: ${command} <proposal number>`);
    return BigInt(raw);
  };

  switch (command) {
    case "deploy":
      return deployPrograms(target, log);
    case "bootstrap":
      await bootstrap(target, configOptions, log);
      return;
    case "status":
      return status(target, log);
    case "pause":
    case "unpause": {
      const paused = command === "pause";
      const quote = options["quote"];
      if (quote === undefined) {
        await setPaused(target, signer(), paused, log);
      } else {
        if (!isAddress(quote)) throw new Error("--quote must be a base58 mint address");
        await setQuotePaused(target, signer(), quote, paused, log);
      }
      return;
    }
    case "propose-config":
      await proposeConfig(target, signer(), configOptions, log);
      return;
    case "proposals":
      return listProposals(target, log);
    case "approve":
      return approveProposal(target, signer(), proposalNumber(), log);
    case "revoke":
      return revokeApproval(target, signer(), proposalNumber(), log);
    case "execute":
      return executeProposal(target, signer(), proposalNumber(), log);
    case "withdraw-fees":
      return withdrawPlatformFees(target, log);
    case "finalize-programs":
      if (options["yes-make-immutable"] !== "true") {
        throw new Error(
          "finalizing is permanent: nobody will be able to change or fix the programs afterwards. " +
            "Re-run with --yes-make-immutable to proceed.",
        );
      }
      return finalizePrograms(target, log);
    case "fund": {
      const address = positional[1];
      if (!address || !isAddress(address)) throw new Error("usage: fund <base58 address>");
      if (target.network.name !== "localnet") throw new Error("fund only works on a local chain");
      const client = new ArchpadClient(target.rpc);
      const authority = target.keys.authority;
      const lamports = BigInt(options["lamports"] ?? "10000000");
      await fundFromFaucet(target.rpc, authority, lamports + 1_000_000n);
      await client.sendAndConfirm([systemTransfer(authority.address, address, lamports)], [authority]);
      log(`${address} now holds ${await lamportsOf(target.rpc, address)} lamports`);

      const deployment = readDeployment("localnet");
      if (!deployment) throw new Error("run bootstrap first");
      const units = BigInt(options["tokens"] ?? "10");
      for (const quote of deployment.quotes) {
        await mintTestTokens(client, authority, quote.mint, address, units * 10n ** BigInt(quote.decimals));
        log(`minted ${units} ${quote.symbol} to ${address}`);
      }
      return;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
