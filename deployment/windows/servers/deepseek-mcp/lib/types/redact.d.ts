/**
 * Secret redaction helpers. Every bridge log line and every tool output that
 * can carry caller or DSH error text passes through these so credentials,
 * tokens, cookies and API keys never leak into logs or MCP results.
 */
/** True when text contains a secret-shaped token, key assignment, or bearer value. */
export declare function containsSecret(text: string): boolean;
/** Redact secret-shaped substrings from one text value. */
export declare function redactText(text: string): string;
/**
 * Deep-redact a JSON value: secret-shaped keys become '[REDACTED]' and
 * secret-shaped substrings inside string values are masked. Returns a new
 * value; the input is never mutated.
 */
export declare function redactValue(value: unknown): unknown;
/** Redact a message plus optional payload into one safe log line. */
export declare function redactMessage(message: string, payload?: unknown): string;
