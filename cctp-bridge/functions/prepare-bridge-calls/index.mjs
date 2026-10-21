import { encodeFunctionData } from "viem";
import { getConfiguration } from "../../lib/config.mjs";
import {
    fetchIrisFee,
    addressToBytes32,
    TOKEN_MESSENGER_ABI,
    ERC20_APPROVE_ABI
} from "../../lib/cctp.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const {
        sourceChainKey,
        sourceDomain,
        targetDomain,
        bridgeAmount,
        recipientAddress
    } = event;

    if (!sourceChainKey || !recipientAddress || !bridgeAmount) {
        throw new Error("Invalid input: sourceChainKey, recipientAddress, and bridgeAmount are required.");
    }

    const bridgeAmountBig = BigInt(bridgeAmount);

    // Load source-chain config (we need usdcAddress + tokenMessengerAddress)
    const { usdcAddress, tokenMessengerAddress } = await getConfiguration(sourceChainKey, "owner");

    if (!tokenMessengerAddress) {
        throw new Error(`Missing ${sourceChainKey.toUpperCase()}_TOKEN_MESSENGER_ADDRESS environment variable.`);
    }

    // --- Fetch Fast-Transfer fee from Iris ---
    const { irisFee, maxFee } = await fetchIrisFee(
        Number(sourceDomain),
        Number(targetDomain)
    );

    const totalUsdcNeeded = bridgeAmountBig + maxFee;
    const minFinalityThreshold = maxFee > 0n ? 1000 : 0;

    console.log(`Bridge parameters:`);
    console.log(`  bridgeAmount:      ${bridgeAmountBig} micro-USDC`);
    console.log(`  irisFee:           ${irisFee} micro-USDC`);
    console.log(`  maxFee (buffered): ${maxFee} micro-USDC`);
    console.log(`  totalUsdcNeeded:   ${totalUsdcNeeded} micro-USDC`);
    console.log(`  targetDomain:      ${targetDomain}`);
    console.log(`  recipientAddress:  ${recipientAddress}`);

    // Convert recipient address to bytes32 (left-padded)
    const mintRecipientBytes32 = addressToBytes32(recipientAddress);
    console.log(`  mintRecipient (bytes32): ${mintRecipientBytes32}`);

    // destinationCaller = bytes32(0) → any relayer can complete
    const destinationCaller = "0x0000000000000000000000000000000000000000000000000000000000000000";

    // --- Encode call 1: approve(tokenMessenger, totalUsdcNeeded) ---
    const approveData = encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [tokenMessengerAddress, totalUsdcNeeded]
    });

    // --- Encode call 2: depositForBurn (CCTP V2) ---
    const depositData = encodeFunctionData({
        abi: TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        args: [
            bridgeAmountBig,
            Number(targetDomain),
            mintRecipientBytes32,
            usdcAddress,
            destinationCaller,
            maxFee,
            minFinalityThreshold
        ]
    });

    const calls = [
        { to: usdcAddress, data: approveData, value: "0" },
        { to: tokenMessengerAddress, data: depositData, value: "0" }
    ];

    console.log(`Encoded ${calls.length} calls (approve + depositForBurn).`);

    const response = {
        ...event,
        calls,
        irisFee: irisFee.toString(),
        maxFee: maxFee.toString(),
        totalUsdcNeeded: totalUsdcNeeded.toString(),
        status: "bridge_calls_prepared"
    };

    return safeResponse(response);
};
