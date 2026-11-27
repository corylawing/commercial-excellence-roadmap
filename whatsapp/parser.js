/*
 * READS A WHATSAPP CHAT AS WHATSAPP ITSELF WRITES IT, on every phone and in every language we meet.
 *
 * Three shapes reach this app:
 *   iPhone "Export chat"   [27/11/2026, 10:32:15] Sophie Martin: Bonjour
 *   Android "Export chat"  27/11/2026, 10:32 - Sophie Martin: Bonjour
 *   Copied from WhatsApp Web or Desktop  [10:32, 27/11/2026] Sophie Martin: Bonjour
 * with day-first or month-first dates, 2- or 4-digit years, 12- or 24-hour clocks, and invisible
 * direction marks (U+200E) and narrow spaces (U+202F) that WhatsApp scatters through the file.
 *
 * Nothing here touches the network: the chat is read in the person's own browser.
 */

const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩﻿]/g;
const ODD_SPACES = /[    ]/g;

const DATE = String.raw`(\d{1,4})[./-](\d{1,2})(?:[./-](\d{1,4}))?\.?`;
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s?([AaPp]\.?\s?[Mm]\.?|上午|下午|午前|午後))?`;

// [27/11/2026, 10:32:15] Name: text            (iPhone export)
const RE_BRACKET_DATE_FIRST = new RegExp(String.raw`^\[${DATE},?\s+${TIME}\]\s?(.*)$`);
// [10:32, 27/11/2026] Name: text               (copied from WhatsApp Web / Desktop)
const RE_BRACKET_TIME_FIRST = new RegExp(String.raw`^\[${TIME},?\s+${DATE}\]\s?(.*)$`);
// 27/11/2026, 10:32 - Name: text               (Android export)
const RE_DASH = new RegExp(String.raw`^${DATE},?\s+${TIME}\s?[-–]\s(.*)$`);

/* Messages WhatsApp writes itself: never selectable, shown faint. Matched on the English words and
 * on the invisible mark iPhone exports put in front of them in every language. */
const SYSTEM_PATTERNS = [
    /end-to-end encrypted/i, /chiffrés de bout en bout/i, /Ende-zu-Ende-verschlüsselt/i,
    /cifrados de extremo a extremo/i, /crittografia end-to-end/i, /criptografia de ponta a ponta/i,
    /^Missed (voice|video) call/i, /^Appel (vocal|vidéo) manqué/i,
    /security code (with|changed)/i, /disappearing messages/i, /created group/i, /^You (added|removed|left|joined|changed)/i,
    /changed (the subject|this group's|the group)/i, /changed their phone number/i, /is a contact\.?$/i,
    /^This business (account|is)/i, /blocked this (contact|business)/i, /unblocked this/i
];
const DELETED_PATTERNS = [
    /^This message was deleted\.?$/i, /^You deleted this message\.?$/i, /^Ce message a été supprimé\.?$/i,
    /^Vous avez supprimé ce message\.?$/i, /^Diese Nachricht wurde gelöscht\.?$/i, /^Se eliminó este mensaje\.?$/i,
    /^Questo messaggio è stato eliminato\.?$/i, /^Mensagem apagada\.?$/i
];
const EDITED_SUFFIX = /\s*<(This message was edited|Ce message a été modifié|Diese Nachricht wurde bearbeitet|Se editó este mensaje|Questo messaggio è stato modificato|Mensagem editada)>\s*$/i;

/* "image omitted", "<Media omitted>", "<Médias omis>", "(file attached)" … */
const OMITTED_PATTERNS = [
    /^<[^<>:]{3,40}>$/,                                                       // <Media omitted> in any language
    /^(image|video|audio|sticker|GIF|document|Contact card|photo|voice message)\s+omitted$/i,
    /^(image|vidéo|audio|autocollant|GIF|document|fiche contact)\s+(absente?|omise?)$/i,
    /^(Bild|Video|Audio|Sticker|GIF|Dokument|Kontaktkarte)\s+weggelassen$/i,
    /^(imagen|video|audio|sticker|GIF|documento|tarjeta de contacto)\s+omitid[oa]$/i
];
// iPhone with media:  <attached: 00000031-PHOTO-2026-11-27-10-33-01.jpg>  (any language: <pièce jointe : …>)
const RE_IOS_ATTACHED = /<[^<>:]{2,30}:\s*([^<>]+\.[A-Za-z0-9]{2,5})>\s*$/;
// Android with media: IMG-20261127-WA0003.jpg (file attached)   (any language)
const RE_ANDROID_ATTACHED = /^([^\s/\\]+\.[A-Za-z0-9]{2,5})\s+\([^()]{3,40}\)\s*$/;

const MEDIA_KIND_BY_EXT = {
    jpg: 'photo', jpeg: 'photo', png: 'photo', webp: 'sticker', gif: 'photo', heic: 'photo',
    mp4: 'video', mov: 'video', '3gp': 'video',
    opus: 'voice', ogg: 'voice', m4a: 'voice', mp3: 'audio', aac: 'audio', wav: 'audio',
    pdf: 'document', doc: 'document', docx: 'document', xls: 'document', xlsx: 'document',
    ppt: 'document', pptx: 'document', txt: 'document', csv: 'document', zip: 'document', vcf: 'contact'
};

export function mediaKindOf(fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    if (/^PTT-|AUDIO/i.test(fileName || '')) return 'voice';
    return MEDIA_KIND_BY_EXT[ext] || 'document';
}

function clean(line) {
    return line.replace(ODD_SPACES, ' ').replace(DIRECTION_MARKS, '');
}

function matchHeader(line) {
    let m = RE_BRACKET_DATE_FIRST.exec(line);
    if (m) return { shape: 'iphone', d: [m[1], m[2], m[3]], t: [m[4], m[5], m[6], m[7]], rest: m[8] };
    m = RE_BRACKET_TIME_FIRST.exec(line);
    if (m) return { shape: 'copied', t: [m[1], m[2], m[3], m[4]], d: [m[5], m[6], m[7]], rest: m[8] };
    m = RE_DASH.exec(line);
    if (m) return { shape: 'android', d: [m[1], m[2], m[3]], t: [m[4], m[5], m[6], m[7]], rest: m[8] };
    return null;
}

function to24h(h, ampm) {
    let hour = Number(h);
    if (!ampm) return hour;
    const a = ampm.replace(/[\s.]/g, '').toLowerCase();
    const pm = a === 'pm' || ampm === '下午' || ampm === '午後';
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
    return hour;
}

function fullYear(y) {
    const n = Number(y);
    return y.length <= 2 ? 2000 + n : n;
}

/* A copied message can carry no year ("[27/11, 10:32]"): this year, unless that is still to come. */
function yearFor(month, day, today = new Date()) {
    const y = today.getFullYear();
    return new Date(y, month - 1, day) > new Date(y, today.getMonth(), today.getDate() + 1) ? y - 1 : y;
}

/* Turns the date numbers into year/month/day under one reading of the order. */
function ymd(parts, order) {
    const [a, b, c] = parts;
    if (a.length === 4) return [Number(a), Number(b), Number(c)];      // 2026-11-27
    const [m, d] = order === 'MDY' ? [Number(a), Number(b)] : [Number(b), Number(a)];
    return [c === undefined ? yearFor(m, d) : fullYear(c), m, d];
}

/*
 * DAY FIRST OR MONTH FIRST is decided by the file, never guessed per line: a number above 12 in
 * either place settles it; otherwise the reading that keeps the chat in date order wins; only a
 * tie falls back to the phone's region (the US writes the month first).
 */
export function decideDateOrder(dateParts, localeHint) {
    if (dateParts.length && dateParts.every(([a]) => a.length === 4)) return 'YMD';
    let dayFirstProof = 0, monthFirstProof = 0;
    for (const [a, b] of dateParts) {
        if (a.length === 4) continue;
        if (Number(a) > 12) dayFirstProof++;
        if (Number(b) > 12) monthFirstProof++;
    }
    if (dayFirstProof && !monthFirstProof) return 'DMY';
    if (monthFirstProof && !dayFirstProof) return 'MDY';
    const backwards = (order) => {
        let prev = -Infinity, n = 0;
        for (const p of dateParts) {
            const [y, m, d] = ymd(p, order);
            const v = y * 400 + m * 32 + d;
            if (v < prev) n++;
            prev = v;
        }
        return n;
    };
    const dmy = backwards('DMY'), mdy = backwards('MDY');
    if (dmy !== mdy) return dmy < mdy ? 'DMY' : 'MDY';
    return /^en-(US|PH)|^es-US/i.test(localeHint || '') ? 'MDY' : 'DMY';
}

function pad(n) { return String(n).padStart(2, '0'); }

/* The key a message keeps in Salesforce: its minute and its first words. The sender is left out on
 * purpose: a person's own name reads differently in each phone's export. */
export function fingerprint(stamp, text) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase();
    return `${stamp}|${words}`;
}

function splitSender(rest) {
    // "Name: text" — a sender is short and never starts a sentence with a colon in it
    const i = rest.indexOf(': ');
    if (i > 0 && i <= 80) return { sender: rest.slice(0, i).trim(), text: rest.slice(i + 2) };
    if (rest.endsWith(':') && rest.length <= 81) return { sender: rest.slice(0, -1).trim(), text: '' };
    return { sender: null, text: rest };
}

function classify(text, ledByMark) {
    const t = text.trim();
    let m = RE_IOS_ATTACHED.exec(t);
    if (m) {
        const caption = t.slice(0, m.index).replace(/•.*$/, '').trim();
        return { kind: 'media', attachment: m[1].trim(), caption };
    }
    m = RE_ANDROID_ATTACHED.exec(t.split('\n')[0]);
    if (m) {
        const caption = t.split('\n').slice(1).join('\n').trim();
        return { kind: 'media', attachment: m[1], caption };
    }
    if (OMITTED_PATTERNS.some((p) => p.test(t))) return { kind: 'media', attachment: null, caption: '' };
    if (DELETED_PATTERNS.some((p) => p.test(t))) return { kind: 'deleted' };
    if (SYSTEM_PATTERNS.some((p) => p.test(t))) return { kind: 'system' };
    if (ledByMark && t.length < 120 && !/[.?!]\s\S/.test(t)) {
        // iPhone puts an invisible mark before every line WhatsApp writes itself
        return { kind: 'system' };
    }
    return { kind: 'text' };
}

/**
 * @param {string} raw     the chat as text
 * @param {object} [opts]  { localeHint: 'en-US' }
 * @returns {{ messages: Array, senders: Array<{name:string,count:number}>, shape: string|null,
 *             dateOrder: string|null, skipped: number }}
 */
export function parseChat(raw, opts = {}) {
    const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
    const pending = [];
    let shape = null;
    let skipped = 0;
    for (const original of lines) {
        const ledByMark = /^[\s‎‏]*‎/.test(original) || /:\s‎/.test(original);
        const line = clean(original);
        const h = matchHeader(line);
        if (h) {
            shape = shape || h.shape;
            const { sender, text } = splitSender(h.rest);
            pending.push({ h, sender, text, ledByMark });
        } else if (pending.length) {
            pending[pending.length - 1].text += '\n' + line;
        } else if (line.trim()) {
            skipped++;
        }
    }
    if (!pending.length) return { messages: [], senders: [], shape: null, dateOrder: null, skipped };

    const dateOrder = decideDateOrder(pending.map((p) => p.h.d), opts.localeHint);
    const counts = new Map();
    const messages = pending.map((p, index) => {
        const [y, mo, d] = ymd(p.h.d, dateOrder);
        const hour = to24h(p.h.t[0], p.h.t[3]);
        const minute = Number(p.h.t[1]);
        const second = Number(p.h.t[2] || 0);
        let text = p.text.replace(/\s+$/, '');
        const edited = EDITED_SUFFIX.test(text);
        if (edited) text = text.replace(EDITED_SUFFIX, '');
        const c = p.sender === null ? { kind: 'system' } : classify(text, p.ledByMark);
        const dayKey = `${y}-${pad(mo)}-${pad(d)}`;
        const stamp = `${dayKey} ${pad(hour)}:${pad(minute)}`;
        if (p.sender && c.kind !== 'system') counts.set(p.sender, (counts.get(p.sender) || 0) + 1);
        const shownText = c.kind === 'media' ? c.caption : text;
        return {
            index,
            dayKey,
            stamp,
            at: new Date(y, mo - 1, d, hour, minute, second),
            sender: p.sender,
            text: shownText,
            kind: c.kind,
            attachment: c.attachment || null,
            mediaKind: c.attachment ? mediaKindOf(c.attachment) : (c.kind === 'media' ? 'omitted' : null),
            edited,
            key: fingerprint(stamp, c.kind === 'media' ? (c.attachment || '[media]') : text)
        };
    });
    const senders = [...counts.entries()].map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    return { messages, senders, shape, dateOrder, skipped };
}

/*
 * "WhatsApp Chat with Dr Sophie Martin.txt", "WhatsApp Chat - Dr Sophie Martin.zip",
 * "Discussion WhatsApp avec …", "WhatsApp Chat mit …", "Chat de WhatsApp con …" → "Dr Sophie Martin".
 */
export function chatNameFromFile(fileName) {
    let n = String(fileName || '').replace(/\.(txt|zip)$/i, '').replace(/\s*\(\d+\)$/, '').trim();
    n = n.replace(/^(WhatsApp\s+Chat|Chat\s+(de|do|di)\s+WhatsApp|Discussion\s+WhatsApp|Conversa\s+do\s+WhatsApp|Chat\s+WhatsApp|WhatsApp-Chat|WhatsApp)\s*/i, '');
    n = n.replace(/^(with|avec|mit|con|com|met|z|med|ile)\s+/i, '').replace(/^[-–:]\s*/, '').trim();
    if (!n || /^_?chat$/i.test(n)) return null;
    return n;
}

export function looksLikePhone(name) {
    return /^\+?[\d\s().-]{7,}$/.test(String(name || '').trim()) && (String(name).match(/\d/g) || []).length >= 7;
}

export function phoneDigits(name) {
    return String(name || '').replace(/[^\d+]/g, '');
}

/* The words written into Salesforce for each message: "[2026-11-27 10:32] Sophie Martin: Bonjour". */
export function transcriptLine(msg, senderLabel) {
    let body = msg.text || '';
    if (msg.kind === 'media') {
        const what = { photo: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio',
            document: 'Document', sticker: 'Sticker', contact: 'Contact card', omitted: 'Media' }[msg.mediaKind] || 'Media';
        const name = msg.attachment ? ` ${msg.attachment}` : '';
        const where = msg.uploaded ? ' (attached)' : (msg.attachment ? '' : ' (not in the export)');
        body = `[${what}${name}${where}]` + (body ? ' ' + body : '');
    }
    return `[${msg.stamp}] ${senderLabel}: ${body}`;
}

const RE_TRANSCRIPT = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] ([^:\n]{1,80}): ?(.*)$/;

/* Reads back the messages an earlier save wrote into an interaction, as fingerprints. */
export function keysInDescription(description) {
    const keys = new Set();
    if (!description) return keys;
    let cur = null;
    const flush = () => {
        if (!cur) return;
        cur.text = cur.text.trim();
        const media = /^\[(Photo|Video|Voice message|Audio|Document|Sticker|Contact card|Media)( ([^\]\s(][^\]]*?))?( \((attached|not in the export)\))?\]( (.*))?$/s.exec(cur.text);
        if (media) keys.add(fingerprint(cur.stamp, media[3] || '[media]'));
        else keys.add(fingerprint(cur.stamp, cur.text));
    };
    for (const line of description.split('\n')) {
        const m = RE_TRANSCRIPT.exec(line);
        if (m) { flush(); cur = { stamp: m[1], text: m[3] }; }
        else if (/^(—|Saved from WhatsApp)/.test(line)) { flush(); cur = null; }
        else if (cur) cur.text += '\n' + line;
    }
    flush();
    return keys;
}
