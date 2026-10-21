import { createPublicClient, http } from "viem";
import { sepolia, arbitrumSepolia, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPrivateKeyForUser, secretNameForUser } from "./secrets.mjs";

const CHAINS = {
    "eth": sepolia,
    "arb": arbitrumSepolia,
    "base": baseSepolia
};

/**
 * Default public RPC endpoints — no API key required.
 * These are used automatically unless you override them here.
 * To use a private endpoint (e.g. Infura, Alchemy, QuickNode),
 * replace the corresponding URL directly in this map.
 */
const RPC_URLS = {
    "eth": "https://ethereum-sepolia-rpc.publicnode.com",
    "arb": "https://sepolia-rollup.arbitrum.io/rpc",
    "base": "https://sepolia.base.org",
};

export const USDC_DOMAIN_PARAMS = {
    "eth": { name: "USDC", version: "2" },
    "arb": { name: "USD Coin", version: "2" },
    "base": { name: "USDC", version: "2" }
};

/**
 * Build a block-explorer URL for a given transaction hash on a supported chain.
 *
 * @param {"eth"|"arb"|"base"} chainKey
 * @param {string} txHash 0x-prefixed tx hash
 * @returns {string}
 */
export function getExplorerUrl(chainKey, txHash) {
    switch (chainKey) {
        case "eth": return `https://sepolia.etherscan.io/tx/${txHash}`;
        case "arb": return `https://sepolia.arbiscan.io/tx/${txHash}`;
        case "base": return `https://sepolia.basescan.org/tx/${txHash}`;
        default: return txHash;
    }
}

/**
 * Load all per-chain, per-user configuration needed by the CCTP bridge Lambda functions.
 * Extends the gasless workflow's getConfiguration() with CCTP contract addresses
 * (tokenMessengerAddress, messageTransmitterAddress).
 *
 * @param {"eth"|"arb"|"base"} chainKey
 * @param {string} [userKey="owner"] Which actor's key to load.
 *        Maps to:
 *          - local env var   `${userKey.toUpperCase()}_PRIVATE_KEY`  (e.g. OWNER_PRIVATE_KEY, RECIPIENT_PRIVATE_KEY)
 *          - Secrets Manager secret `paymaster-key-${userKey}`       (e.g. paymaster-key-owner, paymaster-key-recipient)
 */
export async function getConfiguration(chainKey, userKey = "owner") {
    const chain = CHAINS[chainKey] || sepolia;
    const envPrefix = chainKey.toUpperCase() + "_";

    const usdcAddress = process.env[`${envPrefix}USDC_ADDRESS`];
    const paymasterAddress = process.env[`${envPrefix}PAYMASTER_ADDRESS`];
    const tokenMessengerAddress = process.env[`${envPrefix}TOKEN_MESSENGER_ADDRESS`];
    const messageTransmitterAddress = process.env[`${envPrefix}MESSAGE_TRANSMITTER_ADDRESS`];

    // Private key resolution order:
    //   1. Local env var `${USERKEY}_PRIVATE_KEY` if present and non-empty
    //      (used for `sam local invoke` via env.json, and any ad-hoc Node runs).
    //   2. Secrets Manager secret `paymaster-key-${userKey}` (AWS production path).
    const envVarName = `${userKey.toUpperCase()}_PRIVATE_KEY`;
    let privateKey = process.env[envVarName];
    let source = privateKey ? `env var ${envVarName}` : undefined;

    if (!privateKey) {
        try {
            privateKey = await getPrivateKeyForUser(userKey);
            if (privateKey) source = `Secrets Manager secret ${secretNameForUser(userKey)}`;
        } catch (e) {
            console.warn(
                `Could not fetch private key from Secrets Manager (${secretNameForUser(userKey)}):`,
                e?.message || e
            );
        }
    }

    if (!privateKey) {
        throw new Error(
            `Private key for userKey='${userKey}' is missing. ` +
            `Expected env var '${envVarName}' ` +
            `or Secrets Manager secret '${secretNameForUser(userKey)}'.`
        );
    }

    console.log(`Private key for userKey='${userKey}' loaded from ${source}.`);

    if (!usdcAddress || !paymasterAddress) {
        throw new Error(`Missing required environment variables for ${chainKey.toUpperCase()}: ${envPrefix}USDC_ADDRESS or ${envPrefix}PAYMASTER_ADDRESS`);
    }

    const rpcUrl = RPC_URLS[chainKey] || RPC_URLS["eth"];

    const client = createPublicClient({
        chain,
        transport: http(rpcUrl, { batch: true }),
    });

    const owner = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
    const usdcDomainParams = USDC_DOMAIN_PARAMS[chainKey] || USDC_DOMAIN_PARAMS["eth"];

    return {
        chain,
        chainKey,
        userKey,
        usdcAddress,
        paymasterAddress,
        tokenMessengerAddress,
        messageTransmitterAddress,
        client,
        owner,
        usdcDomainParams
    };
}
