import { encodeFunctionData } from "viem";
import { getConfiguration } from "../../lib/config.mjs";
import { MESSAGE_TRANSMITTER_ABI } from "../../lib/cctp.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const {
        destChainKey,
        message,
        attestation
    } = event;

    if (!destChainKey) {
        throw new Error("Invalid input: 'destChainKey' is required.");
    }
    if (!message || !attestation) {
        throw new Error("Invalid input: 'message' and 'attestation' are required. Run GetAttestation first.");
    }

    // Load destination-chain config to get messageTransmitterAddress
    const { messageTransmitterAddress } = await getConfiguration(destChainKey, "recipient");

    if (!messageTransmitterAddress) {
        throw new Error(`Missing ${destChainKey.toUpperCase()}_MESSAGE_TRANSMITTER_ADDRESS environment variable.`);
    }

    console.log(`Encoding receiveMessage on ${destChainKey} → transmitter: ${messageTransmitterAddress}`);

    // Encode receiveMessage(message, attestation)
    const callData = encodeFunctionData({
        abi: MESSAGE_TRANSMITTER_ABI,
        functionName: "receiveMessage",
        args: [message, attestation]
    });

    // This intentionally replaces the source-chain `calls` array from PrepareBridgeCalls.
    // The dest-side call is the only thing the gasless workflow needs to execute next.
    const calls = [
        { to: messageTransmitterAddress, data: callData, value: "0" }
    ];

    console.log("receiveMessage call encoded successfully.");

    const response = {
        ...event,
        calls,
        status: "receive_call_prepared"
    };

    return safeResponse(response);
};
