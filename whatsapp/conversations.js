/*
 * A LONG CHAT IS SEVERAL CONVERSATIONS. A pause of 4 hours or more between two messages starts a
 * new one, so a chat about a ScanBox order on Tuesday and a patient problem on Friday shows as two
 * conversations, each saved as its own interaction. Pure function: no screen, no network.
 */
export const PAUSE_MINUTES = 240;

/**
 * @param {Array<{index:number, at:Date, dayKey:string}>} messages in chat order
 * @returns {Array<{id:number, indexes:number[], start:Date, end:Date, firstDay:string, lastDay:string}>}
 *          oldest first
 */
export function groupConversations(messages, pauseMinutes = PAUSE_MINUTES) {
    const out = [];
    let cur = null;
    for (const m of messages) {
        const gap = cur ? (m.at - cur.end) / 60000 : Infinity;
        if (!cur || gap >= pauseMinutes || gap < -1) {
            cur = { id: out.length, indexes: [], start: m.at, end: m.at, firstDay: m.dayKey, lastDay: m.dayKey };
            out.push(cur);
        }
        cur.indexes.push(m.index);
        cur.end = m.at;
        cur.lastDay = m.dayKey;
    }
    return out;
}
