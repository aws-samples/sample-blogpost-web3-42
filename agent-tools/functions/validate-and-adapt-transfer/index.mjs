/**
 * validate-and-adapt-transfer
 *
 * Adapter Lambda for the GaslessTransferTool MCP tool.
 * Receives agent-friendly input (human-readable USDC amount, chain key, address),
 * validates it, converts to base units, and builds the gasless workflow `calls` payload.
 *
 * Input:
 *   { chainKey: "eth"|"base"|"arb", amountUsdc: 5.0, recipientAddress: "0x..." }
 *
 * Output:
 *   { chainKey, amountUsdc, recipientAddress, calls: [...] }
 */

const VALID_CHAINS = ['eth', 'base', 'arb'];

const USDC_ADDRESSES = {
    eth: process.env.ETH_USDC_ADDRESS || '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    base: process.env.BASE_USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    arb: process.env.ARB_USDC_ADDRESS || '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
};

// ERC-20 transfer ABI fragment — standard, immutable, safe to inline
const TRANSFER_ABI = JSON.stringify([
    {
        type: 'function',
        name: 'transfer',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'recipient', type: 'address' },
            { name: 'amount', type: 'uint256' }
        ],
        outputs: [{ type: 'bool' }]
    }
]);

export const handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));

    const { chainKey, amountUsdc, recipientAddress } = event;

    // ── 1. Validate chainKey ──────────────────────────────────────────────────
    if (!chainKey || !VALID_CHAINS.includes(chainKey)) {
        throw new Error(
            `Invalid chainKey: "${chainKey}". Must be one of: ${VALID_CHAINS.join(', ')}.`
        );
    }

    // ── 2. Validate recipientAddress ─────────────────────────────────────────
    if (!recipientAddress || !/^0x[0-9a-fA-F]{40}$/.test(recipientAddress)) {
        throw new Error(
            `Invalid recipientAddress: "${recipientAddress}". ` +
            'Must be a 0x-prefixed 40-hex-character Ethereum address.'
        );
    }

    // ── 3. Validate amountUsdc ───────────────────────────────────────────────
    const maxUsdc = parseFloat(process.env.MAX_TRANSFER_USDC || '100');

    if (typeof amountUsdc !== 'number' || isNaN(amountUsdc)) {
        throw new Error(`Invalid amountUsdc: "${amountUsdc}". Must be a number.`);
    }
    if (amountUsdc <= 0) {
        throw new Error(`amountUsdc must be positive. Got: ${amountUsdc}`);
    }
    if (amountUsdc > maxUsdc) {
        throw new Error(
            `amountUsdc ${amountUsdc} exceeds the maximum allowed amount of ${maxUsdc} USDC.`
        );
    }

    // ── 4. Resolve USDC contract address ────────────────────────────────────
    const usdcAddress = USDC_ADDRESSES[chainKey];

    // ── 5. Convert to base units (Math.round avoids IEEE 754 float errors) ──
    const baseUnits = String(Math.round(amountUsdc * 1_000_000));

    // ── 6. Build the gasless workflow calls array ──────────────────────────────────────────
    const calls = [
        {
            to: usdcAddress,
            abi: TRANSFER_ABI,
            functionName: 'transfer',
            args: [recipientAddress, baseUnits]
        }
    ];

    const result = {
        chainKey,
        amountUsdc,
        recipientAddress,
        calls,
    };

    console.log('Adapter output:', JSON.stringify(result, null, 2));
    return result;
};
