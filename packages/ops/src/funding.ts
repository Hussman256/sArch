/**
 * Getting lamports and test tokens into accounts on networks that have a
 * faucet.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  type Address,
  type ArchRpc,
  type Instruction,
  type Signer,
  type Transaction,
  ArchpadClient,
  MINT_LEN,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  keypairSigner,
  minimumRent,
  signingPayload,
  systemCreateAccount,
  tokenInitializeMint,
  tokenMintTo,
} from "@archpad/sdk";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function lamportsOf(rpc: ArchRpc, address: Address): Promise<bigint> {
  return (await rpc.getAccount(address))?.lamports ?? 0n;
}

/**
 * Tops an account up to at least `target` lamports from the node's faucet,
 * creating it first if needed. Only works on networks that have a faucet.
 */
export async function fundFromFaucet(rpc: ArchRpc, signer: Signer, target: bigint): Promise<bigint> {
  let balance = await lamportsOf(rpc, signer.address);

  if ((await rpc.getAccount(signer.address)) === null) {
    // The faucet returns a transaction that creates and funds the account,
    // already signed by the faucet. The new account adds its own signature.
    const transaction: Transaction = await rpc.createAccountWithFaucet(signer.address);
    transaction.signatures.push(await signer.sign(signingPayload(transaction.message)));
    await rpc.confirmTransaction(await rpc.sendTransaction(transaction));
    balance = await lamportsOf(rpc, signer.address);
  }

  // Each airdrop is a fixed amount, so repeat until the target is met. Give up
  // if a request stops moving the balance rather than loop forever.
  for (let attempt = 0; balance < target && attempt < 400; attempt++) {
    const before = balance;
    const reply = await rpc.requestAirdrop(signer.address);
    if (typeof reply === "string" && /^[0-9a-f]{64}$/.test(reply)) {
      await rpc.confirmTransaction(reply).catch(() => undefined);
    }
    for (let wait = 0; wait < 40; wait++) {
      balance = await lamportsOf(rpc, signer.address);
      if (balance > before) break;
      await sleep(100);
    }
    if (balance === before) throw new Error("the faucet accepted a request but sent nothing");
  }
  return balance;
}

/** The fixed, public key behind a local test asset. Local chains only. */
export function devMintSigner(symbol: string): Signer {
  return keypairSigner(sha256(new TextEncoder().encode(`archpad public dev key: ${symbol} mint`)));
}

/** Creates a token mint at `mint`'s address if it does not exist yet. */
export async function ensureMint(
  client: ArchpadClient,
  payer: Signer,
  mint: Signer,
  decimals: number,
): Promise<boolean> {
  if (await client.rpc.getAccount(mint.address)) return false;
  await client.sendAndConfirm(
    [
      systemCreateAccount(payer.address, mint.address, minimumRent(MINT_LEN), BigInt(MINT_LEN), TOKEN_PROGRAM_ID),
      tokenInitializeMint(mint.address, payer.address, decimals),
    ],
    [payer, mint],
  );
  return true;
}

/** Mints `amount` of a test asset into `wallet`'s token account, creating the account if needed. */
export async function mintTestTokens(
  client: ArchpadClient,
  mintAuthority: Signer,
  mint: Address,
  wallet: Address,
  amount: bigint,
): Promise<void> {
  const instructions: Instruction[] = [
    createAssociatedTokenAccountIdempotent(mintAuthority.address, wallet, mint),
    tokenMintTo(mint, associatedTokenAddress(wallet, mint), mintAuthority.address, amount),
  ];
  await client.sendAndConfirm(instructions, [mintAuthority]);
}
