/*
 * THE CONNECTION TO SALESFORCE, AS THE REP. Each person signs in with their own Salesforce login
 * (the "Chat to Salesforce" app in Setup: authorization code + PKCE, no secret, because a browser
 * cannot keep one). Salesforce shows its own "Allow access?" screen the first time. Everything is
 * then read and written with the rep's own access, exactly as if they typed it in Salesforce.
 *
 * Proved as four real people before shipping (AE, IC/ISP, CX agent, sales manager; check-only
 * probe 0AfW5000001yLsDKAU): every field read here, the save, the photo on the interaction.
 * A rep cannot read User.Profile, so nothing here asks for it.
 */
import { nameSearchTerm, phoneSearchTerm, soslEscape } from './match.js';

export const CONFIG = {
    loginUrl: 'https://dental.my.salesforce.com',
    clientId: 'DMChatLogkP9J9YpswjwauKwGQfDD4WUL6lTA0ZZ7bCTeYBKH9KNHkBsvBFo8WnIm',
    api: 'v62.0',
    /* The Chrome add-on signs in through Chrome's own sign-in window and comes back to its own
     * address (https://<add-on id>.chromiumapp.org/); the site leaves these empty. */
    redirectUri: null,
    display: null,
    openSignIn: null
};

const AUTH_KEY = 'c2s.auth';
const PKCE_KEY = 'c2s.pkce';
const DESCRIBE_KEY = 'c2s.describe.v2';

export const CONTACT_FIELDS = 'Id, Name, FirstName, LastName, Title, Role__c, Phone, MobilePhone, Email, ' +
    'AccountId, Account.Name, Account.BillingCity, Account.AE__c, Account.ISP__c, Account.CSS__c, ' +
    'Account.IsTestAccount__c, Account.Customer_Active__c, Contact_No_Longer_Active__c';
const ACCOUNT_FIELDS = 'Id, Name, BillingCity, AE__c, ISP__c, CSS__c, IsTestAccount__c, Customer_Active__c';

/*
 * CX = the person's role starts with CX or Support (CX Europe, CX Americas, Support Director - America…):
 * the app offers them a case first (Cory, 2026-11-27: "if role is CX it should offer case first").
 * Every such role sits on the CX profile, which Salesforce's case routing (Case_Trigger_Omni_Channel_Subflow)
 * uses to send a case they create back to them through Omni-Channel. The role, not the profile, because
 * a rep can read their own role and not their own profile (probed as a CX agent, an AE and an ISP).
 */
export const CX_ROLE = /^(CX|Support)\b/i;
const CX_CASE_RECORD_TYPE = 'Customer_Experience_Case';

/* Never offered for a WhatsApp chat: a business review is a meeting, and the QBR count reads this value. */
const PURPOSES_NOT_FOR_CHATS = new Set(['Quarterly Business Review']);

export class SignedOut extends Error {}

function store() {
    try { return window.localStorage; } catch { return null; }
}
function readJson(key) {
    try { return JSON.parse(store()?.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key, value) {
    try { value == null ? store()?.removeItem(key) : store()?.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export function redirectUri() {
    if (CONFIG.redirectUri) return CONFIG.redirectUri;
    const path = window.location.pathname.replace(/index\.html$/, '');
    return window.location.origin + (path.endsWith('/') ? path : path + '/');
}

function b64url(bytes) {
    let s = '';
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(n = 48) {
    return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

export function isSignedIn() {
    const a = readJson(AUTH_KEY);
    return !!(a && a.access_token && a.instance_url);
}

export function auth() { return readJson(AUTH_KEY); }

export function userIdFromAuth(a = auth()) {
    return a && a.id ? a.id.split('/').pop() : null;
}

/*
 * Step 1 of signing in: off to Salesforce's own login page. The site leaves for it and comes back
 * (step 2 runs on the way back in); the add-on opens it in Chrome's sign-in window and gets the
 * answer back here, so this returns step 2's result.
 */
export async function startSignIn() {
    const verifier = randomString(48);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = randomString(16);
    writeJson(PKCE_KEY, { verifier, state, at: Date.now() });
    const q = new URLSearchParams({
        response_type: 'code',
        client_id: CONFIG.clientId,
        redirect_uri: redirectUri(),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        display: CONFIG.display || (window.matchMedia('(max-width: 640px)').matches ? 'touch' : 'page')
    });
    const url = `${CONFIG.loginUrl}/services/oauth2/authorize?${q}`;
    if (!CONFIG.openSignIn) { window.location.assign(url); return null; }
    let back;
    try {
        back = await CONFIG.openSignIn(url);
    } catch {
        writeJson(PKCE_KEY, null);
        return 'The Salesforce window was closed before you signed in. Press Connect Salesforce to try again.';
    }
    return finishSignIn(back);
}

/*
 * Step 2, back from Salesforce with ?code=…&state=… (or ?error=…). Returns null when the address
 * carries neither, the reason as a sentence when it went wrong.
 */
export async function finishSignIn(returnedUrl = null) {
    const params = returnedUrl ? new URL(returnedUrl).searchParams : new URLSearchParams(window.location.search);
    const code = params.get('code');
    const error = params.get('error');
    if (!code && !error) return null;
    if (!returnedUrl) window.history.replaceState({}, '', redirectUri());
    if (error) {
        if (error === 'access_denied') return 'You chose not to allow access. Press Connect Salesforce to try again.';
        return params.get('error_description') || 'Salesforce did not sign you in. Try again.';
    }
    const pkce = readJson(PKCE_KEY);
    writeJson(PKCE_KEY, null);
    if (!pkce || pkce.state !== params.get('state')) return 'The sign-in expired. Press Connect Salesforce again.';
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CONFIG.clientId,
        redirect_uri: redirectUri(),
        code_verifier: pkce.verifier
    });
    let res;
    try {
        res = await fetch(`${CONFIG.loginUrl}/services/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });
    } catch {
        return 'Salesforce could not be reached to finish signing in. Check your connection and try again.';
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) return json.error_description || 'Salesforce did not sign you in. Try again.';
    writeJson(AUTH_KEY, { ...json, signed_in_at: Date.now() });
    return true;
}

let refreshing = null;
async function refresh() {
    const a = auth();
    if (!a || !a.refresh_token) throw new SignedOut();
    if (!refreshing) {
        refreshing = (async () => {
            const res = await fetch(`${CONFIG.loginUrl}/services/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: CONFIG.clientId })
            }).catch(() => null);
            const json = res ? await res.json().catch(() => ({})) : {};
            if (!res || !res.ok || !json.access_token) {
                if (res && res.status >= 400 && res.status < 500) { writeJson(AUTH_KEY, null); throw new SignedOut(); }
                throw new Error('Salesforce could not be reached. Check your connection.');
            }
            writeJson(AUTH_KEY, { ...a, ...json, refresh_token: json.refresh_token || a.refresh_token });
        })().finally(() => { refreshing = null; });
    }
    return refreshing;
}

export async function signOut() {
    const a = auth();
    writeJson(AUTH_KEY, null);
    if (a && (a.refresh_token || a.access_token)) {
        fetch(`${CONFIG.loginUrl}/services/oauth2/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: a.refresh_token || a.access_token })
        }).catch(() => {});
    }
}

function sentenceFrom(json, status) {
    const first = Array.isArray(json) ? json[0] : json;
    const msg = first && (first.message || first.error_description);
    if (msg) {
        if (/INSUFFICIENT_ACCESS|insufficient access/i.test(first.errorCode || msg)) {
            return 'Salesforce says you do not have access to this record. Pick another one, or ask your manager.';
        }
        return msg.replace(/^.*FIELD_CUSTOM_VALIDATION_EXCEPTION, /, '').replace(/: \[\]$/, '');
    }
    return `Salesforce answered with an error (${status}). Try again.`;
}

export async function api(path, { method = 'GET', body, retry = true, headers = {} } = {}) {
    const a = auth();
    if (!a) throw new SignedOut();
    let res;
    try {
        res = await fetch(`${a.instance_url}${path.startsWith('/services') ? '' : `/services/data/${CONFIG.api}`}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${a.access_token}`,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...headers
            },
            body: body ? JSON.stringify(body) : undefined
        });
    } catch {
        throw new Error('Salesforce could not be reached. Check your connection and try again.');
    }
    if (res.status === 401 && retry) {
        await refresh();
        return api(path, { method, body, retry: false, headers });
    }
    if (res.status === 401) { writeJson(AUTH_KEY, null); throw new SignedOut(); }
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(sentenceFrom(json, res.status));
    return json;
}

export async function query(soql) {
    const r = await api(`/query?q=${encodeURIComponent(soql)}`);
    return r.records || [];
}

async function search(sosl) {
    const r = await api(`/search/?q=${encodeURIComponent(sosl)}`);
    return (r && r.searchRecords) || [];
}

function idLiteral(id) {
    if (!/^[a-zA-Z0-9]{15,18}$/.test(String(id))) throw new Error('Not a Salesforce id.');
    return `'${id}'`;
}

/* The rep, and how they usually log (AE / ISP / CS) for a practice that does not name them. */
export async function loadMe() {
    const meId = userIdFromAuth();
    const [user] = await query(`SELECT Id, Name, FirstName, LastName, SmallPhotoUrl, LanguageLocaleKey FROM User WHERE Id = ${idLiteral(meId)}`);
    const [last] = await query(`SELECT Employee_Interaction_Type__c FROM Task WHERE OwnerId = ${idLiteral(meId)} ` +
        `AND Employee_Interaction_Type__c != null AND TaskSubtype = 'Call' ORDER BY CreatedDate DESC LIMIT 1`);
    let isCx = false;
    try {
        const [r] = await query(`SELECT UserRole.Name FROM User WHERE Id = ${idLiteral(meId)}`);
        isCx = !!(r && r.UserRole && CX_ROLE.test(r.UserRole.Name || ''));
    } catch { /* not readable: interaction first, which only changes the order of two buttons */ }
    return { ...user, usualType: last ? last.Employee_Interaction_Type__c : null, isCx };
}

/* Purpose and outcome as the business labels them ("Opportunity In Progress", never the stored value). */
export async function loadChoices() {
    const cached = readJson(DESCRIBE_KEY);
    if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.choices;
    const d = await api('/sobjects/Task/describe');
    const pick = (name) => {
        const f = d.fields.find((x) => x.name === name);
        return f ? f.picklistValues.filter((p) => p.active).map((p) => ({ value: p.value, label: p.label })) : [];
    };
    let caseInfo = { topics: [], types: [], recordTypeId: null };
    try {
        const c = await api('/sobjects/Case/describe');
        const casePick = (name) => {
            const f = c.fields.find((x) => x.name === name);
            return f ? f.picklistValues.filter((p) => p.active).map((p) => ({ value: p.value, label: p.label })) : [];
        };
        const rt = (c.recordTypeInfos || []).find((r) => r.developerName === CX_CASE_RECORD_TYPE && r.available);
        caseInfo = { topics: casePick('Topic__c'), types: casePick('Type__c'), recordTypeId: rt ? rt.recordTypeId : null };
    } catch { /* no case access: the Case button is not offered */ }
    const choices = {
        purposes: pick('Purpose_LogACall__c').filter((p) => !PURPOSES_NOT_FOR_CHATS.has(p.value)),
        outcomes: pick('Interaction_Outcome__c'),
        case: caseInfo
    };
    writeJson(DESCRIBE_KEY, { at: Date.now(), choices });
    return choices;
}

/* Candidates for one WhatsApp person: by phone first, then by every word of the name, then the surname. */
export async function findPeople({ phone, tokens }) {
    const out = new Map();
    let phoneMatched = new Set();
    const p = phoneSearchTerm(phone);
    if (p) {
        const rows = await search(`FIND {${p}} IN PHONE FIELDS RETURNING Contact(${CONTACT_FIELDS} LIMIT 10)`);
        rows.forEach((r) => { out.set(r.Id, r); phoneMatched.add(r.Id); });
        if (!rows.length && p.length > 9) {
            const tail = p.replace(/\\/g, '').slice(-9);
            const more = await search(`FIND {${tail}} IN PHONE FIELDS RETURNING Contact(${CONTACT_FIELDS} LIMIT 10)`);
            more.forEach((r) => { out.set(r.Id, r); phoneMatched.add(r.Id); });
        }
    }
    if (tokens && tokens.length) {
        let rows = await search(`FIND {${nameSearchTerm(tokens)}} IN NAME FIELDS RETURNING Contact(${CONTACT_FIELDS} LIMIT 25)`);
        if (!rows.length && tokens.length > 1) {
            const surname = [...tokens].sort((a, b) => b.length - a.length)[0];
            rows = await search(`FIND {${soslEscape(surname)}} IN NAME FIELDS RETURNING Contact(${CONTACT_FIELDS} LIMIT 25)`);
        }
        rows.forEach((r) => { if (!out.has(r.Id)) out.set(r.Id, r); });
    }
    return { candidates: [...out.values()], phoneMatched };
}

/* What the rep types in the search box: doctors and staff, and practices. */
export async function searchAll(text) {
    const words = String(text || '').trim();
    if (words.replace(/\W/g, '').length < 2) return { contacts: [], accounts: [] };
    const digits = words.replace(/\D/g, '');
    const term = digits.length >= 7 && digits.length >= words.replace(/\s/g, '').length - 2
        ? digits
        : words.split(/\s+/).filter(Boolean).map((w) => soslEscape(w) + (w.length >= 2 ? '*' : '')).join(' AND ');
    const scope = digits.length >= 7 && term === digits ? 'PHONE FIELDS' : 'NAME FIELDS';
    const r = await api(`/search/?q=${encodeURIComponent(`FIND {${term}} IN ${scope} RETURNING Contact(${CONTACT_FIELDS} LIMIT 15), Account(${ACCOUNT_FIELDS} LIMIT 8)`)}`);
    const rows = (r && r.searchRecords) || [];
    return {
        contacts: rows.filter((x) => x.attributes.type === 'Contact'),
        accounts: rows.filter((x) => x.attributes.type === 'Account')
    };
}

/* Every practice the person works at (a doctor can sit at several). */
export async function practicesOf(contactId) {
    const rows = await query(`SELECT AccountId, Account.Name, Account.BillingCity, Account.AE__c, Account.ISP__c, ` +
        `Account.CSS__c, Account.IsTestAccount__c, Account.Customer_Active__c, IsDirect FROM AccountContactRelation ` +
        `WHERE ContactId = ${idLiteral(contactId)} ORDER BY IsDirect DESC LIMIT 20`);
    return rows.map((r) => ({ Id: r.AccountId, ...(r.Account || {}), IsDirect: r.IsDirect }));
}

/*
 * Earlier WhatsApp interactions and WhatsApp cases on this person: their messages are not offered
 * again. Cases are read with the rep's own access (a rep sees the cases they created and those of
 * their practices), so a case they cannot see is simply not checked.
 */
export async function earlierSaves(contactId) {
    const tasks = await query(`SELECT Id, Description, CreatedDate, Owner.Name, OwnerId, Purpose_LogACall__c, Interaction_Outcome__c ` +
        `FROM Task WHERE WhoId = ${idLiteral(contactId)} AND Interaction_type__c = 'Text/SMS/Whatsapp' ORDER BY CreatedDate DESC LIMIT 50`);
    let cases = [];
    try {
        cases = await query(`SELECT Id, Description, CreatedDate, Owner.Name FROM Case WHERE ContactId = ${idLiteral(contactId)} ` +
            `AND Origin = 'Whatsapp' ORDER BY CreatedDate DESC LIMIT 50`);
    } catch { /* no case access */ }
    return [...tasks, ...cases.map((c) => ({ ...c, isCase: true }))];
}

/* The rep's last WhatsApp saves, interactions and cases together, newest first. */
export async function recentSaves() {
    const meId = userIdFromAuth();
    const tasks = await query(`SELECT Id, Subject, ActivityDate, Who.Name, What.Name, CreatedDate FROM Task WHERE OwnerId = ${idLiteral(meId)} ` +
        `AND Interaction_type__c = 'Text/SMS/Whatsapp' AND Subject LIKE 'WhatsApp%' ORDER BY CreatedDate DESC LIMIT 8`);
    let cases = [];
    try {
        cases = await query(`SELECT Id, Subject, CaseNumber, Contact.Name, Account.Name, CreatedDate FROM Case WHERE CreatedById = ${idLiteral(meId)} ` +
            `AND Origin = 'Whatsapp' AND Subject LIKE 'WhatsApp%' ORDER BY CreatedDate DESC LIMIT 8`);
    } catch { /* no case access */ }
    const asRow = (c) => ({ Id: c.Id, Subject: c.Subject, CaseNumber: c.CaseNumber, Who: c.Contact, What: c.Account, CreatedDate: c.CreatedDate, isCase: true });
    return [...tasks, ...cases.map(asRow)].sort((a, b) => String(b.CreatedDate).localeCompare(String(a.CreatedDate))).slice(0, 8);
}

export async function saveInteraction(fields) {
    const r = await api('/sobjects/Task', { method: 'POST', body: fields });
    return r.id;
}

/*
 * A case, routed exactly as a case typed in Salesforce is: Salesforce's routing automation sends a
 * case created by CX back to its creator through Omni-Channel, anyone else's to the practice's CX
 * agent or the region's CX queue. The API would also run the case assignment rule on top (a second
 * routing, the September trouble with app-made cases), so it is switched off here, as the case
 * page switches it off.
 */
export async function saveCase(fields) {
    const r = await api('/sobjects/Case', { method: 'POST', body: fields, headers: { 'Sforce-Auto-Assign': 'FALSE' } });
    let number = null;
    try {
        const c = await api(`/sobjects/Case/${r.id}?fields=CaseNumber`);
        number = c && c.CaseNumber;
    } catch { /* the number is only shown */ }
    return { id: r.id, number };
}

async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/* A photo, voice message or document, filed on the interaction (Files related list). */
export async function attachFile(taskId, name, blob) {
    if (blob.size > MAX_FILE_BYTES) throw new Error(`${name} is larger than 25 MB and was not attached.`);
    await api('/sobjects/ContentVersion', {
        method: 'POST',
        body: { Title: name, PathOnClient: name, VersionData: await blobToBase64(blob), FirstPublishLocationId: taskId }
    });
}

export function recordUrl(id, objectName = 'Task') {
    const a = auth();
    const host = a ? a.instance_url.replace('.my.salesforce.com', '.lightning.force.com') : CONFIG.loginUrl;
    return `${host}/lightning/r/${objectName}/${id}/view`;
}
