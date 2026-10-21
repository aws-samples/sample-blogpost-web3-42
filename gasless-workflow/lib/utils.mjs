/**
 * Shared utilities for the Step Function workflow
 */

/**
 * Safely serializes an object containing BigInts for JSON response.
 * @param {Object} data The data to serialize
 * @returns {Object} A JSON-safe object with BigInts converted to strings
 */
export function safeResponse(data) {
    return JSON.parse(
        JSON.stringify(data, (key, value) =>
            typeof value === "bigint" ? value.toString() : value
        )
    );
}

/**
 * Formats a BigInt or hex string to a human-readable number string (optional)
 */
export function formatBigInt(value) {
    if (typeof value === "bigint") return value.toString();
    return value;
}
