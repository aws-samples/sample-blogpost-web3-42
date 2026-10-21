#!/usr/bin/env node
/**
 * Step 5 — PrepareReceiveCall
 *
 * Encodes receiveMessage(message, attestation) for the destination chain.
 * Reads step4-output.json (contains attestation data), writes step5-output.json.
 *
 * Usage (from cctp-bridge/):
 *   node local-test/step5-prepare-receive.mjs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const inputFile = join(__dirname, "step4-output.json");
const envFile = join(__dirname, "env.json");
const outputFile = join(__dirname, "step5-output.json");

console.log("─────────────────────────────────────────────");
console.log("Step 5: PrepareReceiveCall");
console.log("─────────────────────────────────────────────");
console.log(`Input:  ${inputFile}`);

const cmd = [
    "sam local invoke PrepareReceiveCallFunction",
    `--event ${inputFile}`,
    `--env-vars ${envFile}`,
].join(" ");

console.log(`Running: ${cmd}\n`);

let raw;
try {
    raw = execSync(cmd, { cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
} catch (err) {
    console.error("❌ sam local invoke failed.");
    process.exit(1);
}

const lines = raw.trim().split("\n");
const jsonLine = lines[lines.length - 1];

let result;
try {
    result = JSON.parse(jsonLine);
} catch {
    console.error("❌ Could not parse Lambda output as JSON:");
    console.error(jsonLine);
    process.exit(1);
}

if (result.errorMessage) {
    console.error("❌ Lambda returned an error:", result.errorMessage);
    process.exit(1);
}

const payload = result;

console.log("\n✅ Step 5 output:");
console.log(JSON.stringify(payload, null, 2));

writeFileSync(outputFile, JSON.stringify(payload, null, 2));
console.log(`\nWritten to: ${outputFile}`);
