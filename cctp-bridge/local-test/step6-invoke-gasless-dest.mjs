#!/usr/bin/env node
/**
 * Step 6 — Invoke the gasless workflow state machine (destination chain: receiveMessage)
 *
 * Uses the AWS CLI to start a synchronous execution of the deployed the gasless workflow
 * state machine for the destination chain (Base Sepolia, userKey=recipient).
 * Assembles the final the CCTP bridge summary once the execution completes.
 *
 * Reads step5-output.json, writes step6-output.json (final summary).
 *
 * Usage (from cctp-bridge/):
 *   GASLESS_SF_ARN=arn:aws:states:... node local-test/step6-invoke-gasless-dest.mjs
 *   # or:
 *   node local-test/step6-invoke-gasless-dest.mjs arn:aws:states:...
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputFile = join(__dirname, "step5-output.json");
const outputFile = join(__dirname, "step6-output.json");

console.log("─────────────────────────────────────────────");
console.log("Step 6: ExecuteDestUserOp (gasless workflow, destination chain)");
console.log("─────────────────────────────────────────────");

// --- Resolve the gasless workflow state machine ARN ---
const gaslessArn = process.argv[2] || process.env.GASLESS_SF_ARN;
if (!gaslessArn) {
    console.error(
        "❌ GASLESS_SF_ARN is not set.\n" +
        "   Set it as an env var or pass it as the first argument:\n" +
        "   GASLESS_SF_ARN=arn:aws:states:... node local-test/step6-invoke-gasless-dest.mjs"
    );
    process.exit(1);
}
console.log(`the gasless workflow ARN: ${gaslessArn}`);

// --- Read step5 output ---
const step5 = JSON.parse(readFileSync(inputFile, "utf8"));

// Build the gasless workflow input: chainKey=destChainKey, userKey=recipient, calls=receiveMessage
const gaslessInput = {
    chainKey: step5.destChainKey,
    userKey: "recipient",
    calls: step5.calls
};

console.log(`\nThe gasless workflow input (chainKey=${gaslessInput.chainKey}, userKey=${gaslessInput.userKey}):`);
console.log(JSON.stringify(gaslessInput, null, 2));

// --- Start execution ---
const startCmd = [
    "aws stepfunctions start-execution",
    `--state-machine-arn "${gaslessArn}"`,
    `--input '${JSON.stringify(gaslessInput)}'`,
    "--query executionArn",
    "--output text"
].join(" ");

console.log("\nStarting the gasless workflow destination execution...");
const executionArn = execSync(startCmd, { encoding: "utf8" }).trim();
console.log(`Execution ARN: ${executionArn}`);

// --- Poll until terminal state ---
console.log("\nWaiting for the gasless workflow execution to complete...");
let status = "RUNNING";
let describeOutput;

while (status === "RUNNING") {
    await new Promise(r => setTimeout(r, 3000));

    const describeCmd = [
        "aws stepfunctions describe-execution",
        `--execution-arn "${executionArn}"`,
        "--output json"
    ].join(" ");

    describeOutput = JSON.parse(execSync(describeCmd, { encoding: "utf8" }));
    status = describeOutput.status;
    process.stdout.write(`  Status: ${status}\r`);
}

console.log(`\nFinal status: ${status}`);

if (status !== "SUCCEEDED") {
    console.error("❌ the gasless workflow destination execution failed:", describeOutput.cause || describeOutput.error);
    writeFileSync(outputFile, JSON.stringify(describeOutput, null, 2));
    process.exit(1);
}

// --- Extract the gasless workflow structured summary ---
// the gasless workflow's terminal state uses `arn:aws:states:::lambda:invoke`, so the state
// machine output is the Lambda invoke envelope:
//   { "Payload": { "status": "SUCCEEDED", "transactionHash": "0x...", ... }, "StatusCode": 200, ... }
// The actual structured summary is inside `Payload`.
const rawOutput = JSON.parse(describeOutput.output);
const gaslessOutput = rawOutput.Payload || rawOutput;

console.log("\n✅ the gasless workflow destination execution summary:");
console.log(`  transactionHash: ${gaslessOutput.transactionHash}`);
console.log(`  explorerUrl:     ${gaslessOutput.explorerUrl}`);

// --- Assemble final the CCTP bridge summary ---
const summary = {
    status: "SUCCEEDED",
    sourceChainKey: step5.sourceChainKey,
    destChainKey: step5.destChainKey,
    bridgedAmount: step5.bridgeAmount,
    irisFee: step5.irisFee,
    ownerAddress: step5.ownerAddress,
    recipientAddress: step5.recipientAddress,
    sourceTxHash: step5.sourceTxHash,
    destTxHash: gaslessOutput.transactionHash,
    sourceExplorerUrl: step5.sourceExplorerUrl,
    destExplorerUrl: gaslessOutput.explorerUrl
};

console.log("\n🎉 Final the CCTP bridge Summary:");
console.log(JSON.stringify(summary, null, 2));

writeFileSync(outputFile, JSON.stringify(summary, null, 2));
console.log(`\nWritten to: ${outputFile}`);

console.log("\n─────────────────────────────────────────────");
console.log("Bridge Complete! ✅");
console.log("─────────────────────────────────────────────");
console.log(`🔗 Source tx:  ${summary.sourceExplorerUrl}`);
console.log(`🔗 Dest tx:    ${summary.destExplorerUrl}`);
console.log(`💰 Bridged:    ${Number(summary.bridgedAmount) / 1e6} USDC`);
console.log(`📦 From:       ${summary.ownerAddress} (${summary.sourceChainKey})`);
console.log(`📬 To:         ${summary.recipientAddress} (${summary.destChainKey})`);
