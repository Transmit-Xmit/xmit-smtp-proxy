/**
 * IMAP Response Formatter
 * Formats IMAP responses for sending to clients
 */
import type { ImapResponse, ImapEnvelope, ImapAddress, BodyStructure, MailboxMessage } from "../shared/types.js";
import type { FetchItem } from "./parser.js";

/**
 * Format an IMAP response for sending
 */
export function formatResponse(response: ImapResponse): string {
    if (response.type === "continuation") {
        return `+ ${response.message || ""}`;
    }

    if (response.type === "untagged") {
        return `* ${response.data || response.message || ""}`;
    }

    // Tagged response
    const code = response.code ? `[${response.code}] ` : "";
    return `${response.tag} ${response.status} ${code}${response.message || ""}`;
}

/**
 * Format a FETCH response for a single message
 */
export function formatFetchResponse(
    seqNum: number,
    message: MailboxMessage,
    items: FetchItem[]
): string {
    const parts: string[] = [];

    for (const item of items) {
        switch (item.type) {
            case "FLAGS":
                parts.push(`FLAGS (${message.flags.join(" ")})`);
                break;
            case "UID":
                parts.push(`UID ${message.uid}`);
                break;
            case "INTERNALDATE":
                parts.push(`INTERNALDATE "${formatImapDate(message.internalDate)}"`);
                break;
            case "RFC822.SIZE":
                parts.push(`RFC822.SIZE ${message.size}`);
                break;
            case "ENVELOPE":
                // Use envelope if available, or build from body headers
                const envelope = message.envelope || buildEnvelopeFromHeaders(message.body?.headers, message.internalDate);
                if (envelope) {
                    parts.push(`ENVELOPE ${formatEnvelope(envelope)}`);
                }
                break;
            case "BODYSTRUCTURE":
                if (message.bodyStructure) {
                    const bs = formatBodyStructure(message.bodyStructure);
                    parts.push(`BODYSTRUCTURE ${bs}`);
                }
                break;
            case "BODY":
                const section = item.section?.toUpperCase() || "";

                // Helper to process content with partial support
                const processContent = (content: string, label: string) => {
                    let finalContent = content;

                    if (item.partial) {
                        const buf = Buffer.from(content);
                        const start = item.partial.start;
                        const validStart = Math.min(start, buf.length);
                        const length = item.partial.length;

                        // Slice buffer
                        const slice = buf.subarray(validStart, validStart + length);
                        // Convert back to string (safe UTF-8, might insert replacement chars)
                        finalContent = slice.toString();

                        // Update label with origin
                        label += `<${validStart}>`;
                    }

                    parts.push(`${label} {${Buffer.byteLength(finalContent)}}\r\n${finalContent}`);
                };

                const baseLabel = item.peek ? `BODY[${item.section || ""}]` : `BODY[${item.section || ""}]`;

                if (section === "" || section === undefined) {
                    // Full body
                    const rfc822 = buildRfc822Message(message);
                    processContent(rfc822, baseLabel);
                } else if (section === "HEADER") {
                    // All headers
                    const availableHeaders = message.body?.headers || buildHeadersFromEnvelope(message.envelope);
                    if (availableHeaders) {
                        const headers = formatHeaders(availableHeaders);
                        processContent(headers, baseLabel);
                    } else {
                        processContent("", baseLabel);
                    }
                } else if (section.startsWith("HEADER.FIELDS")) {
                    // Specific headers
                    const fieldMatch = section.match(/HEADER\.FIELDS\s*\(([^)]+)\)/i);
                    if (fieldMatch) {
                        const requestedFields = fieldMatch[1].toLowerCase().split(/\s+/);
                        const availableHeaders = message.body?.headers || buildHeadersFromEnvelope(message.envelope);
                        const filteredHeaders: Record<string, string> = {};

                        if (availableHeaders) {
                            for (const [key, value] of Object.entries(availableHeaders)) {
                                if (requestedFields.includes(key.toLowerCase())) {
                                    filteredHeaders[key] = value;
                                }
                            }
                        }

                        const headers = formatHeaders(filteredHeaders);
                        processContent(headers, `BODY[${item.section}]`);
                    } else {
                        processContent("", `BODY[${item.section}]`);
                    }
                } else if (section === "TEXT") {
                    // Body text only
                    const text = message.body?.text || message.body?.html || "";
                    processContent(text, baseLabel);
                } else if (/^\d+(\.\d+)*$/.test(section)) {
                    // MIME part number
                    const content = message.body?.html || message.body?.text || "";
                    processContent(content, baseLabel);
                } else {
                    // Unknown section
                    processContent("", baseLabel);
                }
                break;
            case "RFC822":
                if (message.body) {
                    const rfc822 = buildRfc822Message(message);
                    parts.push(`RFC822 {${Buffer.byteLength(rfc822)}}\r\n${rfc822}`);
                }
                break;
            case "RFC822.HEADER":
                // Return just the headers (RFC 2822 format)
                if (message.body?.headers) {
                    const headers = formatHeaders(message.body.headers);
                    parts.push(`RFC822.HEADER {${Buffer.byteLength(headers)}}\r\n${headers}`);
                } else if (message.envelope) {
                    // Build minimal headers from envelope
                    const minHeaders: Record<string, string> = {};
                    if (message.envelope.date) minHeaders["Date"] = message.envelope.date;
                    if (message.envelope.subject) minHeaders["Subject"] = message.envelope.subject;
                    if (message.envelope.from?.length) {
                        const from = message.envelope.from[0];
                        minHeaders["From"] = from.name
                            ? `${from.name} <${from.mailbox}@${from.host}>`
                            : `${from.mailbox}@${from.host}`;
                    }
                    if (message.envelope.messageId) {
                        minHeaders["Message-ID"] = `<${message.envelope.messageId}>`;
                    }
                    const headers = formatHeaders(minHeaders);
                    parts.push(`RFC822.HEADER {${Buffer.byteLength(headers)}}\r\n${headers}`);
                } else {
                    parts.push(`RFC822.HEADER {2}\r\n\r\n`);
                }
                break;
            case "RFC822.TEXT":
                // Return just the body text
                const bodyText = message.body?.text || message.body?.html || "";
                parts.push(`RFC822.TEXT {${Buffer.byteLength(bodyText)}}\r\n${bodyText}`);
                break;
        }
    }

    return `${seqNum} FETCH (${parts.join(" ")})`;
}

/**
 * Build a simple RFC822 message from body data
 */
function buildRfc822Message(message: MailboxMessage): string {
    const lines: string[] = [];

    // Add headers - prefer body.headers, fallback to envelope
    if (message.body?.headers && Object.keys(message.body.headers).length > 0) {
        for (const [key, value] of Object.entries(message.body.headers)) {
            lines.push(`${key}: ${value}`);
        }
    } else if (message.envelope) {
        // Build headers from envelope
        if (message.envelope.date) lines.push(`Date: ${message.envelope.date}`);
        if (message.envelope.subject) lines.push(`Subject: ${message.envelope.subject}`);
        if (message.envelope.from?.length) {
            const from = message.envelope.from[0];
            const addr = from.name ? `${from.name} <${from.mailbox}@${from.host}>` : `${from.mailbox}@${from.host}`;
            lines.push(`From: ${addr}`);
        }
        if (message.envelope.to?.length) {
            const toAddrs = message.envelope.to.map(t =>
                t.name ? `${t.name} <${t.mailbox}@${t.host}>` : `${t.mailbox}@${t.host}`
            );
            lines.push(`To: ${toAddrs.join(", ")}`);
        }
        if (message.envelope.messageId) lines.push(`Message-ID: <${message.envelope.messageId}>`);
    }

    // Add content-type header
    if (message.body?.html) {
        lines.push("Content-Type: text/html; charset=utf-8");
    } else if (message.body?.text) {
        lines.push("Content-Type: text/plain; charset=utf-8");
    } else {
        // Default content type for empty bodies
        lines.push("Content-Type: text/plain; charset=utf-8");
    }

    // Empty line separates headers from body
    lines.push("");

    // Add body content
    if (message.body?.html) {
        lines.push(message.body.html);
    } else if (message.body?.text) {
        lines.push(message.body.text);
    }
    // Empty body is valid - just headers + empty line

    return lines.join("\r\n");
}

/**
 * Build headers from envelope data when body.headers is not available
 */
function buildHeadersFromEnvelope(envelope: ImapEnvelope | undefined): Record<string, string> | null {
    if (!envelope) return null;

    const headers: Record<string, string> = {};

    if (envelope.date) headers["Date"] = envelope.date;
    if (envelope.subject) headers["Subject"] = envelope.subject;
    if (envelope.messageId) headers["Message-ID"] = `<${envelope.messageId}>`;
    if (envelope.inReplyTo) headers["In-Reply-To"] = envelope.inReplyTo;

    if (envelope.from?.length) {
        headers["From"] = formatAddressForHeader(envelope.from);
    }
    if (envelope.to?.length) {
        headers["To"] = formatAddressForHeader(envelope.to);
    }
    if (envelope.cc?.length) {
        headers["Cc"] = formatAddressForHeader(envelope.cc);
    }
    if (envelope.bcc?.length) {
        headers["Bcc"] = formatAddressForHeader(envelope.bcc);
    }
    if (envelope.replyTo?.length) {
        headers["Reply-To"] = formatAddressForHeader(envelope.replyTo);
    }

    return Object.keys(headers).length > 0 ? headers : null;
}

/**
 * Build envelope from message headers (reverse of buildHeadersFromEnvelope)
 * Used when API returns body with headers but no envelope
 */
function buildEnvelopeFromHeaders(headers: Record<string, string> | undefined, internalDate?: string): ImapEnvelope | null {
    if (!headers || Object.keys(headers).length === 0) return null;

    const envelope: ImapEnvelope = {
        date: headers["Date"] || headers["date"] || internalDate || null,
        subject: headers["Subject"] || headers["subject"] || null,
        from: parseAddressHeader(headers["From"] || headers["from"]),
        sender: parseAddressHeader(headers["Sender"] || headers["sender"]),
        replyTo: parseAddressHeader(headers["Reply-To"] || headers["reply-to"]),
        to: parseAddressHeader(headers["To"] || headers["to"]),
        cc: parseAddressHeader(headers["Cc"] || headers["cc"]),
        bcc: parseAddressHeader(headers["Bcc"] || headers["bcc"]),
        inReplyTo: headers["In-Reply-To"] || headers["in-reply-to"] || null,
        messageId: extractMessageId(headers["Message-ID"] || headers["message-id"]),
    };

    // If sender not set, copy from
    if (!envelope.sender) envelope.sender = envelope.from;
    if (!envelope.replyTo) envelope.replyTo = envelope.from;

    return envelope;
}

/**
 * Parse email address header into ImapAddress array
 * Handles formats like: "Name <email@domain.com>" or "email@domain.com"
 */
function parseAddressHeader(value: string | undefined): ImapAddress[] | null {
    if (!value) return null;

    const addresses: ImapAddress[] = [];

    // Split by comma (handles multiple addresses)
    const parts = value.split(/,\s*/);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Try to parse "Name <email@domain>" format
        const match = trimmed.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
        if (match) {
            const [, name, email] = match;
            const [mailbox, host] = email.split("@");
            if (mailbox && host) {
                addresses.push({
                    name: name?.trim() || null,
                    adl: null,
                    mailbox,
                    host,
                });
            }
        } else if (trimmed.includes("@")) {
            // Plain email address
            const [mailbox, host] = trimmed.split("@");
            if (mailbox && host) {
                addresses.push({
                    name: null,
                    adl: null,
                    mailbox,
                    host,
                });
            }
        }
    }

    return addresses.length > 0 ? addresses : null;
}

/**
 * Extract message ID without angle brackets
 */
function extractMessageId(value: string | undefined): string | null {
    if (!value) return null;
    // Remove angle brackets if present
    return value.replace(/^<|>$/g, "").trim() || null;
}

/**
 * Format address list for header value
 */
function formatAddressForHeader(addresses: ImapAddress[]): string {
    return addresses.map(addr => {
        if (addr.name) {
            return `${addr.name} <${addr.mailbox}@${addr.host}>`;
        }
        return `${addr.mailbox}@${addr.host}`;
    }).join(", ");
}

/**
 * Format date for IMAP INTERNALDATE
 */
function formatImapDate(dateStr: string): string {
    const date = new Date(dateStr);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const day = date.getUTCDate().toString().padStart(2, " ");
    const month = months[date.getUTCMonth()];
    const year = date.getUTCFullYear();
    const hours = date.getUTCHours().toString().padStart(2, "0");
    const mins = date.getUTCMinutes().toString().padStart(2, "0");
    const secs = date.getUTCSeconds().toString().padStart(2, "0");

    return `${day}-${month}-${year} ${hours}:${mins}:${secs} +0000`;
}

/**
 * Format ENVELOPE for IMAP
 */
function formatEnvelope(env: ImapEnvelope): string {
    const parts = [
        formatNil(env.date),
        formatNil(env.subject),
        formatAddressList(env.from),
        formatAddressList(env.sender),
        formatAddressList(env.replyTo),
        formatAddressList(env.to),
        formatAddressList(env.cc),
        formatAddressList(env.bcc),
        formatNil(env.inReplyTo),
        formatNil(env.messageId),
    ];

    return `(${parts.join(" ")})`;
}

/**
 * Format address list for IMAP
 */
function formatAddressList(addresses: ImapAddress[] | null): string {
    if (!addresses || addresses.length === 0) {
        return "NIL";
    }

    const formatted = addresses.map(formatAddress);
    return `(${formatted.join("")})`;
}

/**
 * Format single address for IMAP
 */
function formatAddress(addr: ImapAddress): string {
    return `(${formatNil(addr.name)} ${formatNil(addr.adl)} ${formatString(addr.mailbox)} ${formatString(addr.host)})`;
}

/**
 * Format BODYSTRUCTURE for IMAP
 */
function formatBodyStructure(struct: BodyStructure): string {
    if (struct.type.toLowerCase() === "multipart") {
        // Multipart: (part1)(part2)... "subtype" - parts are space-separated per RFC 3501
        const parts = struct.parts?.map(formatBodyStructure).join(" ") || "";
        return `(${parts} "${struct.subtype.toUpperCase()}")`;
    }

    // Single part: "type" "subtype" params id description encoding size [lines]
    const params = struct.params ? formatParams(struct.params) : "NIL";

    return `("${struct.type.toUpperCase()}" "${struct.subtype.toUpperCase()}" ${params} ${formatNil(struct.id)} ${formatNil(struct.description)} "${struct.encoding || "7BIT"}" ${struct.size || 0}${struct.lines !== undefined ? ` ${struct.lines}` : ""})`;
}

/**
 * Format parameters for BODYSTRUCTURE
 */
function formatParams(params: Record<string, string>): string {
    const entries = Object.entries(params);
    if (entries.length === 0) return "NIL";

    const formatted = entries.map(([k, v]) => `"${k.toUpperCase()}" "${v}"`).join(" ");
    return `(${formatted})`;
}

/**
 * Format headers as RFC 2822 string
 */
function formatHeaders(headers: Record<string, string>): string {
    return Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") + "\r\n\r\n";
}

/**
 * Format NIL or quoted string
 */
function formatNil(value: string | null | undefined): string {
    if (value === null || value === undefined) {
        return "NIL";
    }
    return formatString(value);
}

/**
 * Format a string for IMAP (with proper quoting)
 */
function formatString(value: string): string {
    // Check if needs quoting
    if (/[\r\n"]/.test(value) || value.length > 100) {
        // Use literal
        return `{${Buffer.byteLength(value)}}\r\n${value}`;
    }
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Format LIST response
 */
export function formatListResponse(
    name: string,
    delimiter: string,
    flags: string[]
): string {
    const flagStr = flags.length > 0 ? `(${flags.join(" ")})` : "()";
    // Escape special characters in folder name per RFC 3501
    const escapedName = escapeImapString(name);
    const escapedDelim = delimiter ? `"${delimiter}"` : "NIL";
    return `LIST ${flagStr} ${escapedDelim} ${escapedName}`;
}

/**
 * Escape a string for IMAP (handles quotes, backslashes, and uses literals for long/special strings)
 */
function escapeImapString(value: string): string {
    // Use literal for strings with CR/LF or very long strings
    if (/[\r\n]/.test(value) || value.length > 200) {
        return `{${Buffer.byteLength(value)}}\r\n${value}`;
    }
    // Escape backslashes and quotes
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
}

/**
 * Format STATUS response
 */
export function formatStatusResponse(
    name: string,
    items: Record<string, number>
): string {
    const parts = Object.entries(items).map(([k, v]) => `${k} ${v}`);
    return `STATUS "${name}" (${parts.join(" ")})`;
}
