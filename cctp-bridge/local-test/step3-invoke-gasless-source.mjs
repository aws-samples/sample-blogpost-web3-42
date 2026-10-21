#!/usr/bin/env node
/**
 * Step 3 — Invoke the gasless workflow state machine (source chain: approve + depositForBurn)
 *
 * Uses the AWS CLI to start a synchronous execution of the deployed the gasless workflow
 * state machine, waits for it to finish, then merges the gasless workflow's structured
 * summary (transactionHash, explorerUrl) back into the state as `sourceTxHash`.
 *
 * Prerequisites:
 *   - the gasless workflow is deployed to AWS (`sam deploy` completed successfully).
 *   - GASLESS_SF_ARN environment variable is set, OR the script reads it from
 *     the `GASLESS_STATE_MACHINE_ARN` field in step2-output.json, OR you pass
 *     it as the first CLI argument.
 *
 * Usage (from cctp-bridge/):
 *   GASLESS_SF_ARN=arn:aws:states:... node local-test/step3-invoke-gasless-source.mjs
 *   # or:
 *   node local-test/step3-invoke-gasless-source.mjs arn:aws:states:...
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const inputFile = join(__dirname, "step2-output.json");
const outputFile = join(__dirname, "step3-output.json");

console.log("─────────────────────────────────────────────");
console.log("Step 3: ExecuteSourceUserOp (gasless workflow, source chain)");
console.log("─────────────────────────────────────────────");

// --- Resolve the gasless workflow state machine ARN ---
const gaslessArn = process.argv[2] || process.env.GASLESS_SF_ARN;
if (!gaslessArn) {
    console.error(
        "❌ GASLESS_SF_ARN is not set.\n" +
        "   Set it as an env var or pass it as the first argument:\n" +
        "   GASLESS_SF_ARN=arn:aws:states:... node local-test/step3-invoke-gasless-source.mjs"
    );
    process.exit(1);
}
console.log(`the gasless workflow ARN: ${gaslessArn}`);

// --- Read step2 output ---
const step2 = JSON.parse(readFileSync(inputFile, "utf8"));

// Build the gasless workflow input: chainKey=sourceChainKey, userKey=owner, calls from step2
const gaslessInput = {
    chainKey: step2.sourceChainKey,
    userKey: "owner",
    calls: step2.calls
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

console.log("\nStarting the gasless workflow execution...");
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
    console.error("❌ the gasless workflow execution failed:", describeOutput.cause || describeOutput.error);
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

console.log("\n✅ the gasless workflow source execution summary:");
console.log(`  transactionHash: ${gaslessOutput.transactionHash}`);
console.log(`  explorerUrl:     ${gaslessOutput.explorerUrl}`);

// --- Merge sourceTxHash back into the CCTP bridge state ---
const merged = {
    ...step2,
    sourceTxHash: gaslessOutput.transactionHash,
    sourceExplorerUrl: gaslessOutput.explorerUrl,
    attestationAttempts: 0
};

// Remove the source-phase calls (no longer needed; will be replaced in step 5)
delete merged.calls;

console.log("\n✅ Step 3 merged output:");
console.log(JSON.stringify(merged, null, 2));

writeFileSync(outputFile, JSON.stringify(merged, null, 2));
console.log(`\nWritten to: ${outputFile}`);
console.log("\n🔗 Source tx:", gaslessOutput.explorerUrl);
