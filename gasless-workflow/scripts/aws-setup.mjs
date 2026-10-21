import "dotenv/config";
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
    console.log("🚀 Automating AWS Setup from .env...");

    const ownerKey = process.env.OWNER_PRIVATE_KEY;
    if (!ownerKey) {
        console.error("❌ OWNER_PRIVATE_KEY missing in .env (required for paymaster-key-owner).");
        process.exit(1);
    }

    const client = new SecretsManagerClient();

    try {
        // Required: owner key.
        await upsertPrivateKeySecret(client, "owner", ownerKey);

        // Optional: recipient key. Only populated if the CCTP bridge workflow will be
        // exercised. A missing RECIPIENT_PRIVATE_KEY is not an error for the gasless workflow.
        const recipientKey = process.env.RECIPIENT_PRIVATE_KEY;
        if (recipientKey) {
            await upsertPrivateKeySecret(client, "recipient", recipientKey);
        } else {
            console.log(
                "ℹ️  RECIPIENT_PRIVATE_KEY not set in .env; skipping paymaster-key-recipient. " +
                "Set it if you plan to run the CCTP bridge."
            );
        }
    } catch (error) {
        console.error("❌ Error interacting with Secrets Manager:", error.message);
        process.exit(1);
    }

    console.log("\n✅ Secrets Manager configured successfully.");
}

setupAWS().catch(console.error);
