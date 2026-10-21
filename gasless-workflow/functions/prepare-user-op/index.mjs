import { encodeFunctionData } from "viem";
import { getConfiguration, getAccount } from "../../lib/config.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const { chainKey, calls, accountAddress, userKey = "owner" } = event;

    const { client, owner } = await getConfiguration(chainKey, userKey);

    const smartAccount = await getAccount(client, owner);

    // Encode calls from input intent.
    // Two supported input shapes:
    //   - Structured: { to, abi, functionName, args, value? }  (structured form)
    //   - Pre-encoded: { to, data, value? }                    (used by the CCTP bridge)
    const encodedCalls = calls.map(call => {
        if (call.data) {
            return {
                to: call.to,
                data: call.data,
                value: BigInt(call.value || 0),
            };
        }
        const abi = typeof call.abi === "string" ? JSON.parse(call.abi) : call.abi;
        return {
            to: call.to,
            data: encodeFunctionData({
                abi,
                functionName: call.functionName,
                args: call.args,
            }),
            value: BigInt(call.value || 0),
        };
    });

    console.log("Signing EIP-7702 Authorization...");
    const nonce = await client.getTransactionCount({ address: owner.address });
    const authorization = await owner.signAuthorization({
        contractAddress: smartAccount.authorization.address,
        chainId: client.chain.id,
        nonce,
    });

    const response = {
        chainKey,
        userKey,
        accountAddress,
        encodedCalls: encodedCalls.map(c => ({ ...c, value: c.value.toString() })),
        authorization,
        paymasterData: event.paymasterData,
        paymasterAddress: event.paymasterAddress,
        status: "user_op_prepared"
    };

    // Safely handle BigInts for JSON serialization
    return safeResponse(response);
};
