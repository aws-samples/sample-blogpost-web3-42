import { formatUnits, erc20Abi } from "viem";
import { getConfiguration } from "../../lib/config.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const { chainKey, calls, userKey = "owner" } = event;

    if (!chainKey || !calls || !Array.isArray(calls)) {
        throw new Error("Invalid input: chainKey and calls array are required.");
    }

    const { client, owner, usdcAddress } = await getConfiguration(chainKey, userKey);

    // Check USDC balance
    const balance = await client.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner.address],
    });

    const formattedBalance = formatUnits(balance, 6);
    console.log(`USDC Balance for ${owner.address} (userKey=${userKey}): ${formattedBalance}`);

    if (parseFloat(formattedBalance) < 1.0) {
        throw new Error(`Insufficient USDC balance: ${formattedBalance}. Need at least 1.0 USDC.`);
    }

    const response = {
        chainKey,
        userKey,
        calls,
        accountAddress: owner.address,
        usdcBalance: formattedBalance,
        status: "validated"
    };

    return safeResponse(response);
};
