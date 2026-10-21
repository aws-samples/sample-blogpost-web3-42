#!/usr/bin/env node
/**
 * Step 4 — Wait for CCTP Attestation
 *
 * Polls the GetAttestationFunction (via `sam local invoke`) every 5 seconds,
 * up to 60 attempts, until the attestation is ready.
 *
 * Mirrors the Step Functions polling loop (Wait + Choice + IncrementAttempt)
 * but runs locally against the deployed Iris API.
 *
 * Reads step3-output.json, writes step4-output.json.
 *
 * Usage (from cctp-bridge/):
 *   node local-test/step4-wait-attestation.mjs
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const inputFile = join(__dirname, "step3-output.json");
const envFile = join(__dirname, "env.json");
const outputFile = join(__dirname, "step4-output.json");

const MAX_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 5000;

console.log("─────────────────────────────────────────────");
console.log("Step 4: WaitForAttestation (polling loop)");
console.log("─────────────────────────────────────────────");

const state = JSON.parse(readFileSync(inputFile, "utf8"));

if (!state.sourceTxHash) {
    console.error("❌ 'sourceTxHash' not found in step3-output.json. Run step 3 first.");
    process.exit(1);
}

console.log(`sourceTxHash: ${state.sourceTxHash}`);
console.log(`sourceDomain: ${state.sourceDomain}`);
console.log(`Max attempts: ${MAX_ATTEMPTS} × ${POLL_INTERVAL_MS / 1000}s = ${MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000}s\n`);

let currentState = { ...state, attestationAttempts: 0 };
let attestationReady = false;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    currentState.attestationAttempts = attempt - 1;

    // Write current state as a temp event file for sam local invoke
    const tempEventFile = join(__dirname, "_temp-attestation-event.json");
    writeFileSync(tempEventFile, JSON.stringify(currentState, null, 2));

    const cmd = [
        "sam local invoke GetAttestationFunction",
        `--event ${tempEventFile}`,
        `--env-vars ${envFile}`,
    ].join(" ");

    process.stdout.write(`[Attempt ${attempt}/${MAX_ATTEMPTS}] Polling Iris... `);

    let raw;
    try {
        raw = execSync(cmd, { cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
        console.log("⚠️  sam invoke error, retrying...");
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
    }

    const lines = raw.trim().split("\n");
    const jsonLine = lines[lines.length - 1];

    let result;
    try {
        result = JSON.parse(jsonLine);
    } catch {
        console.log("⚠️  parse error, retrying...");
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
    }

    currentState = result;

    if (result.attestationReady === true) {
        console.log("✅ Attestation READY!");
        attestationReady = true;
        break;
    }

    console.log(`⏳ pending`);

    if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

// Clean up temp file
try {
    const { unlinkSync } = await import("fs");
    unlinkSync(join(__dirname, "_temp-attestation-event.json"));
} catch { /* ignore */ }

if (!attestationReady) {
    console.error("\n❌ Timeout: attestation not ready after 5 minutes.");
    process.exit(1);
}

console.log("\n✅ Step 4 output:");
console.log(JSON.stringify(currentState, null, 2));

writeFileSync(outputFile, JSON.stringify(currentState, null, 2));
console.log(`\nWritten to: ${outputFile}`);
