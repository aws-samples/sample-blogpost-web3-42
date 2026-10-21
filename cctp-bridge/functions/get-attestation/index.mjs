import { pollAttestation } from "../../lib/cctp.mjs";
import { safeResponse } from "../../lib/utils.mjs";

export const handler = async (event) => {
    console.log("Event:", JSON.stringify(event, null, 2));

    const {
        sourceDomain,
        sourceTxHash,
        attestationAttempts = 0
    } = event;

    if (!sourceTxHash) {
        throw new Error("Invalid input: 'sourceTxHash' is required. Run the source-chain gasless workflow invocation first.");
    }
    if (sourceDomain === undefined || sourceDomain === null) {
        throw new Error("Invalid input: 'sourceDomain' is required.");
    }

    console.log(`Polling attestation — attempt ${attestationAttempts + 1}/60`);
    console.log(`  sourceDomain: ${sourceDomain}`);
    console.log(`  sourceTxHash: ${sourceTxHash}`);

    // Single Iris poll — Step Functions owns the retry cadence (Wait + Choice)
    const attestationResult = await pollAttestation(Number(sourceDomain), sourceTxHash);

    const response = {
        ...event,
        attestationReady: attestationResult.attestationReady,
        attestationAttempts: attestationAttempts,
        ...(attestationResult.attestationReady ? {
            message: attestationResult.message,
            attestation: attestationResult.attestation,
            eventNonce: attestationResult.eventNonce
        } : {})
    };

    if (attestationResult.attestationReady) {
        console.log("✅ Attestation ready! eventNonce:", attestationResult.eventNonce);
    } else {
        console.log(`⏳ Attestation not ready yet (attempt ${attestationAttempts + 1}). SF will wait and retry.`);
    }

    return safeResponse(response);
};
