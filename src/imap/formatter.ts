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

                    // CRITICAL: Use proper CRLF, not escaped literal string
                    parts.push(`${label} {${Buffer.byteLength(finalContent)}}\r\n${finalContent}`);
                };

                const baseLabel = item.peek ? `BODY[${item.section || ""}]` : `BODY[${item.section || ""}]`;

                if (section === "" || section === undefined) {
                    // Full body
                    // If we have raw body stored, use it. Otherwise attempt to reconstruct.
                    // For now, reconstruct as before but keep it simple.
                    const rfc822 = buildRfc822Message(message);
                    processContent(rfc822, baseLabel);
                } else if (section === "HEADER") {
                    // All headers
                    const rfc822 = buildRfc822Message(message);
                    const headerEnd = rfc822.indexOf("\r\n\r\n");
                    const headers = headerEnd !== -1 ? rfc822.slice(0, headerEnd + 4) : rfc822;
                    processContent(headers, baseLabel);
                } else if (section.startsWith("HEADER.FIELDS")) {
                    // Specific headers logic (unchanged)
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
                    // RFC 3501: BODY[TEXT] is the text part of the message.
                    // If multipart, it's the body structure excluding the main header.
                    // If single part, it's the content.

                    const rfc822 = buildRfc822Message(message);
                    const headerEnd = rfc822.indexOf("\r\n\r\n");
                    const text = headerEnd !== -1 ? rfc822.slice(headerEnd + 4) : "";
                    processContent(text, baseLabel);
                } else if (/^\d+(\.\d+)*$/.test(section)) {
                    // MIME part fetching
                    // 1 = Text, 2 = HTML (simplified assumption based on our buildRfc822Message)
                    if (message.body?.text && message.body?.html) {
                        if (section === "1") processContent(message.body.text, baseLabel);
                        else if (section === "2") processContent(message.body.html, baseLabel);
                        else processContent("", baseLabel);
                    } else {
                        const content = message.body?.html || message.body?.text || "";
                        if (section === "1") processContent(content, baseLabel);
                        else processContent("", baseLabel);
                    }
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
                    const minHeaders = buildHeadersFromEnvelope(message.envelope) || {};
                    const headers = formatHeaders(minHeaders);
                    parts.push(`RFC822.HEADER {${Buffer.byteLength(headers)}}\r\n${headers}`);
                } else {
                    parts.push(`RFC822.HEADER {2}\r\n\r\n`);
                }
                break;
            case "RFC822.TEXT":
                // Return just the body text (content only, no headers)
                // This seems redundant with BODY[TEXT] but strict RFC822.TEXT definition roughly matches.
                // We'll use the same extraction logic.
                const fullMsg = buildRfc822Message(message);
                const hdrEnd = fullMsg.indexOf("\r\n\r\n");
                const bodyText = hdrEnd !== -1 ? fullMsg.slice(hdrEnd + 4) : "";
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
    const boundary = "----=_Part_" + message.uid + "_xmit";
    const hasText = !!message.body?.text;
    const hasHtml = !!message.body?.html;
    const isMultipart = hasText && hasHtml;

    // Add headers - prefer body.headers, fallback to envelope
    const headers = message.body?.headers || buildHeadersFromEnvelope(message.envelope) || {};

    for (const [key, value] of Object.entries(headers)) {
        // Skip Content-Type if we are generating it
        if (key.toLowerCase() === "content-type") continue;
        lines.push(`${key}: ${value}`);
    }

    // Add content-type header
    if (isMultipart) {
        lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    } else if (hasHtml) {
        lines.push("Content-Type: text/html; charset=utf-8");
    } else {
        lines.push("Content-Type: text/plain; charset=utf-8");
    }

    // Empty line separates headers from body
    lines.push("");

    // Add body content
    if (isMultipart) {
        // Text part
        lines.push(`--${boundary}`);
        lines.push("Content-Type: text/plain; charset=utf-8");
        lines.push("");
        lines.push(ensureCrlf(message.body!.text || ""));

        // HTML part
        lines.push(`--${boundary}`);
        lines.push("Content-Type: text/html; charset=utf-8");
        lines.push("");
        lines.push(ensureCrlf(message.body!.html || ""));

        // End boundary
        lines.push(`--${boundary}--`);
    } else if (hasHtml) {
        lines.push(ensureCrlf(message.body?.html || ""));
    } else {
        lines.push(ensureCrlf(message.body?.text || ""));
    }

    return lines.join("\r\n");
}

/**
 * Ensure string uses CRLF line endings
 */
function ensureCrlf(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
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
