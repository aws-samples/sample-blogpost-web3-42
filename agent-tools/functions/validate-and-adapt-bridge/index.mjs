/**
 * validate-and-adapt-bridge
 *
 * Adapter Lambda for the CctpBridgeTool MCP tool.
 * Receives agent-friendly input (human-readable USDC amount, source/dest chain keys),
 * validates it, and converts to the CCTP bridge `bridgeAmount` (base units) payload.
 *
 * Input:
 *   { sourceChainKey: "eth", destChainKey: "base", amountUsdc: 5.0, recipientAddress?: "0x..." }
 *
 * Output:
 *   { sourceChainKey, destChainKey, bridgeAmount, amountUsdc, recipientAddress? }
 */

const VALID_CHAINS = ['eth', 'base', 'arb'];

export const handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));

    const { sourceChainKey, destChainKey, amountUsdc, recipientAddress } = event;

    // ── 1. Validate sourceChainKey ────────────────────────────────────────────
    if (!sourceChainKey || !VALID_CHAINS.includes(sourceChainKey)) {
        throw new Error(
            `Invalid sourceChainKey: "${sourceChainKey}". Must be one of: ${VALID_CHAINS.join(', ')}.`
        );
    }

    // ── 2. Validate destChainKey ──────────────────────────────────────────────
    if (!destChainKey || !VALID_CHAINS.includes(destChainKey)) {
        throw new Error(
            `Invalid destChainKey: "${destChainKey}". Must be one of: ${VALID_CHAINS.join(', ')}.`
        );
    }

    // ── 3. Validate source ≠ destination ────────────────────────────────────
    if (sourceChainKey === destChainKey) {
        throw new Error(
            `sourceChainKey and destChainKey must be different. Both are "${sourceChainKey}". ` +
            'For same-chain transfers, use the GaslessTransferTool instead.'
        );
    }

    // ── 4. Validate optional recipientAddress (if provided) ─────────────────
    if (recipientAddress !== undefined && recipientAddress !== null && recipientAddress !== '') {
        if (!/^0x[0-9a-fA-F]{40}$/.test(recipientAddress)) {
            throw new Error(
                `Invalid recipientAddress: "${recipientAddress}". ` +
                'Must be a 0x-prefixed 40-hex-character Ethereum address.'
            );
        }
    }

    // ── 5. Validate amountUsdc ───────────────────────────────────────────────
    const maxUsdc = parseFloat(process.env.MAX_BRIDGE_USDC || '100');

    if (typeof amountUsdc !== 'number' || isNaN(amountUsdc)) {
        throw new Error(`Invalid amountUsdc: "${amountUsdc}". Must be a number.`);
    }
    if (amountUsdc <= 0) {
        throw new Error(`amountUsdc must be positive. Got: ${amountUsdc}`);
    }
    if (amountUsdc > maxUsdc) {
        throw new Error(
            `amountUsdc ${amountUsdc} exceeds the maximum allowed bridge amount of ${maxUsdc} USDC.`
        );
    }

    // ── 6. Convert to base units (Math.round avoids IEEE 754 float errors) ──
    const bridgeAmount = String(Math.round(amountUsdc * 1_000_000));

    // Build the CCTP bridge input payload
    const result = {
        sourceChainKey,
        destChainKey,
        bridgeAmount,
        amountUsdc,
        ...(recipientAddress ? { recipientAddress } : {}),
    };

    console.log('Adapter output:', JSON.stringify(result, null, 2));
    return result;
};
