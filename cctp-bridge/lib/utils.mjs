/**
 * Safely serialize a response object, converting BigInt values to strings
 * so the result can be passed through Step Functions (which only supports JSON).
 *
 * @param {object} obj
 * @returns {object}
 */
export function safeResponse(obj) {
    return JSON.parse(
        JSON.stringify(obj, (_, value) =>
            typeof value === "bigint" ? value.toString() : value
        )
    );
}
