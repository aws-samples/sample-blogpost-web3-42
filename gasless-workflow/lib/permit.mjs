/**
 * permit.mjs: sign an ERC-2612 permit for USDC.
 *
 * A permit is an offchain signature that lets a spender use the owner's tokens, so the
 * approval itself costs no gas. The Circle Paymaster submits the signature in its
 * paymasterData and calls permit() on USDC to obtain its allowance.
 *
 * This file was written from the two standards it implements:
 *   - ERC-2612, which defines the Permit type: https://eips.ethereum.org/EIPS/eip-2612
 *   - EIP-712, which defines how typed data is hashed and signed: https://eips.ethereum.org/EIPS/eip-712
 *
 * The domain (name and version) is not read from the token. It differs per chain, so the
 * caller passes the values from USDC_DOMAIN_PARAMS in config.mjs.
 */
import { maxUint256, parseAbi } from "viem";

// The only token function this file needs.
const NONCES_ABI = parseAbi(["function nonces(address owner) view returns (uint256)"]);

// The Permit struct, exactly as ERC-2612 specifies it. The field order is part of the hash.
const PERMIT_TYPES = {
    Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
    ],
};

/**
 * Sign a permit that allows `spenderAddress` to spend `permitAmount` of the account's USDC.
 *
 * @param {object} params
 * @param {string} params.tokenAddress    USDC contract address on the chain of `client`.
 * @param {object} params.client          viem public client, created with a `chain`.
 * @param {object} params.account         viem local account of the token owner.
 * @param {string} params.spenderAddress  The Paymaster contract.
 * @param {bigint} params.permitAmount    Allowance in USDC base units (6 decimals).
 * @param {string} params.name            EIP-712 domain name of the token on this chain.
 * @param {string} params.version         EIP-712 domain version of the token on this chain.
 * @returns {Promise<string>} The 65-byte signature, as a 0x-prefixed hex string.
 */
export async function signPermit({
    tokenAddress,
    client,
    account,
    spenderAddress,
    permitAmount,
    name,
    version,
}) {
    if (!name || !version) {
        throw new Error("signPermit needs the token's EIP-712 domain name and version.");
    }

    // Each permit consumes one nonce, which the token tracks per owner.
    const nonce = await client.readContract({
        address: tokenAddress,
        abi: NONCES_ABI,
        functionName: "nonces",
        args: [account.address],
    });
    console.log(`- Permit nonce for ${account.address}: ${nonce}`);

    const signature = await account.signTypedData({
        domain: {
            name,
            version,
            chainId: client.chain.id,
            verifyingContract: tokenAddress,
        },
        types: PERMIT_TYPES,
        primaryType: "Permit",
        message: {
            owner: account.address,
            spender: spenderAddress,
            value: permitAmount,
            nonce,
            // The Circle Paymaster only accepts a permit that never expires, so the
            // deadline must be the maximum uint256.
            deadline: maxUint256,
        },
    });
    console.log("- Permit signed.");

    return signature;
}
