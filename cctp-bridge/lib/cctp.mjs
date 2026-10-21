/**
 * lib/cctp.mjs — CCTP V2 helpers for the bridge workflow
 *
 * Contains:
 *  - chainKey → CCTP domainId mapping
 *  - Iris API client (fee fetch + attestation poll)
 *  - bytes32 address helper
 *  - TokenMessenger and MessageTransmitter ABIs
 */

// ---------------------------------------------------------------------------
// Chain ↔ CCTP Domain mapping
// ---------------------------------------------------------------------------

/**
 * Map from chainKey to CCTP V2 domain identifier.
 * Mirrors the CCTP reference implementation.
 */
export const CHAIN_DOMAIN_MAP = {
    "eth": 0,
    "arb": 3,
    "base": 6
};

/**
 * Derive the CCTP domain ID for a given chainKey.
 * Throws if the chain is not supported.
 *
 * @param {string} chainKey  "eth" | "arb" | "base"
 * @returns {number}
 */
export function getDomainForChain(chainKey) {
    const domain = CHAIN_DOMAIN_MAP[chainKey];
    if (domain === undefined) {
        throw new Error(
            `Unsupported chainKey '${chainKey}'. ` +
            `Valid values: ${Object.keys(CHAIN_DOMAIN_MAP).join(", ")}`
        );
    }
    return domain;
}

// ---------------------------------------------------------------------------
// Address → bytes32 helper
// ---------------------------------------------------------------------------

/**
 * Left-pad an Ethereum address (20 bytes) to a 32-byte hex string as required
 * by CCTP's mintRecipient parameter.
 *
 * @param {string} address  0x-prefixed 20-byte address
 * @returns {string}        0x-prefixed 32-byte hex string (64 hex chars after 0x)
 */
export function addressToBytes32(address) {
    const stripped = address.replace("0x", "").toLowerCase();
    return `0x000000000000000000000000${stripped}`;
}

// ---------------------------------------------------------------------------
// Iris API client
// ---------------------------------------------------------------------------

/**
 * Fetch the Fast-Transfer (finalityThreshold=1000) fee from the Iris V2 API.
 * Returns { irisFee, maxFee } where maxFee = irisFee + 1000n (buffer).
 *
 * @param {number} sourceDomain
 * @param {number} targetDomain
 * @returns {Promise<{ irisFee: bigint, maxFee: bigint }>}
 */
export async function fetchIrisFee(sourceDomain, targetDomain) {
    const irisBase = process.env.IRIS_API_BASE || "https://iris-api-sandbox.circle.com";
    const url = `${irisBase}/v2/burn/USDC/fees/${sourceDomain}/${targetDomain}`;

    console.log(`Fetching Iris fees: ${url}`);
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Iris fee API returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const fastTransfer = data.find(f => f.finalityThreshold === 1000);

    if (!fastTransfer) {
        // Fallback: no Fast-Transfer available; use 0 fee (Standard Transfer)
        console.warn("No Fast-Transfer fee entry found. Defaulting to Standard Transfer (maxFee=0).");
        return { irisFee: 0n, maxFee: 0n };
    }

    const irisFee = BigInt(fastTransfer.minimumFee);
    const maxFee = irisFee + 1000n; // +1000 micro-USDC safety buffer
    console.log(`Fast-Transfer fee: ${irisFee} micro-USDC → maxFee (with buffer): ${maxFee}`);

    return { irisFee, maxFee };
}

/**
 * Single poll of the Iris V2 messages endpoint.
 * Returns the attestation state for the first message found for the given tx.
 *
 * @param {number} sourceDomain
 * @param {string} txHash  0x-prefixed source transaction hash
 * @returns {Promise<{
 *   attestationReady: boolean,
 *   message?:     string,
 *   attestation?: string,
 *   eventNonce?:  string
 * }>}
 */
export async function pollAttestation(sourceDomain, txHash) {
    const irisBase = process.env.IRIS_API_BASE || "https://iris-api-sandbox.circle.com";
    const url = `${irisBase}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;

    console.log(`Polling Iris attestation: ${url}`);

    let data;
    try {
        const response = await fetch(url);

        if (response.status === 404) {
            // Circle hasn't indexed the burn yet — treat as pending
            console.log("Iris returned 404 (not indexed yet). Status: pending.");
            return { attestationReady: false };
        }

        if (!response.ok) {
            console.warn(`Iris messages API returned ${response.status}. Treating as pending.`);
            return { attestationReady: false };
        }

        data = await response.json();
    } catch (err) {
        console.warn(`Error calling Iris API: ${err.message}. Treating as pending.`);
        return { attestationReady: false };
    }

    if (!data.messages || data.messages.length === 0) {
        console.log("No messages found yet (Circle indexing delay). Status: pending.");
        return { attestationReady: false };
    }

    const msg = data.messages[0];
    console.log(`Message status: ${msg.status}`);

    if (msg.status === "complete") {
        return {
            attestationReady: true,
            message: msg.message,
            attestation: msg.attestation,
            eventNonce: String(msg.eventNonce ?? "")
        };
    }

    // "pending" | "pending_fast_transfer" | anything else → keep looping
    return { attestationReady: false };
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

/**
 * Minimal ABI for the CCTP V2 TokenMessenger `depositForBurn` function.
 */
export const TOKEN_MESSENGER_ABI = [
    {
        "inputs": [
            { "name": "amount", "type": "uint256" },
            { "name": "destinationDomain", "type": "uint32" },
            { "name": "mintRecipient", "type": "bytes32" },
            { "name": "burnToken", "type": "address" },
            { "name": "destinationCaller", "type": "bytes32" },
            { "name": "maxFee", "type": "uint256" },
            { "name": "minFinalityThreshold", "type": "uint32" }
        ],
        "name": "depositForBurn",
        "outputs": [{ "name": "nonce", "type": "uint64" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

/**
 * Minimal ABI for the CCTP MessageTransmitter `receiveMessage` function.
 */
export const MESSAGE_TRANSMITTER_ABI = [
    {
        "inputs": [
            { "name": "message", "type": "bytes" },
            { "name": "attestation", "type": "bytes" }
        ],
        "name": "receiveMessage",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

/**
 * Minimal ERC-20 approve ABI (used alongside TOKEN_MESSENGER_ABI for the
 * approve + depositForBurn batch).
 */
export const ERC20_APPROVE_ABI = [
    {
        "inputs": [
            { "name": "spender", "type": "address" },
            { "name": "amount", "type": "uint256" }
        ],
        "name": "approve",
        "outputs": [{ "name": "", "type": "bool" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];
