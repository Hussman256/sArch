/**
 * Deploying programs: the loader's instructions and the sequence that puts a
 * compiled program on chain.
 *
 * A program lives in an account owned by the loader: a 40-byte header (its
 * authority and status) followed by the program's bytes. Deployment creates
 * the account, sizes it, writes the bytes in transaction-sized pieces, then
 * asks the loader to verify them and mark the account executable.
 */
import { SYSTEM_PROGRAM_ID } from "./addresses.ts";
import { type Address, ByteWriter, bytesEqual, bytesToAddress, hexToBytes } from "./bytes.ts";
import type { Signer } from "./client.ts";
import { setComputeUnitLimit, systemTransfer } from "./instructions.ts";
import type { ArchRpc } from "./rpc.ts";
import {
  type Instruction,
  type Transaction,
  compileMessage,
  signingPayload,
} from "./transaction.ts";

/** The program loader. */
export const LOADER_PROGRAM_ID: Address = "BpfLoader1111111111111111111111111111111111";
/** Bytes of loader header in front of a program's code. */
export const PROGRAM_DATA_OFFSET = 40;
/** Most program bytes one write transaction can carry. */
export const MAX_WRITE_LEN = 997;
/** Most transactions a node accepts in one `send_transactions` call. */
const MAX_BATCH = 100;

export const LoaderStatus = { Retracted: 0, Deployed: 1, Finalized: 2 } as const;

/** Lamports an account of `dataLength` bytes must hold to exist. */
export function minimumRent(dataLength: number): bigint {
  return BigInt((128 + dataLength) * 2);
}

const loaderInstruction = (
  accounts: Instruction["accounts"],
  data: Uint8Array,
): Instruction => ({ programId: LOADER_PROGRAM_ID, accounts, data });

/** Creates an account owned by `owner`, funded by `payer`. Both `payer` and the new account sign. */
export function systemCreateAccount(
  payer: Address,
  newAccount: Address,
  lamports: bigint,
  space: bigint,
  owner: Address,
): Instruction {
  return {
    programId: SYSTEM_PROGRAM_ID,
    accounts: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: newAccount, isSigner: true, isWritable: true },
    ],
    data: new ByteWriter().u32(0).u64(lamports).u64(space).address(owner).finish(),
  };
}

/** Sets the size of an undeployed program account. The first call also records its authority. */
export function loaderTruncate(program: Address, authority: Address, newSize: number): Instruction {
  return loaderInstruction(
    [
      { pubkey: program, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    new ByteWriter().u32(1).u32(newSize).finish(),
  );
}

/** Writes program bytes at `offset` into an undeployed program account. */
export function loaderWrite(program: Address, authority: Address, offset: number, bytes: Uint8Array): Instruction {
  return loaderInstruction(
    [
      { pubkey: program, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    new ByteWriter().u32(0).u32(offset).u64(BigInt(bytes.length)).bytes(bytes).finish(),
  );
}

/** Verifies a program account's bytes and makes it executable. */
export function loaderDeploy(program: Address, authority: Address): Instruction {
  return loaderInstruction(
    [
      { pubkey: program, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    new ByteWriter().u32(2).finish(),
  );
}

/** Takes a deployed program out of service so it can be rewritten. */
export function loaderRetract(program: Address, authority: Address): Instruction {
  return loaderInstruction(
    [
      { pubkey: program, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    new ByteWriter().u32(3).finish(),
  );
}

/** Hands control of a program to another key. The program, the old and the new authority all sign. */
export function loaderTransferAuthority(program: Address, authority: Address, newAuthority: Address): Instruction {
  return loaderInstruction(
    [
      { pubkey: program, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: newAuthority, isSigner: true, isWritable: false },
    ],
    new ByteWriter().u32(4).finish(),
  );
}

/**
 * Makes a program immutable, for good: after this nobody, its authority
 * included, can change or retract it. Pass the program itself as `nextVersion`.
 */
export function loaderFinalize(program: Address, authority: Address, nextVersion: Address): Instruction {
  return loaderInstruction(
    [
      { pubkey: program, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: nextVersion, isSigner: false, isWritable: false },
    ],
    new ByteWriter().u32(5).finish(),
  );
}

/** What the loader records at the front of a program account. */
export interface ProgramState {
  /** Who can manage the program, or its next version once finalized. */
  authority: Address;
  /** A {@link LoaderStatus}. */
  status: number;
  /** True once nothing about the program can change. */
  isFinalized: boolean;
}

/** Reads the loader header of a program account. */
export function decodeProgramState(data: Uint8Array): ProgramState {
  if (data.length < PROGRAM_DATA_OFFSET) throw new Error("not a program account");
  const status = Number(new DataView(data.buffer, data.byteOffset + 32, 8).getBigUint64(0, true));
  return {
    authority: bytesToAddress(data.subarray(0, 32)),
    status,
    isFinalized: status === LoaderStatus.Finalized,
  };
}

export interface DeployOptions {
  /** Called as the upload proceeds, with bytes written so far and in total. */
  onProgress?: (written: number, total: number) => void;
}

async function signWith(message: ReturnType<typeof compileMessage>, signers: Signer[]): Promise<Transaction> {
  const payload = signingPayload(message);
  const signatures: Uint8Array[] = [];
  for (const address of message.accountKeys.slice(0, message.header.numRequiredSignatures)) {
    const signer = signers.find((candidate) => candidate.address === address);
    if (!signer) throw new Error(`no signer provided for ${address}`);
    signatures.push(await signer.sign(payload));
  }
  return { version: 0, signatures, message };
}

async function finalizedBlockhash(rpc: ArchRpc): Promise<Uint8Array> {
  return hexToBytes(await rpc.getBestFinalizedBlockHash());
}

async function run(rpc: ArchRpc, instructions: Instruction[], payer: Signer, signers: Signer[]): Promise<void> {
  const message = compileMessage(instructions, payer.address, await finalizedBlockhash(rpc));
  await rpc.confirmTransaction(await rpc.sendTransaction(await signWith(message, signers)));
}

/**
 * Deploys `elf` to the address of `program`, paid for and controlled by
 * `authority`. Safe to re-run: it resumes or skips work already done, and
 * replaces the code if the account holds a different program.
 *
 * Returns true if anything was written, false if this exact program was
 * already deployed.
 */
export async function deployProgram(
  rpc: ArchRpc,
  program: Signer,
  authority: Signer,
  elf: Uint8Array,
  options: DeployOptions = {},
): Promise<boolean> {
  const size = PROGRAM_DATA_OFFSET + elf.length;
  let account = await rpc.getAccount(program.address);

  if (account && account.data.length >= PROGRAM_DATA_OFFSET) {
    const sameCode = bytesEqual(account.data.subarray(PROGRAM_DATA_OFFSET), elf);
    if (sameCode && account.isExecutable) return false;
    if (decodeProgramState(account.data).isFinalized) {
      throw new Error(`${program.address} is finalized and holds a different program`);
    }
    if (account.isExecutable) {
      await run(rpc, [loaderRetract(program.address, authority.address)], authority, [authority]);
      account = await rpc.getAccount(program.address);
    }
  }

  if (!account) {
    await run(
      rpc,
      [systemCreateAccount(authority.address, program.address, minimumRent(size), 0n, LOADER_PROGRAM_ID)],
      authority,
      [authority, program],
    );
    account = await rpc.getAccount(program.address);
    if (!account) throw new Error("program account was not created");
  }

  if (account.data.length !== size) {
    const shortfall = minimumRent(size) - account.lamports;
    if (shortfall > 0n) {
      await run(rpc, [systemTransfer(authority.address, program.address, shortfall)], authority, [authority]);
    }
    await run(
      rpc,
      [loaderTruncate(program.address, authority.address, elf.length)],
      authority,
      [authority, program],
    );
    account = await rpc.getAccount(program.address);
    if (!account) throw new Error("program account disappeared during deployment");
  }

  // Upload only the pieces that differ, so an interrupted deployment resumes.
  const onChain = account.data.subarray(PROGRAM_DATA_OFFSET);
  const pending: number[] = [];
  for (let offset = 0; offset < elf.length; offset += MAX_WRITE_LEN) {
    const chunk = elf.subarray(offset, offset + MAX_WRITE_LEN);
    if (!bytesEqual(chunk, onChain.subarray(offset, offset + chunk.length))) pending.push(offset);
  }

  let written = elf.length - pending.length * MAX_WRITE_LEN;
  for (let start = 0; start < pending.length; start += MAX_BATCH) {
    // A fresh blockhash per batch: a large upload outlives any single one.
    const blockhash = await finalizedBlockhash(rpc);
    const transactions = await Promise.all(
      pending.slice(start, start + MAX_BATCH).map((offset) =>
        signWith(
          compileMessage(
            [loaderWrite(program.address, authority.address, offset, elf.subarray(offset, offset + MAX_WRITE_LEN))],
            authority.address,
            blockhash,
          ),
          [authority],
        ),
      ),
    );
    const txids = await rpc.sendTransactions(transactions);
    for (const txid of txids) await rpc.confirmTransaction(txid, { timeoutMs: 120_000 });
    written = Math.min(elf.length, written + transactions.length * MAX_WRITE_LEN);
    options.onProgress?.(Math.max(written, 0), elf.length);
  }

  const uploaded = await rpc.getAccount(program.address);
  if (!uploaded || !bytesEqual(uploaded.data.subarray(PROGRAM_DATA_OFFSET), elf)) {
    throw new Error("program bytes on chain do not match after upload");
  }

  // Verification costs compute per byte; ask for the maximum, the node clamps it.
  await run(
    rpc,
    [setComputeUnitLimit(0xffff_ffff), loaderDeploy(program.address, authority.address)],
    authority,
    [authority],
  );
  const deployed = await rpc.getAccount(program.address);
  if (!deployed?.isExecutable) throw new Error("program did not become executable");
  return true;
}
