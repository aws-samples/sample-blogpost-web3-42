#!/usr/bin/env node
/**
 * aws-setup.mjs — One-time AWS setup for the CCTP bridge
 *
 * Upserts the Secrets Manager secrets used by the CCTP bridge:
 *   - paymaster-key-owner     (required)
 *   - paymaster-key-recipient (required)
 *
 * Reads private keys from cctp-bridge/.env.
 *
 * Usage (from cctp-bridge/):
 *   node scripts/aws-setup.mjs
 *
 * Requires: AWS credentials configured (aws configure, env vars, or instance profile).
 */
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = resolve(__dirname, "..");
const bridgeEnv = join(bridgeRoot, ".env");

if (existsSync(bridgeEnv)) {
    dotenv.config({ path: bridgeEnv });
    console.log(`📂 Loaded .env from: ${bridgeEnv}`);
} else {
    console.error(
        "❌ No .env file found.\n" +
        `   Expected: ${bridgeEnv}\n` +
        "   Please create cctp-bridge/.env from .env.example and fill in your keys."
    );
    process.exit(1);
}

import {
    SecretsManagerClient,
    CreateSecretCommand,
    PutSecretValueCommand,
    DescribeSecretCommand
} from "@aws-sdk/client-secrets-manager";

/**
 * Upsert a Secrets Manager secret carrying a private key payload.
 * Uses the unified `paymaster-key-${userKey}` naming convention.
 */
async function upsertPrivateKeySecret(client, userKey, privateKey) {
    const secretName = `paymaster-key-${userKey}`;
    const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const secretString = JSON.stringify({ privateKey: normalized });

    try {
        await client.send(new DescribeSecretCommand({ SecretId: secretName }));
        console.log(`ℹ️  Secret '${secretName}' already exists. Updating value...`);
        await client.send(new PutSecretValueCommand({
            SecretId: secretName,
            SecretString: secretString
        }));
    } catch (error) {
        if (error.name === "ResourceNotFoundException") {
            console.log(`🆕 Creating fresh secret '${secretName}'...`);
            await client.send(new CreateSecretCommand({
                Name: secretName,
                SecretString: secretString
            }));
        } else {
            throw error;
        }
    }
    console.log(`✅ Secret '${secretName}' is ready.`);
}

async function setupAWS() {
    console.log("🚀 CCTP bridge AWS setup, configuring Secrets Manager...");

    const ownerKey = process.env.OWNER_PRIVATE_KEY;
    const recipientKey = process.env.RECIPIENT_PRIVATE_KEY;

    if (!ownerKey) {
        console.error(
            "❌ OWNER_PRIVATE_KEY missing in cctp-bridge/.env (required for paymaster-key-owner)."
        );
        process.exit(1);
    }

    if (!recipientKey) {
        console.error(
            "❌ RECIPIENT_PRIVATE_KEY missing in cctp-bridge/.env (required for paymaster-key-recipient).\n" +
            "   The recipient's EOA must hold ≥ 1 USDC on Base Sepolia.\n" +
            "   Faucet: https://faucet.circle.com"
        );
        process.exit(1);
    }

    const client = new SecretsManagerClient();

    try {
        await upsertPrivateKeySecret(client, "owner", ownerKey);
        await upsertPrivateKeySecret(client, "recipient", recipientKey);
    } catch (error) {
        console.error("❌ Error interacting with Secrets Manager:", error.message);
        process.exit(1);
    }

    console.log("\n✅ Secrets Manager configured successfully.");
}

setupAWS().catch(console.error);
