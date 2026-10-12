/**
 * Making a program immutable (the other half of AD-1).
 *
 * The config's admins cannot touch funds, but whoever holds a program's
 * upgrade authority could replace its code. `pnpm ops finalize-programs`
 * closes that door for good. This test proves the door really shuts, using a
 * throwaway copy of a program so the real ones stay upgradeable for
 * development.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type Signer,
  decodeProgramState,
  deployProgram,
  keypairSigner,
  loaderFinalize,
  loaderRetract,
  loaderTransferAuthority,
  loaderWrite,
  PROGRAM_DATA_OFFSET,
  systemTransfer,
} from "@archpad/sdk";
import { REPO_ROOT, fundFromFaucet } from "@archpad/ops";
import { type Chain, connect, expectFailure } from "../src/harness.ts";

let chain: Chain;
let program: Signer;
let elf: Uint8Array;

beforeAll(async () => {
  chain = await connect();
  program = keypairSigner(randomBytes(32));
  // The pool program is the one whose immutability matters most: it holds the locked liquidity.
  elf = readFileSync(join(REPO_ROOT, "programs", "target", "deploy", "archpad_pool.so"));
  await fundFromFaucet(chain.rpc, chain.authority, 20_000_000n);
  await deployProgram(chain.rpc, program, chain.authority, elf);
}, 600_000);

describe("a finalized program", () => {
  it("starts out live and upgradeable by its authority", async () => {
    const account = (await chain.rpc.getAccount(program.address))!;
    expect(account.isExecutable).toBe(true);
    const state = decodeProgramState(account.data);
    expect(state).toMatchObject({ authority: chain.authority.address, isFinalized: false });
    expect(account.data.subarray(PROGRAM_DATA_OFFSET)).toEqual(new Uint8Array(elf));
  });

  it("cannot be finalized by anyone but its authority", async () => {
    const stranger = keypairSigner(randomBytes(32));
    // Give the stranger something to pay fees with.
    await chain.client.sendAndConfirm([systemTransfer(chain.authority.address, stranger.address, 1_000_000n)], [
      chain.authority,
    ]);
    await expectFailure(chain, [loaderFinalize(program.address, stranger.address, program.address)], [stranger, program]);
    expect(decodeProgramState((await chain.rpc.getAccount(program.address))!.data).isFinalized).toBe(false);
  });

  it("can never be changed again once finalized, by its old authority or anyone else", async () => {
    const { client, rpc, authority } = chain;
    await client.sendAndConfirm([loaderFinalize(program.address, authority.address, program.address)], [authority, program]);

    const account = (await rpc.getAccount(program.address))!;
    expect(account.isExecutable).toBe(true);
    expect(decodeProgramState(account.data).isFinalized).toBe(true);

    // Every way the authority used to have of changing the program is gone.
    await expectFailure(chain, [loaderRetract(program.address, authority.address)], [authority]);
    await expectFailure(chain, [loaderWrite(program.address, authority.address, 0, new Uint8Array(32))], [authority]);
    const heir = keypairSigner(randomBytes(32));
    await expectFailure(
      chain,
      [loaderTransferAuthority(program.address, authority.address, heir.address)],
      [authority, program, heir],
    );

    // The code is byte for byte what was deployed, and still runs.
    const after = (await rpc.getAccount(program.address))!;
    expect(after.isExecutable).toBe(true);
    expect(after.data.subarray(PROGRAM_DATA_OFFSET)).toEqual(new Uint8Array(elf));

    // The deploy tool notices too, rather than quietly failing part way.
    const different = Uint8Array.from(elf);
    different[different.length - 1] = (different.at(-1) ?? 0) ^ 0xff;
    await expect(deployProgram(rpc, program, authority, different)).rejects.toThrow(/finalized/);
  });
});
