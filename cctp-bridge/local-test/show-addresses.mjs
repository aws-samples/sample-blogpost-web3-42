#!/usr/bin/env node
/**
 * show-addresses.mjs — Display EOA and SCA addresses for a given private key.
 *
 * Usage:
 *   node local-test/show-addresses.mjs <privateKey>
 *   node local-test/show-addresses.mjs 0x6ec30b...
 *
 * Or set the key via environment variable:
 *   PRIVATE_KEY=0x6ec30b... node local-test/show-addresses.mjs
 */

import { privateKeyToAccount } from "viem/accounts";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import { createPublicClient, http } from "viem";
import { sepolia, baseSepolia, arbitrumSepolia } from "viem/chains";

const rawKey = process.argv[2] || process.env.PRIVATE_KEY || process.env.OWNER_PRIVATE_KEY;

if (!rawKey) {
    console.error("Usage: node local-test/show-addresses.mjs <privateKey>");
    console.error("   or: PRIVATE_KEY=0x... node local-test/show-addresses.mjs");
    process.exit(1);
}

const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const owner = privateKeyToAccount(privateKey);

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  EOA Address:", owner.address);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

const chains = [
    { name: "ETH Sepolia", chain: sepolia },
    { name: "Base Sepolia", chain: baseSepolia },
    { name: "Arb Sepolia", chain: arbitrumSepolia },
];

for (const { name, chain } of chains) {
    const client = createPublicClient({ chain, transport: http() });
    const sca = await toSimple7702SmartAccount({ client, owner });
    console.log(`  ${name.padEnd(16)} SCA: ${sca.address}`);
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
