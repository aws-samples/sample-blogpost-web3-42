import { createBundlerClient } from "viem/account-abstraction";
import { http, hexToBigInt } from "viem";
import { getConfiguration, getAccount, getExplorerUrl } from "../../lib/config.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const {
        chainKey,
        userKey = "owner",
        encodedCalls,
        authorization,
        paymasterData,
        paymasterAddress
    } = event;

    const { client, owner } = await getConfiguration(chainKey, userKey);
    const smartAccount = await getAccount(client, owner);

    const pimlicoUrl = `https://public.pimlico.io/v2/${client.chain.id}/rpc`;

    // Define paymaster logic at client level
    const paymaster = {
        async getPaymasterData() {
            console.log("Providing paymaster data to bundler...");
            return {
                paymaster: paymasterAddress,
                paymasterData: paymasterData,
                // Gas limits for the Paymaster's own validation and post-operation steps.
                // These are fixed values, not estimates, so they must be high enough:
                //  - Validation (EIP-2612 permit plus USDC pre-charge): 200,000 failed on
                //    Ethereum Sepolia with "AA33 reverted 0x" (empty revert data), while
                //    500,000 succeeded.
                //  - Post-operation: 15,000 was rejected by the Paymaster. 35,000 is the value
                //    used in Circle's Paymaster v0.8 quickstart.
                paymasterVerificationGasLimit: 500000n,
                paymasterPostOpGasLimit: 35000n,
                isFinal: true
            };
        }
    };

    console.log("Runtime Diagnostics:");
    console.log(`- chainKey: ${chainKey} / userKey: ${userKey}`);
    console.log(`- EntryPoint: ${smartAccount.entryPoint.address}`);
    console.log(`- Smart Account Type: ${smartAccount.type}`);

    const bundlerClient = createBundlerClient({
        account: smartAccount,
        client,
        paymaster,
        userOperation: {
            estimateFeesPerGas: async ({ bundlerClient }) => {
                const { standard: fees } = await bundlerClient.request({
                    method: "pimlico_getUserOperationGasPrice",
                });
                console.log("Estimated Fees:", JSON.stringify(fees));
                return {
                    maxFeePerGas: hexToBigInt(fees.maxFeePerGas),
                    maxPriorityFeePerGas: hexToBigInt(fees.maxPriorityFeePerGas)
                };
            },
        },
        transport: http(pimlicoUrl),
        chain: client.chain,
    });

    console.log("Preparing UserOperation...");

    // We need to parse back BigInt values
    const calls = encodedCalls.map(c => ({
        to: c.to,
        data: c.data,
        value: BigInt(c.value)
    }));

    // Re-hydrate authorization object
    const formattedAuthorization = {
        ...authorization,
        chainId: Number(authorization.chainId),
        nonce: BigInt(authorization.nonce ?? 0),
        v: authorization.v !== undefined ? BigInt(authorization.v) : undefined,
        yParity: authorization.yParity !== undefined ? Number(authorization.yParity) : undefined,
    };

    console.log("Submitting UserOperation...");
    const userOpHash = await bundlerClient.sendUserOperation({
        calls,
        authorization: formattedAuthorization,
    });

    console.log("UserOp Hash:", userOpHash);

    console.log("Waiting for transaction receipt (this may take 15-30s)...");
    const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOpHash,
    });

    const transactionHash = receipt.receipt.transactionHash;
    console.log("Transaction Hash:", transactionHash);

    // Structured, machine-readable summary: this is the canonical output of the gasless workflow
    // and the contract that the CCTP bridge and the agent tools rely on when invoking this
    // state machine via startExecution.sync:2.
    const response = {
        status: "SUCCEEDED",
        chainKey,
        userKey,
        transactionHash,
        userOpHash,
        accountAddress: smartAccount.address,
        explorerUrl: getExplorerUrl(chainKey, transactionHash)
    };

    return safeResponse(response);
};
