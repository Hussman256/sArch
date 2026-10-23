import { ArchpadClient, ArchRpc } from "@archpad/sdk";
import { resolve } from "path";
import { loadSigner } from "./network.ts";

async function main() {
  const rpc = new ArchRpc("https://rpc.testnet.arch.network");
  const client = new ArchpadClient(rpc);
  const authority = loadSigner(resolve("../../keys/testnet/authority.key"));
  const proposalId = 0n;

  console.log(`Monitoring Proposal #${proposalId} on testnet...`);

  while (true) {
    try {
      const config = await client.getConfig();
      const proposal = await client.getProposal(proposalId);
      if (!config || !proposal) {
        console.log("Could not load config or proposal, retrying...");
      } else if (proposal.executedAt > 0n) {
        console.log(`Proposal #${proposalId} has already been executed!`);
        return;
      } else {
        const now = await rpc.getChainTime();
        const readyAt = proposal.approvedAt + BigInt(config.active.timelockSecs);
        const remaining = readyAt - now;

        if (remaining <= 0n) {
          console.log(`Timelock elapsed! Executing Proposal #${proposalId}...`);
          try {
            const txId = await client.sendAndConfirm(
              [client.instructions.execute(proposalId)],
              [authority],
            );
            console.log(`Proposal #${proposalId} successfully executed! Tx:`, txId);
            return;
          } catch (err: any) {
            console.error("Execution attempt failed:", err.message);
          }
        } else {
          console.log(`Waiting for timelock... ${remaining} seconds remaining (${new Date(Number(readyAt) * 1000).toISOString()})`);
        }
      }
    } catch (error: any) {
      console.log("Transient RPC error, will retry in 30s:", error.message);
    }

    // Sleep 30 seconds between checks
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main().catch(console.error);
