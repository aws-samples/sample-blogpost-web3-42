import { erc20Abi, formatUnits } from "viem";
import { toSimple7702SmartAccount } from "viem/account-abstraction";
import { getConfiguration } from "../../lib/config.mjs";
import { getDomainForChain } from "../../lib/cctp.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const {
        sourceChainKey,
        destChainKey,
        bridgeAmount,
        recipientAddress: recipientAddressOverride
    } = event;

    // --- Input validation ---
    if (!sourceChainKey || typeof sourceChainKey !== "string") {
        throw new Error("Invalid input: 'sourceChainKey' is required.");
    }
    if (!destChainKey || typeof destChainKey !== "string") {
        throw new Error("Invalid input: 'destChainKey' is required.");
    }
    if (!bridgeAmount || typeof bridgeAmount !== "string") {
        throw new Error("Invalid input: 'bridgeAmount' is required as a string (micro-USDC).");
    }
    if (sourceChainKey === destChainKey) {
        throw new Error(`'sourceChainKey' and 'destChainKey' must differ. Both are '${sourceChainKey}'.`);
    }

    // --- Derive CCTP domain IDs (throws on unsupported chain keys) ---
    const sourceDomain = getDomainForChain(sourceChainKey);
    const targetDomain = getDomainForChain(destChainKey);

    console.log(`Bridge route: ${sourceChainKey} (domain ${sourceDomain}) → ${destChainKey} (domain ${targetDomain})`);
    console.log(`Bridge amount: ${bridgeAmount} micro-USDC`);

    // --- Load configs for both actors ---
    const sourceConfig = await getConfiguration(sourceChainKey, "owner");
    const destConfig = await getConfiguration(destChainKey, "recipient");

    // --- Derive SCA addresses for both actors ---
    const ownerSCA = await toSimple7702SmartAccount({
        client: sourceConfig.client,
        owner: sourceConfig.owner,
    });
    const recipientSCA = await toSimple7702SmartAccount({
        client: destConfig.client,
        owner: destConfig.owner,
    });

    const ownerAddress = ownerSCA.address;
    const recipientScaAddr = recipientSCA.address;

    // --- Check USDC balances ---
    const [ownerBalance, destBalance] = await Promise.all([
        sourceConfig.client.readContract({
            address: sourceConfig.usdcAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [ownerAddress],
        }),
        destConfig.client.readContract({
            address: destConfig.usdcAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [recipientScaAddr],
        }),
    ]);

    const formattedOwnerBalance = formatUnits(ownerBalance, 6);
    const formattedDestBalance = formatUnits(destBalance, 6);

    console.log(`Owner (${ownerAddress}) USDC on ${sourceChainKey}: ${formattedOwnerBalance}`);
    console.log(`Recipient SCA (${recipientScaAddr}) USDC on ${destChainKey}: ${formattedDestBalance}`);

    if (parseFloat(formattedOwnerBalance) < 1.0) {
        throw new Error(
            `Insufficient owner USDC on ${sourceChainKey}: ${formattedOwnerBalance} USDC. ` +
            `Need at least 1.0 USDC to cover bridge amount + fees.`
        );
    }
    if (parseFloat(formattedDestBalance) < 1.0) {
        throw new Error(
            `Insufficient recipient USDC on ${destChainKey}: ${formattedDestBalance} USDC. ` +
            `The recipient needs at least 1.0 USDC to pay destination-side Paymaster fees.`
        );
    }

    // --- Resolve final recipient address (event override wins; otherwise use SCA) ---
    const recipientAddress = recipientAddressOverride || recipientScaAddr;
    console.log(`Resolved recipientAddress: ${recipientAddress}`);

    const response = {
        sourceChainKey,
        destChainKey,
        sourceDomain,
        targetDomain,
        bridgeAmount,
        ownerAddress,
        recipientAddress,
        sourceUsdcBalance: formattedOwnerBalance,
        destUsdcBalance: formattedDestBalance,
        status: "bridge_request_validated"
    };

    return safeResponse(response);
};
