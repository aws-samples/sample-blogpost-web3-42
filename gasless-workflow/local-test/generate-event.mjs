import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { erc20Abi } from "viem";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVENT_PATH = path.join(__dirname, "test-event.json");

async function generateEvent() {
    console.log("Generating test-event.json from .env...");

    const recipientAddress = process.env.RECIPIENT_ADDRESS;
    const chainKey = process.env.CHAIN_KEY || "eth";
    const envPrefix = chainKey.toUpperCase() + "_";
    const usdcAddress = process.env[`${envPrefix}USDC_ADDRESS`];

    if (!recipientAddress || !usdcAddress) {
        console.error("❌ RECIPIENT_ADDRESS or USDC_ADDRESS missing in .env.");
        console.log("Please ensure .env exists in this directory.");
        process.exit(1);
    }

    // The event contains addresses only, never a private key.
    const testEvent = {
        chainKey,
        userKey: "owner",
        calls: [
            {
                to: usdcAddress,
                abi: JSON.stringify(erc20Abi),
                functionName: "transfer",
                args: [recipientAddress, "1000000"] // 1 USDC
            }
        ]
    };

    fs.writeFileSync(EVENT_PATH, JSON.stringify(testEvent, null, 2));

    console.log(`✅ Success! Generated ${EVENT_PATH}`);
    console.log(`Target: ${recipientAddress} on ${chainKey}`);
}

generateEvent().catch(console.error);
