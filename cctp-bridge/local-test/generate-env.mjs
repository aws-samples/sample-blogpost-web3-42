#!/usr/bin/env node
/**
 * generate-env.mjs — Write local-test/env.json from cctp-bridge/.env
 *
 * `sam local invoke` reads environment variables from `local-test/env.json`.
 * This script creates that file from cctp-bridge/.env: the private keys and the
 * contract addresses, for every Lambda function of the bridge. The file contains
 * private keys, so it is git-ignored and written with permissions 600.
 *
 * Run this once after setting up (or rotating) your .env keys, and before
 * executing any local-test/step*.mjs scripts.
 *
 * Usage (from cctp-bridge/):
 *   node local-test/generate-env.mjs
 *   # or:
 *   npm run generate-env
 */

import { existsSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(__dirname, "..");
const envPath = join(bridgeRoot, ".env");
const envJsonPath = join(__dirname, "env.json");

// Load .env
if (!existsSync(envPath)) {
    console.error(
        "❌ No .env file found.\n" +
        `   Expected: ${envPath}\n` +
        "   Please create cctp-bridge/.env from .env.example and fill in your keys."
    );
    process.exit(1);
}
dotenv.config({ path: envPath });

const ownerKey = process.env.OWNER_PRIVATE_KEY;
const recipientKey = process.env.RECIPIENT_PRIVATE_KEY;

if (!ownerKey) {
    console.error("❌ OWNER_PRIVATE_KEY missing in .env");
    process.exit(1);
}
if (!recipientKey) {
    console.error("❌ RECIPIENT_PRIVATE_KEY missing in .env");
    process.exit(1);
}

// Function blocks for `sam local invoke`. Each block carries the keys from .env plus the
// non-secret settings that template.yaml gives the deployed functions.
const FUNCTIONS = [
    "ValidateBridgeRequestFunction",
    "PrepareBridgeCallsFunction",
    "GetAttestationFunction",
    "PrepareReceiveCallFunction",
];

const SETTINGS = {
    IRIS_API_BASE: "https://iris-api-sandbox.circle.com",
};
for (const chain of ["ETH", "BASE", "ARB"]) {
    for (const name of [
        "USDC_ADDRESS",
        "PAYMASTER_ADDRESS",
        "TOKEN_MESSENGER_ADDRESS",
        "MESSAGE_TRANSMITTER_ADDRESS",
    ]) {
        const value = process.env[`${chain}_${name}`];
        if (value) SETTINGS[`${chain}_${name}`] = value;
    }
}

// env.json is written from scratch on every run. It contains private keys and is git-ignored.
const generated = {};
for (const fnName of FUNCTIONS) {
    generated[fnName] = {
        ...SETTINGS,
        OWNER_PRIVATE_KEY: ownerKey,
        RECIPIENT_PRIVATE_KEY: recipientKey,
    };
}

writeFileSync(envJsonPath, JSON.stringify(generated, null, 4), { mode: 0o600 });

console.log("✅ local-test/env.json written (permissions 600, git-ignored)");
console.log(`   Function blocks: ${Object.keys(generated).join(", ")}`);
