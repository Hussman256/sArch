# Archpad

A meme coin launchpad for [Arch](https://arch.network), built from the PRD "Bitcoin-Native Meme Launchpad on Arch".

Anyone can launch a coin for free. It trades on a bonding curve priced in bitcoin or dollars, and when the curve sells out it graduates, in that same transaction, into a liquidity pool nobody can withdraw from. Every trade pays a 2.25% fee: 1% to the platform and 1.25% to the coin's creator.

**Status:** everything runs and is tested against a local Arch chain (validator 0.12.0). Nothing has been deployed to a public network. See [What is and is not verified](#what-is-and-is-not-verified) before relying on it.

## What is in the repository

| Path | What it is |
| --- | --- |
| `crates/archpad-math` | The curve, pool and fee arithmetic. Pure integer Rust with no dependencies, tested with properties and 3,154 golden vectors. |
| `crates/archpad-interface` | Account layouts, instructions, addresses, events and error codes shared by the programs and their clients. |
| `crates/archpad-program-lib` | Account checks the four programs share. |
| `programs/config` | The one account holding every tunable, and the rules for changing it: M-of-N admin approval plus a timelock. |
| `programs/launch` | Creates coins and runs their bonding curves. |
| `programs/fees` | Holds trade fees until creators claim theirs and the platform's share goes to the treasury. |
| `programs/pool` | The locked-liquidity pool a curve graduates into. It has two instructions, open and swap, and no way to remove liquidity. |
| `packages/sdk` | TypeScript client: transaction format, wallet signatures, instruction builders, account decoders, and the same math as the Rust crate. |
| `packages/ops` | Command line for deploying and governing (`pnpm ops ...`). |
| `packages/indexer` | Follows the chain, stores coins and trades in Postgres, and serves the API and live stream the web app uses. |
| `apps/web` | The web app (Next.js): coin lists, coin page with chart and trade box, launch form, profile, admin dashboard. |
| `tests/e2e` | End-to-end tests that drive every flow against a running local chain. |
| `scripts/` | Toolchain setup, program build, local chain, program keys. |
| `deploy/` | What new coins launch with (`launch-config.json`) and each network's quote assets. |

## Run it locally

You need Node 22+, pnpm and Rust. Building the programs and running the local chain need Linux; on Windows use WSL 2 (Ubuntu) for the three `scripts/*.sh` steps and run everything else from either side.

```sh
pnpm install
node scripts/program-keys.mjs dev      # public development keys, for a local chain only

# In Linux or WSL:
scripts/setup-toolchain.sh             # once: Rust, Agave 3.1.9 (cargo build-sbf)
scripts/build-programs.sh              # builds programs/target/deploy/*.so
scripts/localnet.sh setup              # once: Arch validator, Bitcoin Core, Titan (builds from source, ~20 min)
scripts/localnet.sh run                # starts the chain and stays attached; Ctrl-C stops it

# In another terminal:
pnpm ops deploy                        # deploys the four programs
pnpm ops bootstrap                     # creates the config, test BTC and USD, and the fee vaults
pnpm dev:indexer                       # API on http://localhost:8787
pnpm dev:web                           # app on http://localhost:3210
```

In the app, choose **Connect wallet → Test wallet**, then **Get test funds** from the wallet menu. That gives the wallet one test bitcoin, ten thousand test dollars and enough ARCH for fees.

`pnpm ops status` shows what is deployed and how it is configured. `pnpm ops --help` lists every command.

## Tests

```sh
pnpm test:rust     # 103 tests: math properties and vectors, layouts, governance rules
pnpm test          # 115 tests: SDK against Rust-generated fixtures, indexer, web app logic
pnpm e2e           # 47 tests against the local chain; needs it running, deployed and bootstrapped
```

The end-to-end suite is the one that matters most. It launches, trades, graduates, claims and governs through the real validator, and checks each PRD requirement where it is enforced. The file names follow the PRD's modules:

| File | Covers |
| --- | --- |
| `01-launch` | One signed transaction; no creation fee; fixed supply, no mint or freeze authority; quote asset choice; creator's mandatory buy; griefing by pre-funding addresses |
| `02-trading` | Quotes match the chain to the base unit; slippage limit; 2% wallet cap in the first 10 seconds; flat fee for early buyers; events survive log truncation and cannot be forged |
| `03-graduation` | Pool opens inside the buy that sells the last token; reserves move in full; no graduation fee; liquidity has no owner key; a failed graduation undoes the whole buy |
| `04-fees` | Creator fees accrue per coin and are claimable any time, before and after graduation; platform fees can only go to the treasury |
| `05-admin` | Two-of-three multisig with a timelock; pause stops launches but not trading; a fee change reaches only coins launched after it |
| `06-indexer` | The indexer's view of every coin matches the chain's accounts; live stream; holders; wallet profile |
| `07-immutability` | A finalized program can never be changed again |

## How it works

**One config.** Fees, the curve's shape, the creator's minimum buy, the wallet cap and window, the quote assets and the admin keys all live in one account. The launch program copies what a coin needs into its curve when the coin is created, so a later change reaches new coins only.

**The curve** is a constant-product curve with virtual reserves. A coin has a fixed supply of 1 billion; 79.31% is sold on the curve and the rest is held back for the pool. The fee is charged on the quote amount, on top for buys and out of the proceeds for sells. Rounding always favours the curve, so it can always pay out what it owes.

**Launch** is one instruction: create the mint, mint the whole supply into the curve's vault, give up the mint authority, write the metadata as immutable, and make the creator's own first buy through the same code path as every other buy.

**Graduation** happens inside the buy that takes the last curve token. That buy calls the pool program, which creates the pool and pulls the curve's reserves into it. If any of that fails, the buy fails with it and the curve is untouched. The pool's token accounts are owned by an address only the pool program can sign for, and the pool program has no instruction that pays liquidity out.

**Events** are not log lines. A node keeps only the first 10 KB of a transaction's log, so a trade's log line can be pushed past the cut by packing other output into the same transaction (eight buys in one transaction is enough; this was reproduced). Each program instead calls itself with the event as instruction data, signed by an address only it can sign for. Nodes record those inner calls in full, and that is what the indexer reads.

**Governance.** The config names up to eight admin keys and a threshold. An admin proposes an action; others approve in their own transactions; once enough have, anyone can execute it. Replacing the config also waits out a timelock that starts when the last needed approval lands. The complete list of actions is: replace the config, pause or resume new launches, pause or resume one quote asset. None of them moves funds or touches a coin that exists.

Program code is a separate matter: whoever holds a program's upgrade authority could replace it. `pnpm ops finalize-programs` makes all four permanently immutable. Until that is run, the upgrade key is trusted.

**The indexer** reads finalized blocks only, applies each block and its cursor in one database transaction, and derives everything from events. Holder lists and wallet balances are read from the chain's token accounts, because balances change with transfers the launchpad never sees.

**Wallets.** An Arch account is a taproot key, and a transaction is authorised by a BIP-322 signature over its hash. The app has adapters for Xverse and UniSat and a throwaway test wallet for test networks. It never holds a key.

### Measured on the local validator

| Transaction | Compute units | Limit requested |
| --- | --- | --- |
| Launch (with creator's buy) | 190,000 | 400,000 |
| Curve buy | 51,000 (+13,000 if it creates the buyer's token account) | 300,000 |
| Curve sell | 48,000 | default |
| Buy that graduates the coin | 130,000 | 300,000 |
| Pool swap | 46,000 | default |

A launch costs the creator about 12,000 lamports of ARCH in network fee and account rent, plus their own first buy. There is no platform fee for launching.

## Deploying to a public network

Nothing here has been deployed publicly. The steps are:

```sh
node scripts/program-keys.mjs generate testnet   # new keys under keys/testnet (never committed)
node scripts/program-keys.mjs use testnet        # writes the new program IDs into the code
scripts/build-programs.sh                        # rebuild: the IDs are compiled in
# edit deploy/launch-config.json: admin keys and threshold for the network
# check deploy/quotes.testnet.json: the aBTC mint there is unconfirmed
pnpm ops deploy --network testnet
pnpm ops bootstrap --network testnet --treasury <address>
```

The deploy tool refuses to use the public development keys anywhere but a local chain, and refuses a mainnet config that a single key could change unless told otherwise.

Things to settle first:

- **Mainnet runs a different version.** On 2026-10-11 the mainnet RPC reported node 0.10.0 and testnet 0.12.0. Version 0.12 changed how programs receive their accounts, so these programs, built against 0.12, will not run on a 0.10 chain. They need mainnet to upgrade, or a port.
- **Mainnet deployment may need permission.** Arch's own documentation leaves open whether anyone can deploy programs to mainnet.
- **Fees are paid in ARCH.** Every wallet needs a little ARCH to transact, and there is no documented way for a new user to get it on mainnet. This is the largest onboarding gap.
- **Quote assets.** On mainnet, aBTC and aUSD have no freeze authority (checked on chain), so their issuers cannot freeze a coin's reserves. Both can still be minted by their issuers, as bridged assets normally can. `bootstrap` reports this for whatever assets it is given.
- **An audit.** The programs hold other people's money and have not been audited.

## What is and is not verified

Verified by running it against the local validator: every flow in the tests above, program upgrades, program finalization, the indexer against real blocks, and the web app's launch, buy, sell, claim and admin pages with the test wallet.

Not verified:

- **Real wallets.** The Xverse and UniSat adapters follow those wallets' documented interfaces but have not been run against the extensions. The app checks every signature locally before sending, so a wallet that signs differently fails with a clear message rather than a rejected transaction.
- **Public networks.** Behaviour on testnet (finality lag, load, RPC limits) has only been observed read-only.
- **Scale.** Holder lists ask the node for a mint's token accounts. That is fast on a small chain and untested on a large one. The API and the web app's chain proxy have no rate limiting of their own beyond uploads; put that in front of them.
- **Graduating into Arch Swap.** The PRD's first choice was Arch Swap's pool, with its own pool as the fallback. Arch Swap's AMM is closed source, upgradeable by a single key, has no native liquidity lock, and creating a position needs more accounts than fit in the same transaction as the buy. This build uses the fallback. An adapter can be added if the Arch team confirms the interface.

## Design decisions that differ from the PRD

- **Own pool, not Arch Swap**, for the reasons above.
- **The multisig is built in.** The PRD assumes a multisig controls the config. The Squads port for Arch is not deployed on either public network, so the approval flow lives in the config program.
- **Graduation target.** The PRD left it open. The defaults raise about 0.142 BTC or 12,750 USD on the curve, in line with comparable launchpads. Change `virtualQuoteReserves` in the quotes files to move it.
- **Pool fee.** The PRD does not set one. The default is 0.30% (0.20% stays in the pool, 0.05% platform, 0.05% creator). It is in `launch-config.json`.
