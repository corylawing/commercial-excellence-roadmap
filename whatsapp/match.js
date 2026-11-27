/*
 * WHO IN SALESFORCE IS THIS WHATSAPP PERSON. A phone number is the surest key (Salesforce's phone
 * search reads "+33 6 84 78 38 16", "0684783816" and "+33684783816" as the same number); otherwise
 * the name the rep saved in their phone, cleaned of "Dr", emojis and practice names.
 * Pure functions: the Salesforce calls live in sf.js.
 */

const TITLES = /^(dr|dra|drs|dr\.|dra\.|doctor|docteur|doc|prof|pr|mr|mrs|ms|mme|mlle|m|herr|frau|dott|dott\.ssa|sig|sra|sr)\.?$/i;
const SOSL_RESERVED = /[?&|!{}[\]()^~*:\\"'+\-]/g;

export function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/* "Dr Sophie Martin 🦷 (Smile Ortho)" → ["Sophie", "Martin"] */
export function nameTokens(name) {
    let s = String(name || '')
        .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|️/gu, ' ')
        .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .split(/\s[-–|/@]\s|\s·\s|,/)[0];               // "Sophie Martin - Smile Ortho" → "Sophie Martin"
    return s.split(/\s+/)
        .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}'’.-]+$/gu, '').replace(/\.$/, ''))
        .filter((t) => t && !TITLES.test(t) && !/^\d+$/.test(t) && t.length > 1);
}

export function soslEscape(term) {
    return String(term).replace(SOSL_RESERVED, (c) => '\\' + c);
}

/* FIND clause for a name: every word must match; the caller falls back to the surname alone. */
export function nameSearchTerm(tokens) {
    return tokens.map((t) => soslEscape(t)).join(' AND ');
}

export function phoneSearchTerm(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length >= 7 ? soslEscape(digits) : null;
}

function norm(s) { return stripAccents(s).toLowerCase(); }

/*
 * Ranks candidates for one WhatsApp person. Higher is better.
 *  phone match 100 · every name word 40 + surname 15 · in the rep's own book 20 ·
 *  no longer active −40 · test practice −60
 */
export function scoreCandidate(c, { tokens = [], phoneMatched = false, meId = null } = {}) {
    let score = 0;
    const reasons = [];
    const byPhone = phoneMatched instanceof Set ? phoneMatched.has(c.Id) : !!phoneMatched;
    if (byPhone) { score += 100; reasons.push('Same phone number'); }
    if (tokens.length) {
        const words = new Set(norm(`${c.FirstName || ''} ${c.LastName || ''} ${c.Name || ''}`).split(/[\s'’-]+/));
        const hits = tokens.filter((t) => words.has(norm(t))).length;
        if (hits === tokens.length) { score += 40; reasons.push('Same name'); }
        else if (hits) { score += 15 * hits; reasons.push('Similar name'); }
        const last = norm(c.LastName || '');
        if (last && tokens.some((t) => norm(t) === last)) score += 15;
    }
    const acc = c.Account || {};
    if (meId && (acc.AE__c === meId || acc.ISP__c === meId || acc.CSS__c === meId)) {
        score += 20; reasons.push('Your practice');
    }
    if (c.Contact_No_Longer_Active__c) { score -= 40; reasons.push('No longer active'); }
    if (acc.IsTestAccount__c) { score -= 60; reasons.push('Test practice'); }
    return { score, reasons };
}

export function rankCandidates(list, ctx) {
    return list
        .map((c) => ({ ...c, _rank: scoreCandidate(c, ctx) }))
        .sort((a, b) => b._rank.score - a._rank.score || String(a.Name).localeCompare(String(b.Name)));
}

/* A suggestion is taken without asking only when it is clearly the one. */
export function confidentPick(ranked) {
    if (!ranked.length) return null;
    const [first, second] = ranked;
    if (first._rank.score >= 100 && (!second || second._rank.score < 100)) return first;
    if (first._rank.score >= 55 && (!second || first._rank.score - second._rank.score >= 20)) return first;
    return null;
}

/* The rep's role on the practice, as the interaction button writes it: AE, ISP or CS. */
export function employeeTypeFor(account, meId, fallback) {
    if (account && meId) {
        if (account.AE__c === meId) return 'AE';
        if (account.ISP__c === meId) return 'ISP';
        if (account.CSS__c === meId) return 'CS';
    }
    return fallback || 'AE';
}

/* Which sender is the rep: "You", their own Salesforce name, or the one who is not the chat. */
export function guessMe(senders, { myName = '', chatName = '', remembered = '' } = {}) {
    const names = senders.map((s) => s.name);
    const selfWords = /^(you|vous|vos|tú|tu|du|jij|ty|sen|you \(.*\))$/i;
    const direct = names.find((n) => selfWords.test(n));
    if (direct) return direct;
    if (remembered && names.includes(remembered)) return remembered;
    const mine = nameTokens(myName).map(norm);
    if (mine.length) {
        const hit = names.find((n) => {
            const t = nameTokens(n).map(norm);
            return t.length && t.every((w) => mine.includes(w));
        });
        if (hit) return hit;
    }
    if (chatName && names.length === 2) {
        const other = names.find((n) => norm(n) !== norm(chatName));
        if (other && names.some((n) => norm(n) === norm(chatName))) return other;
    }
    return null;
}
