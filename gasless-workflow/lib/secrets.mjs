import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient();

/**
 * Fetch a raw secret string from AWS Secrets Manager.
 * @param {string} secretId The Secrets Manager secret name or ARN.
 * @returns {Promise<string>}
 */
export async function getSecretValue(secretId) {
    try {
        const response = await client.send(
            new GetSecretValueCommand({
                SecretId: secretId,
            })
        );
        return response.SecretString;
    } catch (error) {
        console.error(`Error fetching secret ${secretId}:`, error);
        throw error;
    }
}

/**
 * Resolve the Secrets Manager name for a given user key using the
 * unified `paymaster-key-*` convention.
 *
 *   userKey "owner"     -> "paymaster-key-owner"
 *   userKey "recipient" -> "paymaster-key-recipient"
 *
 * @param {string} [userKey="owner"]
 * @returns {string}
 */
export function secretNameForUser(userKey = "owner") {
    const key = (userKey || "owner").toLowerCase();
    return `paymaster-key-${key}`;
}

/**
 * Fetch the private key for a given user key from Secrets Manager.
 * Expects the secret payload to be a JSON string like:
 *   { "privateKey": "0x..." }
 *
 * @param {string} [userKey="owner"]
 * @returns {Promise<string|undefined>}
 */
export async function getPrivateKeyForUser(userKey = "owner") {
    const secretName = secretNameForUser(userKey);
    const raw = await getSecretValue(secretName);
    const parsed = JSON.parse(raw);
    return parsed.privateKey || parsed.PRIVATE_KEY;
}
