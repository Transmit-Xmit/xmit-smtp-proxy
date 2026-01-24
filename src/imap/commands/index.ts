/**
 * IMAP Command Handler Registry
 * Routes commands to appropriate handlers
 */
import net from "net";
import type { ImapSession, ImapCommand, ImapResponse, ServerConfig } from "../../shared/types.js";
import { ImapApiClient } from "../api-client.js";
import { isValidApiKeyFormat } from "../../shared/config.js";
import { formatListResponse, formatStatusResponse, formatFetchResponse } from "../formatter.js";
import { parseSequenceSet, parseFetchItems, parseSearchCriteria } from "../parser.js";

type CommandHandler = (
    session: ImapSession,
    command: ImapCommand,
    api: ImapApiClient,
    socket: net.Socket,
    config: ServerConfig
) => Promise<ImapResponse[]>;

/**
 * Handle an IMAP command
 */
export async function handleCommand(
    session: ImapSession,
    command: ImapCommand,
    api: ImapApiClient,
    socket: net.Socket,
    config: ServerConfig
): Promise<ImapResponse[]> {
    const handler = handlers[command.name];

    if (!handler) {
        return [{
            tag: command.tag,
            status: "BAD",
            message: `Unknown command: ${command.name}`,
        }];
    }

    // State validation
    const stateError = validateState(session, command.name);
    if (stateError) {
        return [{
            tag: command.tag,
            status: "BAD",
            message: stateError,
        }];
    }

    return handler(session, command, api, socket, config);
}

function validateState(session: ImapSession, command: string): string | null {
    const cmd = command.toUpperCase();

    // Commands valid in any state
    if (["CAPABILITY", "NOOP", "LOGOUT"].includes(cmd)) {
        return null;
    }

    // Commands requiring not authenticated
    if (["LOGIN", "AUTHENTICATE"].includes(cmd)) {
        if (session.state !== "not_authenticated") {
            return "Already authenticated";
        }
        return null;
    }

    // Commands requiring authenticated
    if (session.state === "not_authenticated") {
        return "Not authenticated";
    }

    // Commands requiring selected state
    const selectedOnly = [
        "CHECK", "CLOSE", "EXPUNGE", "SEARCH", "FETCH",
        "STORE", "COPY", "MOVE", "UID", "IDLE"
    ];
    if (selectedOnly.includes(cmd) && session.state !== "selected") {
        return "No mailbox selected";
    }

    // APPEND just requires authenticated state (which is already checked above)
    // It doesn't require a selected mailbox

    return null;
}

// ============================================================================
// Command Handlers
// ============================================================================

const handlers: Record<string, CommandHandler> = {
    // Any state commands
    CAPABILITY: async (session, command) => {
        return [
            {
                type: "untagged",
                data: "CAPABILITY IMAP4rev1 IDLE NAMESPACE UIDPLUS MOVE SPECIAL-USE AUTH=PLAIN AUTH=LOGIN",
            },
            {
                tag: command.tag,
                status: "OK",
                message: "CAPABILITY completed",
            },
        ];
    },

    NOOP: async (session, command) => {
        // TODO: Send any pending untagged responses (EXISTS, EXPUNGE, etc.)
        return [{
            tag: command.tag,
            status: "OK",
            message: "NOOP completed",
        }];
    },

    LOGOUT: async (session, command) => {
        session.state = "logout";
        return [
            {
                type: "untagged",
                data: "BYE Transmit IMAP server signing off",
            },
            {
                tag: command.tag,
                status: "OK",
                message: "LOGOUT completed",
            },
        ];
    },

    // Authentication
    LOGIN: async (session, command, api) => {
        const [username, password] = command.args;

        if (!username || !password) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "LOGIN requires username and password",
            }];
        }

        // Password is the API key
        if (!isValidApiKeyFormat(password)) {
            return [{
                tag: command.tag,
                status: "NO",
                code: "AUTHENTICATIONFAILED",
                message: "Invalid API key format",
            }];
        }

        const authResult = await api.validateApiKey(password);
        if (!authResult) {
            return [{
                tag: command.tag,
                status: "NO",
                code: "AUTHENTICATIONFAILED",
                message: "Invalid API key",
            }];
        }

        // Username determines which sender to use
        // "api" or "*" = any sender (list all)
        // "email@domain.com" = specific sender
        let selectedSender = undefined;

        if (username !== "api" && username !== "*") {
            const sender = await api.getSenderByEmail(password, username);
            if (!sender) {
                return [{
                    tag: command.tag,
                    status: "NO",
                    code: "AUTHENTICATIONFAILED",
                    message: "Sender not found or not accessible",
                }];
            }
            selectedSender = { id: sender.id, email: sender.email };
        }

        session.state = "authenticated";
        session.apiKey = password;
        session.workspaceId = authResult.workspaceId;
        session.selectedSender = selectedSender;

        return [{
            tag: command.tag,
            status: "OK",
            message: "LOGIN completed",
        }];
    },

    // Mailbox operations
    LIST: async (session, command, api) => {
        const [reference, pattern] = command.args;
        const responses: ImapResponse[] = [];

        // Get senders (each sender = a namespace)
        const senders = session.selectedSender
            ? [session.selectedSender]
            : await api.listSenders(session.apiKey!);

        for (const sender of senders) {
            // Get folders for this sender
            const folders = await api.listFolders(session.apiKey!, sender.id);

            for (const folder of folders) {
                // Check if matches pattern
                const fullName = session.selectedSender
                    ? folder.name
                    : `${sender.email}/${folder.name}`;

                if (matchesPattern(fullName, pattern)) {
                    const flags: string[] = [];

                    // Add special-use flags
                    if (folder.specialUse) {
                        const specialUseMap: Record<string, string> = {
                            inbox: "\\Inbox",
                            sent: "\\Sent",
                            drafts: "\\Drafts",
                            trash: "\\Trash",
                            archive: "\\Archive",
                            junk: "\\Junk",
                        };
                        const flag = specialUseMap[folder.specialUse];
                        if (flag) flags.push(flag);
                    }

                    responses.push({
                        type: "untagged",
                        data: formatListResponse(fullName, "/", flags),
                    });
                }
            }
        }

        responses.push({
            tag: command.tag,
            status: "OK",
            message: "LIST completed",
        });

        return responses;
    },

    SELECT: async (session, command, api) => {
        return handleSelect(session, command, api, false);
    },

    EXAMINE: async (session, command, api) => {
        return handleSelect(session, command, api, true);
    },

    STATUS: async (session, command, api) => {
        const [mailboxName, itemsStr] = command.args;

        if (!mailboxName) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "STATUS requires mailbox name",
            }];
        }

        // Parse mailbox name (could be "email/folder" or just "folder")
        const { senderId, folderName } = await resolveMailbox(session, mailboxName, api);

        if (!senderId) {
            return [{
                tag: command.tag,
                status: "NO",
                message: "Mailbox not found",
            }];
        }

        const status = await api.getFolderStatus(session.apiKey!, senderId, folderName);
        if (!status) {
            return [{
                tag: command.tag,
                status: "NO",
                message: "Failed to get status",
            }];
        }

        // Parse requested items
        const items: Record<string, number> = {};
        const requested = itemsStr?.replace(/[()]/g, "").split(" ").map(s => s.toUpperCase()) || [];

        if (requested.includes("MESSAGES")) items.MESSAGES = status.exists;
        if (requested.includes("RECENT")) items.RECENT = status.recent;
        if (requested.includes("UIDNEXT")) items.UIDNEXT = status.uidNext;
        if (requested.includes("UIDVALIDITY")) items.UIDVALIDITY = status.uidValidity;
        if (requested.includes("UNSEEN")) items.UNSEEN = status.unseen;

        return [
            {
                type: "untagged",
                data: formatStatusResponse(mailboxName, items),
            },
            {
                tag: command.tag,
                status: "OK",
                message: "STATUS completed",
            },
        ];
    },

    CLOSE: async (session, command) => {
        // Expunge deleted messages silently
        session.state = "authenticated";
        session.selectedFolder = undefined;

        return [{
            tag: command.tag,
            status: "OK",
            message: "CLOSE completed",
        }];
    },

    // Message operations
    FETCH: async (session, command, api) => {
        const [sequenceSet, itemsStr] = command.args;

        if (!sequenceSet || !itemsStr) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "FETCH requires sequence set and items",
            }];
        }

        const folder = session.selectedFolder!;
        const items = parseFetchItems(itemsStr);

        // Resolve sequence numbers to UIDs
        const uids = command.useUid
            ? parseSequenceSet(sequenceSet, folder.messageUids)
            : parseSequenceSet(sequenceSet, folder.messageUids.map((_, i) => i + 1))
                  .map((seq) => folder.messageUids[seq - 1])
                  .filter(Boolean);

        if (uids.length === 0) {
            return [{
                tag: command.tag,
                status: "OK",
                message: "FETCH completed",
            }];
        }

        // Determine what fields to request
        const needsBody = items.some(i =>
            i.type === "BODY" || i.type === "RFC822" || i.type === "RFC822.TEXT"
        );

        const fields = items.map(i => i.type).filter(t =>
            ["FLAGS", "UID", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODYSTRUCTURE"].includes(t)
        );
        if (!fields.includes("UID")) fields.push("UID");

        // Fetch messages
        const messages = await api.listMessages(
            session.apiKey!,
            session.selectedSender!.id,
            folder.name,
            { uids, fields }
        );

        const responses: ImapResponse[] = [];

        for (const msg of messages) {
            // Get body if needed
            if (needsBody) {
                const body = await api.getMessageBody(
                    session.apiKey!,
                    session.selectedSender!.id,
                    msg.uid,
                    folder.name,
                    items.some(i => i.peek)
                );
                if (body) {
                    (msg as any).body = body;
                }
            }

            // Find sequence number
            const seqNum = folder.messageUids.indexOf(msg.uid) + 1;

            responses.push({
                type: "untagged",
                data: formatFetchResponse(seqNum, msg, items),
            });
        }

        responses.push({
            tag: command.tag,
            status: "OK",
            message: "FETCH completed",
        });

        return responses;
    },

    STORE: async (session, command, api) => {
        const [sequenceSet, action, flagsStr] = command.args;

        if (!sequenceSet || !action || !flagsStr) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "STORE requires sequence set, action, and flags",
            }];
        }

        const folder = session.selectedFolder!;

        // Parse action (+FLAGS, -FLAGS, FLAGS)
        const upperAction = action.toUpperCase().replace(".SILENT", "");
        const silent = action.toUpperCase().includes(".SILENT");

        // Parse flags
        const flags = flagsStr.replace(/[()]/g, "").split(" ").filter(Boolean);

        // Resolve UIDs
        const uids = command.useUid
            ? parseSequenceSet(sequenceSet, folder.messageUids)
            : parseSequenceSet(sequenceSet, folder.messageUids.map((_, i) => i + 1))
                  .map((seq) => folder.messageUids[seq - 1])
                  .filter(Boolean);

        const responses: ImapResponse[] = [];

        for (const uid of uids) {
            const changes: { add?: string[]; remove?: string[]; set?: string[] } = {};

            if (upperAction === "+FLAGS") {
                changes.add = flags;
            } else if (upperAction === "-FLAGS") {
                changes.remove = flags;
            } else {
                changes.set = flags;
            }

            const newFlags = await api.updateFlags(
                session.apiKey!,
                session.selectedSender!.id,
                uid,
                folder.name,
                changes
            );

            if (!silent && newFlags) {
                const seqNum = folder.messageUids.indexOf(uid) + 1;
                responses.push({
                    type: "untagged",
                    data: `${seqNum} FETCH (FLAGS (${newFlags.join(" ")}))`,
                });
            }
        }

        responses.push({
            tag: command.tag,
            status: "OK",
            message: "STORE completed",
        });

        return responses;
    },

    SEARCH: async (session, command, api) => {
        const folder = session.selectedFolder!;

        // Parse search criteria
        const criteria = parseSearchCriteria(command.args);

        const uids = await api.searchMessages(
            session.apiKey!,
            session.selectedSender!.id,
            folder.name,
            criteria.map(c => ({ type: c.type, value: c.value as any }))
        );

        // Convert UIDs to sequence numbers if not UID SEARCH
        const results = command.useUid
            ? uids
            : uids.map(uid => folder.messageUids.indexOf(uid) + 1).filter(n => n > 0);

        return [
            {
                type: "untagged",
                data: `SEARCH ${results.join(" ")}`,
            },
            {
                tag: command.tag,
                status: "OK",
                message: "SEARCH completed",
            },
        ];
    },

    COPY: async (session, command, api) => {
        const [sequenceSet, targetMailbox] = command.args;

        if (!sequenceSet || !targetMailbox) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "COPY requires sequence set and target mailbox",
            }];
        }

        const folder = session.selectedFolder!;
        const { folderName: targetFolder } = await resolveMailbox(session, targetMailbox, api);

        // Resolve UIDs
        const uids = command.useUid
            ? parseSequenceSet(sequenceSet, folder.messageUids)
            : parseSequenceSet(sequenceSet, folder.messageUids.map((_, i) => i + 1))
                  .map((seq) => folder.messageUids[seq - 1])
                  .filter(Boolean);

        const newUids: number[] = [];

        for (const uid of uids) {
            const newUid = await api.copyMessage(
                session.apiKey!,
                session.selectedSender!.id,
                uid,
                folder.name,
                targetFolder
            );
            if (newUid) newUids.push(newUid);
        }

        return [{
            tag: command.tag,
            status: "OK",
            code: newUids.length > 0 ? `COPYUID ${Date.now()} ${uids.join(",")} ${newUids.join(",")}` : undefined,
            message: "COPY completed",
        }];
    },

    MOVE: async (session, command, api) => {
        const [sequenceSet, targetMailbox] = command.args;

        if (!sequenceSet || !targetMailbox) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "MOVE requires sequence set and target mailbox",
            }];
        }

        const folder = session.selectedFolder!;
        const { folderName: targetFolder } = await resolveMailbox(session, targetMailbox, api);

        // Resolve UIDs
        const uids = command.useUid
            ? parseSequenceSet(sequenceSet, folder.messageUids)
            : parseSequenceSet(sequenceSet, folder.messageUids.map((_, i) => i + 1))
                  .map((seq) => folder.messageUids[seq - 1])
                  .filter(Boolean);

        const responses: ImapResponse[] = [];
        const newUids: number[] = [];

        for (const uid of uids) {
            const newUid = await api.moveMessage(
                session.apiKey!,
                session.selectedSender!.id,
                uid,
                folder.name,
                targetFolder
            );

            if (newUid) {
                newUids.push(newUid);

                // Remove from local cache
                const idx = folder.messageUids.indexOf(uid);
                if (idx >= 0) {
                    folder.messageUids.splice(idx, 1);
                    responses.push({
                        type: "untagged",
                        data: `${idx + 1} EXPUNGE`,
                    });
                }
            }
        }

        responses.push({
            tag: command.tag,
            status: "OK",
            code: newUids.length > 0 ? `COPYUID ${Date.now()} ${uids.join(",")} ${newUids.join(",")}` : undefined,
            message: "MOVE completed",
        });

        return responses;
    },

    EXPUNGE: async (session, command) => {
        // TODO: Actually expunge deleted messages via API
        return [{
            tag: command.tag,
            status: "OK",
            message: "EXPUNGE completed",
        }];
    },

    APPEND: async (session, command, api) => {
        // APPEND mailbox [flags] [date-time] literal
        // The literal data should be in command.literalData (set by server)
        const args = command.args;

        if (args.length < 1) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "APPEND requires mailbox name",
            }];
        }

        const mailboxName = args[0];
        let flags: string[] | undefined;
        let internalDate: Date | undefined;

        // Parse optional flags and date
        for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg.startsWith("(") && arg.endsWith(")")) {
                // Flags like (\Seen \Draft)
                flags = arg.slice(1, -1).split(/\s+/).filter(Boolean);
            } else if (arg.match(/^\d{1,2}-\w{3}-\d{4}/)) {
                // Date like "24-Jan-2026 20:30:00 +0000"
                internalDate = parseImapDate(arg);
            }
        }

        // Get literal data
        const literalData = (command as any).literalData as string | undefined;
        if (!literalData) {
            return [{
                tag: command.tag,
                status: "BAD",
                message: "APPEND requires message data",
            }];
        }

        // Resolve mailbox
        const { senderId, folderName } = await resolveMailbox(session, mailboxName, api);

        if (!senderId) {
            return [{
                tag: command.tag,
                status: "NO",
                code: "TRYCREATE",
                message: "Mailbox does not exist",
            }];
        }

        // Append message via API
        const result = await api.appendMessage(
            session.apiKey!,
            senderId,
            folderName,
            literalData,
            flags,
            internalDate
        );

        if (!result) {
            return [{
                tag: command.tag,
                status: "NO",
                message: "Failed to append message",
            }];
        }

        return [{
            tag: command.tag,
            status: "OK",
            code: `APPENDUID ${Date.now()} ${result.uid}`,
            message: "APPEND completed",
        }];
    },

    IDLE: async (session, command, api, socket, config) => {
        session.idling = true;
        session.idleTag = command.tag;

        // Send continuation
        socket.write("+ idling\r\n");

        // Set timeout for IDLE (RFC says max 29 min, we use 28)
        session.idleTimeout = setTimeout(() => {
            if (session.idling) {
                session.idling = false;
                socket.write(`${session.idleTag} OK IDLE terminated (timeout)\r\n`);
            }
        }, Math.min(config.imapIdleTimeout, 28 * 60 * 1000));

        // Return empty - response is sent when DONE is received
        return [];
    },

    // Namespace
    NAMESPACE: async (session, command) => {
        // Personal namespace is root, no shared/other namespaces
        return [
            {
                type: "untagged",
                data: 'NAMESPACE (("" "/")) NIL NIL',
            },
            {
                tag: command.tag,
                status: "OK",
                message: "NAMESPACE completed",
            },
        ];
    },
};

// ============================================================================
// Helper Functions
// ============================================================================

async function handleSelect(
    session: ImapSession,
    command: ImapCommand,
    api: ImapApiClient,
    readOnly: boolean
): Promise<ImapResponse[]> {
    const [mailboxName] = command.args;

    if (!mailboxName) {
        return [{
            tag: command.tag,
            status: "BAD",
            message: `${readOnly ? "EXAMINE" : "SELECT"} requires mailbox name`,
        }];
    }

    // Resolve mailbox name
    const { senderId, folderName } = await resolveMailbox(session, mailboxName, api);

    if (!senderId) {
        return [{
            tag: command.tag,
            status: "NO",
            message: "Mailbox not found",
        }];
    }

    // Trigger sync first
    await api.syncMailbox(session.apiKey!, senderId);

    // Get folder status
    const status = await api.getFolderStatus(session.apiKey!, senderId, folderName);
    if (!status) {
        return [{
            tag: command.tag,
            status: "NO",
            message: "Failed to open mailbox",
        }];
    }

    // Get message UIDs
    const messages = await api.listMessages(session.apiKey!, senderId, folderName, {
        fields: ["UID"],
        limit: 10000,
    });
    const messageUids = messages.map(m => m.uid).sort((a, b) => a - b);

    // Update session
    session.state = "selected";
    if (!session.selectedSender) {
        // Get sender info
        const senders = await api.listSenders(session.apiKey!);
        const sender = senders.find(s => s.id === senderId);
        if (sender) {
            session.selectedSender = { id: sender.id, email: sender.email };
        }
    }

    session.selectedFolder = {
        id: senderId,
        name: folderName,
        uidValidity: status.uidValidity,
        uidNext: status.uidNext,
        readOnly,
        messageUids,
        highestModSeq: status.highestModSeq,
    };

    const responses: ImapResponse[] = [
        { type: "untagged", data: `${status.exists} EXISTS` },
        { type: "untagged", data: `${status.recent} RECENT` },
        { type: "untagged", data: `OK [UNSEEN ${status.unseen}] First unseen` },
        { type: "untagged", data: `OK [UIDVALIDITY ${status.uidValidity}] UIDs valid` },
        { type: "untagged", data: `OK [UIDNEXT ${status.uidNext}] Predicted next UID` },
        { type: "untagged", data: `FLAGS (${status.flags.join(" ")})` },
        { type: "untagged", data: `OK [PERMANENTFLAGS (${status.permanentFlags.join(" ")})]` },
    ];

    responses.push({
        tag: command.tag,
        status: "OK",
        code: readOnly ? "READ-ONLY" : "READ-WRITE",
        message: `${readOnly ? "EXAMINE" : "SELECT"} completed`,
    });

    return responses;
}

/**
 * Map client-specific folder names to our canonical names
 * Different email clients use different names for special folders
 */
const FOLDER_ALIASES: Record<string, string> = {
    // Apple Mail
    "Sent Messages": "Sent",
    "Deleted Messages": "Trash",
    // Outlook
    "Deleted Items": "Trash",
    "Junk E-mail": "Junk",
    // Gmail
    "[Gmail]/Sent Mail": "Sent",
    "[Gmail]/Trash": "Trash",
    "[Gmail]/Drafts": "Drafts",
};

function normalizeFolderName(name: string): string {
    return FOLDER_ALIASES[name] || name;
}

async function resolveMailbox(
    session: ImapSession,
    mailboxName: string,
    api: ImapApiClient
): Promise<{ senderId: string | null; folderName: string }> {
    // Normalize folder name (handle client-specific names like "Sent Messages")
    const normalizedName = normalizeFolderName(mailboxName);

    // If user logged in with specific sender, mailbox is just folder name
    if (session.selectedSender) {
        return {
            senderId: session.selectedSender.id,
            folderName: normalizedName,
        };
    }

    // Otherwise, mailbox might be "email/folder"
    if (mailboxName.includes("/")) {
        const [email, ...rest] = mailboxName.split("/");
        const folderName = normalizeFolderName(rest.join("/"));

        const sender = await api.getSenderByEmail(session.apiKey!, email);
        if (sender) {
            return { senderId: sender.id, folderName };
        }
    }

    // Try to find in any sender
    const senders = await api.listSenders(session.apiKey!);
    for (const sender of senders) {
        const folders = await api.listFolders(session.apiKey!, sender.id);
        if (folders.some(f => f.name === normalizedName)) {
            return { senderId: sender.id, folderName: normalizedName };
        }
    }

    return { senderId: null, folderName: normalizedName };
}

function matchesPattern(name: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern === "%") return !name.includes("/");

    // Convert IMAP pattern to regex
    const regex = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/%/g, "[^/]*");

    return new RegExp(`^${regex}$`).test(name);
}

/**
 * Parse IMAP date format (e.g., "24-Jan-2026 20:30:00 +0000")
 */
function parseImapDate(dateStr: string): Date | undefined {
    // Remove quotes if present
    const clean = dateStr.replace(/^"|"$/g, "");

    // IMAP date format: DD-Mon-YYYY HH:MM:SS +ZZZZ
    const months: Record<string, number> = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };

    const match = clean.match(/^(\d{1,2})-(\w{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/);
    if (!match) {
        return undefined;
    }

    const [, day, mon, year, hour, min, sec, tz] = match;
    const month = months[mon];
    if (month === undefined) return undefined;

    const date = new Date(Date.UTC(
        parseInt(year),
        month,
        parseInt(day),
        parseInt(hour),
        parseInt(min),
        parseInt(sec)
    ));

    // Adjust for timezone if provided
    if (tz) {
        const tzHours = parseInt(tz.slice(0, 3));
        const tzMins = parseInt(tz.slice(0, 1) + tz.slice(3));
        date.setUTCMinutes(date.getUTCMinutes() - (tzHours * 60 + tzMins));
    }

    return date;
}
