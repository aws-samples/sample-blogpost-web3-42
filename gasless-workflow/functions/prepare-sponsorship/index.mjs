import { encodePacked } from "viem";
import { getConfiguration } from "../../lib/config.mjs";
import { signPermit } from "../../lib/permit.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const { chainKey, accountAddress, userKey = "owner" } = event;

    console.log(`Loading configuration for userKey='${userKey}' on chainKey='${chainKey}'...`);
    const { client, owner, usdcAddress, paymasterAddress, usdcDomainParams } =
        await getConfiguration(chainKey, userKey);
    console.log(`Config loaded. Owner: ${owner.address}, USDC: ${usdcAddress}`);

    if (owner.address.toLowerCase() !== accountAddress.toLowerCase()) {
        throw new Error("Account address mismatch");
    }

    // Permit amount: 20 USDC (20,000,000 units) - matches the reference implementation.
    // The CCTP batch (approve + depositForBurn) consumes more gas than a simple transfer,
    // so 10 USDC was insufficient for the Paymaster postOp fee collection (AA33).
    const permitAmount = 20000000n;

    console.log("Signing USDC permit (invoking lib/permit.mjs)...");
    const permitSignature = await signPermit({
        tokenAddress: usdcAddress,
        client,
        account: owner,
        spenderAddress: paymasterAddress,
        permitAmount,
        name: usdcDomainParams.name,
        version: usdcDomainParams.version,
    });
    console.log("Permit Signature:", permitSignature);

    // Encode Paymaster Data for Circle Paymaster v2 (Mode 0: Permit + Signature)
    // Format: [mode (uint8), token (address), amount (uint256), signature (bytes)]
    const paymasterData = encodePacked(
        ["uint8", "address", "uint256", "bytes"],
        [0, usdcAddress, permitAmount, permitSignature]
    );

    const response = {
        chainKey,
        userKey,
        calls: event.calls,
        accountAddress,
        permitSignature,
        paymasterData,
        paymasterAddress,
        status: "sponsorship_prepared"
    };

    return safeResponse(response);
};
