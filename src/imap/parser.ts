/**
 * IMAP Command Parser
 * Parses IMAP protocol commands from raw strings
 */
import type { ImapCommand } from "../shared/types.js";

/**
 * Parse an IMAP command line
 * Format: tag command [arguments...]
 */
export function parseCommand(line: string): ImapCommand {
    const raw = line;
    const parts: string[] = [];
    let current = "";
    let inQuotes = false;
    let inBrackets = 0;
    let inParens = 0;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"' && line[i - 1] !== "\\") {
            inQuotes = !inQuotes;
            current += char;
        } else if (!inQuotes) {
            if (char === "[") inBrackets++;
            if (char === "]") inBrackets--;
            if (char === "(") inParens++;
            if (char === ")") inParens--;

            if (char === " " && inBrackets === 0 && inParens === 0) {
                if (current) {
                    parts.push(current);
                    current = "";
                }
            } else {
                current += char;
            }
        } else {
            current += char;
        }
    }

    if (current) {
        parts.push(current);
    }

    if (parts.length < 2) {
        throw new Error("Invalid command format");
    }

    const tag = parts[0];
    let name = parts[1].toUpperCase();
    let args = parts.slice(2);
    let useUid = false;

    // Handle UID prefix
    if (name === "UID" && args.length > 0) {
        useUid = true;
        name = args[0].toUpperCase();
        args = args.slice(1);
    }

    // Clean up quoted strings in args
    args = args.map((arg) => {
        if (arg.startsWith('"') && arg.endsWith('"')) {
            return arg.slice(1, -1).replace(/\\"/g, '"');
        }
        return arg;
    });

    return { tag, name, args, useUid, raw };
}

/**
 * Parse a sequence set (e.g., "1:10", "1,3,5:7", "*")
 */
export function parseSequenceSet(set: string, uids: number[]): number[] {
    if (!uids.length) return [];

    const result: number[] = [];
    const parts = set.split(",");

    for (const part of parts) {
        if (part === "*") {
            // Last message
            result.push(uids[uids.length - 1]);
        } else if (part.includes(":")) {
            const [startStr, endStr] = part.split(":");
            let start = startStr === "*" ? uids[uids.length - 1] : parseInt(startStr);
            let end = endStr === "*" ? uids[uids.length - 1] : parseInt(endStr);

            // Swap if needed
            if (start > end) [start, end] = [end, start];

            for (const uid of uids) {
                if (uid >= start && uid <= end) {
                    result.push(uid);
                }
            }
        } else {
            const num = parseInt(part);
            if (!isNaN(num) && uids.includes(num)) {
                result.push(num);
            }
        }
    }

    return [...new Set(result)].sort((a, b) => a - b);
}

/**
 * Parse FETCH items
 * e.g., "(FLAGS ENVELOPE)" or "BODY[HEADER]"
 */
export interface FetchItem {
    type: string;
    section?: string;
    partial?: { start: number; length: number };
    peek?: boolean;
}

export function parseFetchItems(itemsStr: string): FetchItem[] {
    const items: FetchItem[] = [];

    // Remove outer parentheses if present
    let str = itemsStr.trim();
    if (str.startsWith("(") && str.endsWith(")")) {
        str = str.slice(1, -1);
    }

    // Split by space, respecting brackets
    const parts: string[] = [];
    let current = "";
    let brackets = 0;

    for (const char of str) {
        if (char === "[") brackets++;
        if (char === "]") brackets--;

        if (char === " " && brackets === 0) {
            if (current) parts.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    if (current) parts.push(current);

    for (const part of parts) {
        const upper = part.toUpperCase();

        if (upper === "ALL") {
            items.push({ type: "FLAGS" });
            items.push({ type: "INTERNALDATE" });
            items.push({ type: "RFC822.SIZE" });
            items.push({ type: "ENVELOPE" });
        } else if (upper === "FAST") {
            items.push({ type: "FLAGS" });
            items.push({ type: "INTERNALDATE" });
            items.push({ type: "RFC822.SIZE" });
        } else if (upper === "FULL") {
            items.push({ type: "FLAGS" });
            items.push({ type: "INTERNALDATE" });
            items.push({ type: "RFC822.SIZE" });
            items.push({ type: "ENVELOPE" });
            items.push({ type: "BODY" });
        } else if (upper === "BODYSTRUCTURE") {
            items.push({ type: "BODYSTRUCTURE" });
        } else if (upper.startsWith("BODY.PEEK")) {
            const item = parseBodyItem(part);
            item.peek = true;
            items.push(item);
        } else if (upper.startsWith("BODY")) {
            items.push(parseBodyItem(part));
        } else if (upper === "RFC822") {
            items.push({ type: "RFC822" });
        } else if (upper === "RFC822.HEADER") {
            items.push({ type: "RFC822.HEADER" });
        } else if (upper === "RFC822.TEXT") {
            items.push({ type: "RFC822.TEXT" });
        } else {
            items.push({ type: upper });
        }
    }

    return items;
}

function parseBodyItem(str: string): FetchItem {
    const item: FetchItem = { type: "BODY" };

    // Check for section
    const bracketMatch = str.match(/\[([^\]]*)\]/);
    if (bracketMatch) {
        item.section = bracketMatch[1];
    }

    // Check for partial
    const partialMatch = str.match(/<(\d+)\.(\d+)>/);
    if (partialMatch) {
        item.partial = {
            start: parseInt(partialMatch[1]),
            length: parseInt(partialMatch[2]),
        };
    }

    return item;
}

/**
 * Parse SEARCH criteria
 */
export interface SearchCriterion {
    type: string;
    value?: string | number;
    not?: boolean;
}

export function parseSearchCriteria(args: string[]): SearchCriterion[] {
    const criteria: SearchCriterion[] = [];
    let i = 0;
    let notNext = false;

    while (i < args.length) {
        const arg = args[i].toUpperCase();

        if (arg === "NOT") {
            notNext = true;
            i++;
            continue;
        }

        const criterion: SearchCriterion = { type: arg, not: notNext };
        notNext = false;

        // Handle criteria with values
        switch (arg) {
            case "FROM":
            case "TO":
            case "CC":
            case "BCC":
            case "SUBJECT":
            case "BODY":
            case "TEXT":
            case "KEYWORD":
            case "UNKEYWORD":
            case "HEADER":
                criterion.value = args[++i];
                break;
            case "BEFORE":
            case "ON":
            case "SINCE":
            case "SENTBEFORE":
            case "SENTON":
            case "SENTSINCE":
                criterion.value = args[++i];
                break;
            case "LARGER":
            case "SMALLER":
                criterion.value = parseInt(args[++i]);
                break;
            case "UID":
                criterion.value = args[++i];
                break;
        }

        criteria.push(criterion);
        i++;
    }

    return criteria;
}
