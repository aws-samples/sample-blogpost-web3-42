#!/usr/bin/env node
/**
 * Step 1 — ValidateBridgeRequest
 *
 * Invokes the ValidateBridgeRequestFunction via `sam local invoke`,
 * reads the result, and writes step1-output.json for the next step.
 *
 * Usage (from cctp-bridge/):
 *   node local-test/step1-validate.mjs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const eventFile = join(__dirname, "event.json");
const envFile = join(__dirname, "env.json");
const outputFile = join(__dirname, "step1-output.json");

console.log("─────────────────────────────────────────────");
console.log("Step 1: ValidateBridgeRequest");
console.log("─────────────────────────────────────────────");
console.log(`Input:  ${eventFile}`);

const cmd = [
    "sam local invoke ValidateBridgeRequestFunction",
    `--event ${eventFile}`,
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

// sam local invoke may emit logs before the JSON result — extract last line
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

// The Lambda returns the response directly as its result payload.
// When invoked via SAM, the output IS the Lambda return value.
const payload = result;

console.log("\n✅ Step 1 output:");
console.log(JSON.stringify(payload, null, 2));

writeFileSync(outputFile, JSON.stringify(payload, null, 2));
console.log(`\nWritten to: ${outputFile}`);
