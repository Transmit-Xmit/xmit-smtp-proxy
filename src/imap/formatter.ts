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
                if (message.envelope) {
                    parts.push(`ENVELOPE ${formatEnvelope(message.envelope)}`);
                }
                break;
            case "BODYSTRUCTURE":
                if (message.bodyStructure) {
                    parts.push(`BODYSTRUCTURE ${formatBodyStructure(message.bodyStructure)}`);
                }
                break;
            case "BODY":
                if (item.section === undefined || item.section === "") {
                    // Full body
                    if (message.body) {
                        const content = message.body.html || message.body.text || "";
                        parts.push(`BODY[] {${content.length}}\r\n${content}`);
                    }
                } else if (item.section?.toUpperCase() === "HEADER") {
                    // Headers only
                    if (message.body?.headers) {
                        const headers = formatHeaders(message.body.headers);
                        parts.push(`BODY[HEADER] {${headers.length}}\r\n${headers}`);
                    }
                } else if (item.section?.toUpperCase() === "TEXT") {
                    // Body text only
                    const text = message.body?.text || message.body?.html || "";
                    parts.push(`BODY[TEXT] {${text.length}}\r\n${text}`);
                }
                break;
            case "RFC822":
                if (message.body) {
                    const content = message.body.html || message.body.text || "";
                    parts.push(`RFC822 {${content.length}}\r\n${content}`);
                }
                break;
        }
    }

    return `${seqNum} FETCH (${parts.join(" ")})`;
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
        // Multipart: (parts...) "subtype"
        const parts = struct.parts?.map(formatBodyStructure).join("") || "";
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
        return `{${value.length}}\r\n${value}`;
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
    return `LIST ${flagStr} "${delimiter}" "${name}"`;
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
