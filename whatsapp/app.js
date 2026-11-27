/*
 * CHAT TO SALESFORCE — save WhatsApp conversations to Salesforce as interactions.
 *
 * The journey, every screen one job:
 *   Connect   sign in with Salesforce (its own "Allow access?" screen), then allow WhatsApp chats
 *   Home      bring a chat in: paste copied messages, open an exported chat, or share from WhatsApp
 *   Pick      tap the messages to keep; earlier saves are marked and never offered twice
 *   Save      who (matched by phone, then name), practice, then an interaction (purpose, outcome)
 *             or a case (CX sees Case first); what is already known is filled in (autofill.js)
 *
 * The chat is read in this browser only. What leaves it is what the rep saves, to Salesforce.
 *
 * Two homes, one app: the site (export, share or paste a chat) and the Chrome add-on beside
 * WhatsApp Web (extension/panel.js), which reads the chat open on screen. The add-on sets
 * globalThis.C2S_HOST before this file loads; every place the two differ asks HOST.
 */
import {
    parseChat, chatNameFromFile, looksLikePhone, transcriptLine, keysInDescription, fingerprint
} from './parser.js';
import { listZip, isZip } from './zip.js';
import { groupConversations } from './conversations.js';
import { nameTokens, scoreCandidate, confidentPick, employeeTypeFor, guessMe } from './match.js';
import { suggestInteraction, caseSource, caseSubject } from './autofill.js';
import * as sf from './sf.js';

const root = document.getElementById('app');
const HOST = { kind: 'web', ...(globalThis.C2S_HOST || {}) };
const WELCOME = {
    question: 'Allow Chat to Salesforce to open the WhatsApp chats you send it?',
    points: [
        ['hand', 'You choose a chat in WhatsApp and send it here. Nothing else on your phone is read.'],
        ['eye', 'You pick the messages to keep. Only those are saved to Salesforce, on the doctor you confirm.'],
        ['shield', 'The chat is opened on this device only and is not stored anywhere else.']
    ],
    box: 'I allow Chat to Salesforce to open the WhatsApp chats I send it',
    button: 'Allow WhatsApp chats',
    done: 'WhatsApp chats allowed',
    locked: 'Next, allow the chats you send from WhatsApp.',
    ...(HOST.welcome || {})
};
const LOCALE = navigator.language || 'en-GB';
const CONSENT_KEY = 'c2s.consent';
const ME_NAMES_KEY = 'c2s.myWhatsAppNames';
const INSTALL_DISMISSED_KEY = 'c2s.installDismissed';
const CONV_PAGE = 30;
/* An iPhone shows a Photo Library / Take Photo menu before Files whenever pictures are accepted.
 * Its export is always one .zip (photos inside), so on iPhone the button opens Files straight away. */
const IPHONE_ACCEPT = '.zip,.txt,application/zip,text/plain';
const FILE_ACCEPT = '.txt,.zip,text/plain,application/zip,image/*,audio/*,video/*,application/pdf';
const DESCRIPTION_MAX = 32000;

const S = {
    view: 'boot',
    me: null,
    choices: null,
    flash: null,
    installEvent: null,
    pasteOpen: false,
    recent: null,
    chat: null,
    selection: new Set(),
    lastClicked: null,
    step: 'pick',
    shownConvs: CONV_PAGE,
    person: null,
    practices: [],
    practice: null,
    practiceSearch: false,
    purpose: null,
    outcome: null,
    kind: 'interaction',
    auto: {},
    touched: {},
    topic: null,
    caseType: null,
    caseSubject: '',
    caseSubjectTouched: false,
    openPicker: null,
    subject: '',
    subjectTouched: false,
    note: '',
    saving: null,
    error: null,
    lastSaved: null,
    menuOpen: false
};

/* ---------------------------------------------------------------- small helpers */

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5h6V7H9z"/><path d="M9 12h6M9 16h4"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    open: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-4.5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 16a1.6 1.6 0 0 1 2.6-1.8L8 16.5"/>',
    building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 8"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M6 12h12"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    arrow: '<path d="M4 12h14M13 6l6 6-6 6"/>'
};
function icon(name, cls = '') {
    return `<svg viewBox="0 0 24 24" width="24" height="24" class="${cls}" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
function initials(name) {
    const parts = nameTokens(name);
    const p = parts.length ? parts : String(name || '?').split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
function readLocal(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function writeLocal(key, v) { try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }
function hasConsent() { return !!readLocal(CONSENT_KEY); }

function dayDate(dayKey) { const [y, m, d] = dayKey.split('-').map(Number); return new Date(y, m - 1, d); }
const fmtDay = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
function dayLabel(dayKey) {
    const d = dayDate(dayKey);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return fmtDay.format(d);
}
function rangeLabel(firstKey, lastKey) {
    const a = dayDate(firstKey), b = dayDate(lastKey);
    if (firstKey === lastKey) return fmtShort.format(a);
    try { return fmtShort.formatRange(a, b); } catch { return `${fmtShort.format(a)} – ${fmtShort.format(b)}`; }
}
function possessive(name) { return /s$/i.test(name) ? `${name}’` : `${name}’s`; }
function plural(n, one, many) { return `${n.toLocaleString(LOCALE)} ${n === 1 ? one : many}`; }

let toastTimer;
function toast(msg) {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 4200);
}

function device() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iphone';
    if (/Android/.test(ua)) return 'android';
    return 'computer';
}
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function guard(promise) {
    try {
        return await promise;
    } catch (e) {
        if (e instanceof sf.SignedOut) {
            S.flash = { kind: 'amber', text: 'Your Salesforce sign-in has ended. Connect again to carry on.' };
            S.me = null;
            S.view = 'welcome';
            render();
            throw e;
        }
        throw e;
    }
}

/* ---------------------------------------------------------------- top bar */

function topbar({ back = false, title = '', sub = '' } = {}) {
    const me = S.me;
    const left = back
        ? `<button class="icon-btn back-btn" data-act="back" aria-label="Back">${icon('back')}</button>
           <div class="title title-pick"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
           <div class="title title-save"><b>Save to Salesforce</b><small class="save-summary">${esc(S.chat ? saveSummary() : '')}</small></div>`
        : `<div class="brand"><img src="icons/icon.svg" alt="" width="30" height="30"><span>Chat to Salesforce</span></div><span class="spacer"></span>`;
    const right = me
        ? `<div class="menu-wrap"><button class="avatar" data-act="menu" aria-haspopup="true" aria-expanded="${S.menuOpen}" aria-label="Your account">${esc(initials(me.Name))}</button>
           ${S.menuOpen ? `<div class="menu" role="menu">
              <div class="who"><b>${esc(me.Name)}</b><small>Signed in to Salesforce</small></div>
              <button role="menuitem" data-act="withdraw">${icon('hand')}Stop WhatsApp access</button>
              <button role="menuitem" data-act="signout">${icon('logout')}Sign out of Salesforce</button>
            </div>` : ''}</div>`
        : '';
    return `<header class="topbar">${left}${right}</header>`;
}

/* ---------------------------------------------------------------- welcome: connect Salesforce, then WhatsApp */

function renderWelcome() {
    const signedIn = !!S.me;
    const consent = hasConsent();
    const flash = S.flash ? `<div class="notice ${S.flash.kind || 'amber'}">${icon('alert')}<span>${esc(S.flash.text)}</span></div>` : '';
    root.innerHTML = `
      ${topbar()}
      <main class="page">
        <section class="hero">
          <img src="icons/icon.svg" alt="" width="72" height="72">
          <h1>Chat to Salesforce</h1>
          <p class="muted">Save WhatsApp conversations as interactions on the right doctor and practice, in a few taps.</p>
        </section>
        ${flash}
        <section class="card steps" aria-label="Get started">
          <div class="step ${signedIn ? 'done' : ''}">
            <span class="num">${signedIn ? icon('check') : '1'}</span>
            <div class="body">
              <h2>Connect Salesforce</h2>
              ${signedIn
                  ? `<p class="ok-line">${icon('check')}Signed in as ${esc(S.me.Name)}</p>`
                  : `<p class="muted">Sign in with your usual Salesforce login. Salesforce asks you once to allow this app.</p>
                     <button class="btn primary big" data-act="signin">${icon('lock')}Connect Salesforce</button>`}
            </div>
          </div>
          <div class="step ${consent && signedIn ? 'done' : ''} ${signedIn ? '' : 'locked'}">
            <span class="num">${consent && signedIn ? icon('check') : '2'}</span>
            <div class="body">
              <h2>Connect WhatsApp</h2>
              ${!signedIn ? `<p class="muted">${esc(WELCOME.locked)}</p>` : consent ? `<p class="ok-line">${icon('check')}${esc(WELCOME.done)}</p>` : `
                <div class="consent">
                  <p><b>${esc(WELCOME.question)}</b></p>
                  <ul>
                    ${WELCOME.points.map(([ic, text]) => `<li>${icon(ic)}<span>${esc(text)}</span></li>`).join('')}
                  </ul>
                  <label class="check"><input type="checkbox" id="consent-box"> ${esc(WELCOME.box)}</label>
                  <button class="btn primary big" data-act="consent" disabled>${esc(WELCOME.button)}</button>
                </div>`}
            </div>
          </div>
        </section>
        <p class="faint">You can stop either connection at any time from your initials at the top.</p>
      </main>`;
    const box = root.querySelector('#consent-box');
    if (box) box.addEventListener('change', () => { root.querySelector('[data-act="consent"]').disabled = !box.checked; });
}

/* ---------------------------------------------------------------- home */

/* The three WhatsApp steps for the phone in the rep's hand, shown on the home screen itself. */
function stepsFor(d) {
    if (d === 'iphone') return ['Tap the person’s name', 'Export Chat › Without Media', 'Save to Files'];
    if (d === 'android') return ['⋮ › More › Export chat', 'Without media', isStandalone() ? 'Pick Chat to SF' : 'Pick Chat to SF, or save it'];
    return ['Open the chat in WhatsApp', 'Drag across the messages, copy', 'Paste them here'];
}

function renderHome() {
    S.view = 'home';
    const d = device();
    const phone = d !== 'computer';
    const flash = S.flash ? `<div class="notice ${S.flash.kind || 'amber'}">${icon('alert')}<span>${esc(S.flash.text)}</span></div>` : '';
    const install = S.installEvent && !isStandalone() && !readLocal(INSTALL_DISMISSED_KEY)
        ? `<section class="card notice green" aria-label="Add to home screen">
             ${icon('download')}<span class="spacer">Add Chat to Salesforce to your home screen so it shows when you share a chat from WhatsApp.</span>
             <span class="chips"><button class="btn primary" data-act="install">Add</button><button class="icon-btn" data-act="install-no" aria-label="Not now">${icon('close')}</button></span>
           </section>` : '';
    const pasteBox = S.pasteOpen ? `
            <div class="paste-box">
              <label for="paste-text" class="eyebrow">Paste the messages copied from WhatsApp</label>
              <textarea id="paste-text" rows="6" placeholder="[27/11/2026, 10:32] Sophie Martin: Bonjour…"></textarea>
              <div class="btn-row">
                ${navigator.clipboard && navigator.clipboard.readText ? `<button class="btn" data-act="clipboard">${icon('paste')}Paste from clipboard</button>` : ''}
                <button class="btn primary" data-act="paste-go">Continue</button>
              </div>
            </div>` : '';
    const steps = stepsFor(d).map((s, i) => `<li><b>${i + 1}</b>${esc(s)}</li>`).join('');
    const primary = phone
        ? `<button class="btn primary big block" data-act="file">${icon('open')}Open the exported chat</button>
           <button class="btn link" data-act="paste-open">Or paste a few messages</button>`
        : `<button class="btn primary big block" data-act="paste-open">${icon('paste')}Paste messages</button>
           <button class="btn link" data-act="file">Or open an exported chat</button>`;
    root.innerHTML = `
      ${topbar()}
      <main class="page">
        ${flash}
        ${install}
        ${HOST.homeCard ? `<section class="card add-card" id="add-card">${HOST.homeCard({ pasteBox, icon, esc })}</section>` : `
        <section class="card add-card" id="add-card">
          <h1>Save a WhatsApp chat</h1>
          <ol class="steps3" aria-label="In WhatsApp">${steps}</ol>
          ${primary}
          <input type="file" id="file-input" class="sr-only" multiple accept="${d === 'iphone' ? IPHONE_ACCEPT : FILE_ACCEPT}" tabindex="-1">
          ${pasteBox}
          ${phone ? '' : '<p class="faint drop-hint">or drop an exported chat (.txt or .zip) anywhere on this page</p>'}
        </section>
        ${phone ? '' : `<a class="card notice addon-link" href="add-on.html">${icon('download')}<span><b>Using Chrome? Get the add-on.</b> It reads the chat open in WhatsApp Web: nothing to copy.</span></a>`}`}
        <section>
          <p class="eyebrow">Saved recently</p>
          <div class="recent card" id="recent">${recentHtml()}</div>
        </section>
      </main>`;
    S.flash = null;
    if (S.pasteOpen) root.querySelector('#paste-text')?.focus();
    if (S.recent === null) loadRecent();
}

function recentHtml() {
    if (S.recent === null) return '<p class="faint"><span class="spinner"></span></p>';
    if (S.recent === 'error') return '<p class="empty">Could not load your recent saves.</p>';
    if (!S.recent.length) return '<p class="empty">Nothing yet. WhatsApp chats you save show here.</p>';
    return S.recent.map((t) => {
        const day = t.ActivityDate || (t.CreatedDate ? String(t.CreatedDate).slice(0, 10) : '');
        return `
      <a href="${esc(sf.recordUrl(t.Id, t.isCase ? 'Case' : 'Task'))}" target="_blank" rel="noopener">
        <b>${t.isCase ? `<span class="tag">Case${t.CaseNumber ? ` ${esc(t.CaseNumber)}` : ''}</span> ` : ''}${esc(t.Subject)}</b>
        <small>${esc([t.Who && t.Who.Name, t.What && t.What.Name].filter(Boolean).join(' · ') || '—')}</small>
        <time datetime="${esc(day)}">${day ? esc(fmtShort.format(dayDate(day))) : ''}</time>
      </a>`;
    }).join('');
}

async function loadRecent() {
    try {
        S.recent = await guard(sf.recentSaves());
    } catch (e) {
        if (e instanceof sf.SignedOut) return;
        S.recent = 'error';
    }
    const el = root.querySelector('#recent');
    if (el) el.innerHTML = recentHtml();
}

/* ---------------------------------------------------------------- bringing a chat in */

async function openFiles(files) {
    files = [...files];
    if (!files.length) return;
    try {
        const zip = files.find(isZip);
        if (zip) {
            const entries = await listZip(zip);
            const chatEntry = entries.find((e) => /^_chat\.txt$/i.test(e.baseName)) || entries.find((e) => /\.txt$/i.test(e.baseName));
            if (!chatEntry) throw new Error('There is no chat in this zip. In WhatsApp, use Export Chat and send the file it makes.');
            const media = new Map(entries.filter((e) => e !== chatEntry).map((e) => [e.baseName, { read: e.read, size: e.size }]));
            const text = await (await chatEntry.read()).text();
            return openText(text, zip.name, media);
        }
        const txt = files.find((f) => /\.txt$/i.test(f.name) || f.type === 'text/plain');
        if (!txt) throw new Error('Choose the chat WhatsApp exported (a .txt or .zip file).');
        const media = new Map(files.filter((f) => f !== txt).map((f) => [f.name, { read: async () => f, size: f.size }]));
        return openText(await txt.text(), txt.name, media);
    } catch (e) {
        toast(e.message || 'This file could not be opened.');
    }
}

function openText(text, fileName, media = new Map(), { fromPaste = false, chatName: knownName, phone = null, meName: knownMe = null, localeHint = null, missingNote = null } = {}) {
    const parsed = parseChat(text, { localeHint: localeHint || LOCALE });
    let plain = false;
    if (!parsed.messages.length) {
        if (!String(text || '').trim()) { toast('There is nothing to save in what you pasted.'); return; }
        if (!fromPaste) { toast('No WhatsApp messages were found in this file.'); return; }
        // copied without times: kept as one message dated now
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const dayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const stamp = `${dayKey} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const body = String(text).trim();
        parsed.messages = [{ index: 0, dayKey, stamp, at: now, sender: 'WhatsApp', text: body, kind: 'text', attachment: null, mediaKind: null, key: fingerprint(stamp, body) }];
        parsed.senders = [{ name: 'WhatsApp', count: 1 }];
        plain = true;
    }
    const remembered = readLocal(ME_NAMES_KEY) || [];
    const chatName = knownName || chatNameFromFile(fileName);
    const meName = plain ? null : knownMe && parsed.senders.some((s) => s.name === knownMe) ? knownMe : guessMe(parsed.senders, {
        myName: S.me ? S.me.Name : '',
        chatName,
        remembered: parsed.senders.map((s) => s.name).find((n) => remembered.includes(n)) || ''
    });
    S.chat = { ...parsed, name: chatName, fileName, media, meName, plain, savedKeys: new Set(), savedInfo: new Map(), fromPaste, phone, missingNote };
    S.chat.convs = groupConversations(parsed.messages);
    S.selection = new Set();
    S.userTouched = false;
    S.expanded = new Set();
    S.shownConvs = CONV_PAGE;
    S.noteOpen = false;
    if (fromPaste) {
        // the rep already chose these messages in WhatsApp
        parsed.messages.forEach((m) => { if (selectable(m)) S.selection.add(m.index); });
        if (parsed.messages.length <= 12) S.chat.convs.forEach((cv) => S.expanded.add(cv.id));
    } else {
        autoTickNewest();
    }
    S.step = 'pick';
    S.person = null;
    S.practices = [];
    S.practice = null;
    S.practiceSearch = false;
    S.purpose = null;
    S.outcome = null;
    S.kind = defaultKind();
    S.auto = {};
    S.touched = {};
    S.topic = null;
    S.caseType = null;
    S.caseSubject = '';
    S.caseSubjectTouched = false;
    S.openPicker = null;
    S.subject = '';
    S.subjectTouched = false;
    S.note = '';
    S.error = null;
    S.saving = null;
    S.pasteOpen = false;
    S.view = 'chat';
    render();
    window.scrollTo(0, 0);
    matchPerson();
}

/*
 * The same chat read again (a new message arrived, or earlier messages were read in the add-on):
 * the rep's ticks, open conversations, person, purpose and outcome all stay.
 */
function refreshChat(text, { meName: knownMe = null, localeHint = null } = {}) {
    const c = S.chat;
    if (!c) return;
    const parsed = parseChat(text, { localeHint: localeHint || LOCALE });
    if (!parsed.messages.length) return;
    const keyOf = (i) => (c.messages[i] ? c.messages[i].key : null);
    const picked = new Set([...S.selection].map(keyOf));
    const opened = new Set([...S.expanded].map((id) => (c.convs[id] ? keyOf(c.convs[id].indexes[0]) : null)));
    Object.assign(c, { messages: parsed.messages, senders: parsed.senders, shape: parsed.shape, dateOrder: parsed.dateOrder, skipped: parsed.skipped });
    if (knownMe && parsed.senders.some((s) => s.name === knownMe)) c.meName = knownMe;
    c.convs = groupConversations(parsed.messages);
    S.selection = new Set(parsed.messages.filter((m) => picked.has(m.key) && canPick(m)).map((m) => m.index));
    S.expanded = new Set(c.convs.filter((cv) => opened.has(parsed.messages[cv.indexes[0]].key)).map((cv) => cv.id));
    S.lastClicked = null;
    if (!S.userTouched && !c.fromPaste) autoTickNewest();
    if (S.view !== 'chat') return;
    const sub = root.querySelector('.title-pick small');
    if (sub) sub.textContent = chatSub();
    renderThread();
    renderToolbar();
}

/* An exported chat opens with its newest conversation not yet in Salesforce ticked: usually the one
 * the rep came for. Only until the rep ticks or unticks anything themselves. */
function autoTickNewest() {
    if (S.userTouched || !S.chat) return;
    S.selection = new Set();
    const convs = S.chat.convs;
    for (let i = convs.length - 1; i >= 0; i--) {
        const open = convs[i].indexes.filter((n) => canPick(S.chat.messages[n]));
        if (open.length) { open.forEach((n) => S.selection.add(n)); return; }
    }
}

/* Android "Share" from WhatsApp lands in the service worker, which keeps the files until opened here. */
async function takeSharedFiles() {
    if (!('caches' in window)) return null;
    try {
        const cache = await caches.open('c2s-share-v1');
        const meta = await cache.match('share/meta');
        if (!meta) return null;
        const info = await meta.json();
        const files = [];
        for (let i = 0; i < info.count; i++) {
            const r = await cache.match(`share/${i}`);
            if (!r) continue;
            const blob = await r.blob();
            files.push(new File([blob], decodeURIComponent(r.headers.get('x-name') || `file-${i}`), { type: blob.type }));
        }
        await caches.delete('c2s-share-v1');
        return { files, text: info.text || '' };
    } catch {
        return null;
    }
}

/* ---------------------------------------------------------------- who is this? */

function otherSenders() {
    const c = S.chat;
    return c.senders.filter((s) => s.name !== c.meName);
}

async function matchPerson() {
    const c = S.chat;
    if (c.plain) { S.person = { status: 'none', query: '' }; renderSavePane(); return; }
    const others = otherSenders();
    const target = c.name || (others[0] && others[0].name) || '';
    const phone = c.phone || (looksLikePhone(target) ? target : (others.find((o) => looksLikePhone(o.name)) || {}).name);
    const tokens = looksLikePhone(target) ? [] : nameTokens(target);
    if (!phone && !tokens.length) { S.person = { status: 'none', query: target }; renderSavePane(); return; }
    S.person = { status: 'searching', query: target };
    renderSavePane();
    try {
        const { candidates, phoneMatched } = await guard(sf.findPeople({ phone, tokens }));
        const meId = S.me && S.me.Id;
        const ranked = candidates
            .map((x) => ({ ...x, _rank: scoreCandidate(x, { tokens, phoneMatched, meId }) }))
            .sort((a, b) => b._rank.score - a._rank.score || String(a.Name).localeCompare(String(b.Name)));
        const pick = confidentPick(ranked);
        if (pick) return choosePerson(pick, { auto: true, candidates: ranked.slice(0, 5) });
        S.person = { status: ranked.length ? 'unsure' : 'none', query: target, candidates: ranked.slice(0, 5) };
    } catch (e) {
        if (e instanceof sf.SignedOut) return;
        S.person = { status: 'none', query: target, error: e.message };
    }
    renderSavePane();
}

async function choosePerson(contact, { auto = false, candidates = [] } = {}) {
    S.person = { status: 'chosen', query: S.person ? S.person.query : '', contact, auto, candidates };
    S.practices = contact.AccountId ? [{ Id: contact.AccountId, ...(contact.Account || {}), IsDirect: true }] : [];
    S.practice = S.practices[0] || null;
    S.practiceSearch = false;
    if (!S.subjectTouched) S.subject = `WhatsApp with ${contact.Name}`;
    autoFill();
    renderSavePane();
    try {
        const [practices, earlier] = await Promise.all([guard(sf.practicesOf(contact.Id)), guard(sf.earlierSaves(contact.Id))]);
        if (S.person.contact !== contact) return;
        if (practices.length) {
            const meId = S.me && S.me.Id;
            const mine = practices.find((p) => p.AE__c === meId || p.ISP__c === meId || p.CSS__c === meId);
            S.practices = practices;
            S.practice = mine || practices.find((p) => p.Id === contact.AccountId) || practices[0];
        }
        markEarlierSaves(earlier);
        if (!S.chat.fromPaste) autoTickNewest();
    } catch (e) {
        if (e instanceof sf.SignedOut) return;
    }
    autoFill();
    renderSavePane();
    renderThread();
}

function choosePracticeOnly(account) {
    S.person = { status: 'chosen', query: S.person ? S.person.query : '', contact: null };
    S.practices = [account];
    S.practice = account;
    S.practiceSearch = false;
    if (!S.subjectTouched) S.subject = `WhatsApp with ${account.Name}`;
    autoFill();
    renderSavePane();
}

function markEarlierSaves(rows) {
    const c = S.chat;
    c.savedKeys = new Set();
    c.savedInfo = new Map();
    c.earlier = rows;
    for (const row of rows) {
        for (const k of keysInDescription(row.Description)) {
            if (!c.savedKeys.has(k)) {
                c.savedKeys.add(k);
                c.savedInfo.set(k, { by: row.Owner && row.Owner.Name, at: row.CreatedDate, isCase: !!row.isCase });
            }
        }
    }
    for (const i of [...S.selection]) {
        if (c.savedKeys.has(c.messages[i].key)) S.selection.delete(i);
    }
}

/* ---------------------------------------------------------------- the chat screen */

function selectable(m) {
    return m.kind === 'text' || m.kind === 'media';
}
function isSaved(m) {
    return S.chat.savedKeys.has(m.key);
}
function canPick(m) {
    return selectable(m) && !isSaved(m);
}

function chatSub() {
    const c = S.chat;
    const sel = c.messages.filter(selectable);
    return sel.length ? `${plural(c.convs.length, 'conversation', 'conversations')} · ${rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey)}` : '';
}

function renderChat() {
    const c = S.chat;
    const sub = chatSub();
    root.dataset.step = S.step;
    root.innerHTML = `
      ${topbar({ back: true, title: c.name || (otherSenders()[0] || {}).name || 'WhatsApp chat', sub })}
      <div class="chat-layout" data-step="${S.step}">
        <section class="messages-pane" aria-label="Conversations">
          <div class="toolbar" id="toolbar"></div>
          <div id="notices"></div>
          <div class="thread" id="thread"></div>
          <div class="pickbar mobile-only" id="pickbar"></div>
        </section>
        <aside class="save-pane" id="save-pane" aria-label="Save to Salesforce"></aside>
      </div>`;
    renderThread();
    renderSavePane();
}

function renderToolbar() {
    const c = S.chat;
    const pickable = c.messages.filter(canPick);
    const lastSaved = [...c.messages].reverse().find(isSaved);
    const newer = lastSaved ? pickable.filter((m) => m.index > lastSaved.index) : [];
    const el = root.querySelector('#toolbar');
    if (!el) return;
    el.innerHTML = `
      ${lastSaved && newer.length ? `<button class="chip" data-act="sel-new">New since last save (${newer.length})</button>` : ''}
      <button class="chip" data-act="sel-none" ${S.selection.size ? '' : 'disabled'}>Untick all</button>
      <span class="spacer"></span>
      <span class="faint desktop-only">Tap a conversation to tick it</span>`;
}

function renderNotices() {
    const c = S.chat;
    const el = root.querySelector('#notices');
    if (!el) return;
    const parts = [];
    if (!c.plain && !c.meName && c.senders.length > 1) {
        parts.push(`<div class="notice amber">${icon('hand')}<span><b>Which one is you?</b></span>
          <span class="chips">${c.senders.slice(0, 6).map((s) => `<button class="chip" data-act="me" data-name="${esc(s.name)}">${esc(s.name)}</button>`).join('')}</span></div>`);
    }
    if (c.plain) parts.push(`<div class="notice">${icon('alert')}<span>No WhatsApp times were in what you pasted, so it is saved as one message dated now.</span></div>`);
    const cutCount = c.messages.filter((m) => m.cut).length;
    if (cutCount) {
        const words = HOST.cutNotice ? HOST.cutNotice(cutCount, plural)
            : `WhatsApp cut ${plural(cutCount, 'long message', 'long messages')} short when copying (“Read more”). To keep every word, open ${cutCount === 1 ? 'it' : 'them'} in full in WhatsApp and copy again, or export the chat.`;
        parts.push(`<div class="notice amber">${icon('alert')}<span>${esc(words)}</span></div>`);
    }
    el.innerHTML = parts.join('');
}

function mediaHtml(m) {
    const kind = m.mediaKind;
    const have = m.attachment && S.chat.media.has(m.attachment);
    const label = { photo: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', document: 'Document', sticker: 'Sticker', contact: 'Contact card' }[kind] || 'Media';
    if (!have) {
        const why = m.attachment ? 'not in what was shared' : (S.chat.missingNote || 'not in the export');
        return `<div class="media"><span class="missing">${icon(kind === 'voice' ? 'mic' : kind === 'video' ? 'video' : kind === 'document' ? 'file' : 'photo')}${esc(label)} (${why})</span></div>`;
    }
    if (kind === 'photo' || kind === 'sticker') return `<div class="media"><img alt="${esc(label)}" data-media="${esc(m.attachment)}" width="240" height="160" decoding="async"></div>`;
    if (kind === 'voice' || kind === 'audio') return `<div class="media"><audio controls preload="none" data-media="${esc(m.attachment)}"></audio></div>`;
    return `<div class="media"><span class="file">${icon(kind === 'video' ? 'video' : 'file')}${esc(m.attachment)}</span></div>`;
}

function messageHtml(m) {
    const c = S.chat;
    if (!selectable(m)) {
        return `<div class="msg system"><div class="bubble">${esc(m.kind === 'deleted' ? `${m.sender || ''}: ${m.text}` : m.text)}</div></div>`;
    }
    const me = m.sender === c.meName;
    const saved = isSaved(m);
    const checked = S.selection.has(m.index);
    const info = saved ? c.savedInfo.get(m.key) : null;
    const savedTitle = info && info.isCase ? 'In a WhatsApp case' : info && info.by ? `Saved to Salesforce by ${info.by}` : 'Already in Salesforce';
    return `<div class="msg ${me ? 'me' : ''} ${saved ? 'saved' : ''}" role="checkbox" aria-checked="${checked}" aria-disabled="${saved}" tabindex="${saved ? -1 : 0}" data-i="${m.index}">
      <span class="tick">${icon('check')}</span>
      <div class="bubble">
        ${me ? '' : `<div class="from">${esc(m.sender)}</div>`}
        ${m.kind === 'media' ? mediaHtml(m) : ''}
        ${m.text ? `<div class="text">${esc(m.text)}</div>` : ''}
        <div class="meta">${m.cut ? '<span class="tag amber">Cut short</span>' : ''}${saved ? `<span class="saved-tag" title="${esc(savedTitle)}">${icon('check')}In Salesforce</span>` : ''}${m.edited ? '<span>edited</span>' : ''}<time>${esc(fmtTime.format(m.at))}</time></div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- conversations */

function convState(cv) {
    const msgs = cv.indexes.map((i) => S.chat.messages[i]).filter(selectable);
    const open = msgs.filter((m) => !isSaved(m));
    const ticked = open.filter((m) => S.selection.has(m.index)).length;
    return {
        msgs, open, ticked,
        state: !open.length ? (msgs.length ? 'done' : 'empty') : ticked === 0 ? 'off' : ticked === open.length ? 'on' : 'mixed'
    };
}

function convWhen(cv) {
    if (cv.firstDay !== cv.lastDay) return rangeLabel(cv.firstDay, cv.lastDay);
    const a = fmtTime.format(cv.start), b = fmtTime.format(cv.end);
    return `${dayLabel(cv.firstDay)} ${a === b ? a : `${a} – ${b}`}`;
}

function shortLine(m) {
    const who = m.sender === S.chat.meName ? 'You' : (nameTokens(m.sender)[0] || m.sender);
    let what = m.text || ({ photo: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', document: 'Document', sticker: 'Sticker' }[m.mediaKind] || 'Media');
    what = what.replace(/\s+/g, ' ');
    if (what.length > 110) what = what.slice(0, 107) + '…';
    return `<p class="line"><span>${esc(who)}:</span> ${esc(what)}</p>`;
}

/* "See all" only when the two preview lines do not already show the whole conversation. */
function hasMore(st) {
    return st.msgs.length > 2 || st.msgs.some((m) => m.kind === 'media' || (m.text || '').replace(/\s+/g, ' ').length > 110);
}

function convCountLabel(st) {
    if (st.state === 'done') return `<em class="ok">${icon('check')}In Salesforce</em>`;
    if (st.open.length < st.msgs.length) return `${st.open.length} new`;
    return plural(st.msgs.length, 'message', 'messages');
}

function convHtml(cv) {
    const st = convState(cv);
    if (st.state === 'empty') return '';
    const expanded = S.expanded.has(cv.id);
    let inner = '';
    if (expanded) {
        let day = cv.firstDay !== cv.lastDay ? null : cv.firstDay;
        for (const i of cv.indexes) {
            const m = S.chat.messages[i];
            if (m.dayKey !== day) { day = m.dayKey; inner += `<div class="day"><span>${esc(dayLabel(day))}</span></div>`; }
            inner += messageHtml(m);
        }
    } else {
        inner = st.msgs.slice(0, 2).map(shortLine).join('');
    }
    const more = expanded ? 'Show less' : hasMore(st)
        ? `See all ${st.msgs.length}${st.state === 'on' || st.state === 'mixed' ? ' · untick some' : ''}` : '';
    const aria = st.state === 'mixed' ? 'mixed' : String(st.state === 'on');
    return `<section class="conv ${st.state} ${expanded ? 'open' : ''}" data-conv="${cv.id}">
      <button class="conv-tick" data-act="conv" data-conv="${cv.id}" role="checkbox" aria-checked="${aria}" ${st.state === 'done' ? 'disabled' : ''}
        aria-label="Tick the conversation of ${esc(convWhen(cv))}">${icon(st.state === 'mixed' ? 'minus' : 'check')}</button>
      <div class="conv-body">
        <button class="conv-head" data-act="conv" data-conv="${cv.id}" ${st.state === 'done' ? 'disabled' : ''}>
          <span class="when">${esc(convWhen(cv))}</span><span class="count">${convCountLabel(st)}</span>
        </button>
        <div class="conv-lines">${inner}</div>
        ${more ? `<button class="btn link conv-more" data-act="expand" data-conv="${cv.id}">${esc(more)}</button>` : ''}
      </div>
    </section>`;
}

function renderThread() {
    if (S.view !== 'chat') return;
    const c = S.chat;
    const el = root.querySelector('#thread');
    if (!el) return;
    const newestFirst = [...c.convs].reverse();
    const shown = newestFirst.slice(0, S.shownConvs);
    const left = newestFirst.length - shown.length;
    el.innerHTML = shown.map(convHtml).join('') +
        (left > 0 ? `<button class="btn more-earlier" data-act="earlier">Show earlier conversations (${left.toLocaleString(LOCALE)} more)</button>`
            : HOST.threadFooter ? HOST.threadFooter({ icon, esc }) : '');
    renderNotices();
    refreshSelection();
    loadVisibleMedia();
}

const urls = new Map();
let mediaObserver = null;
function loadVisibleMedia() {
    if (!S.chat || !S.chat.media.size) return;
    const load = async (node) => {
        const name = node.getAttribute('data-media');
        const f = S.chat.media.get(name);
        if (!f) return;
        try {
            if (!urls.has(name)) urls.set(name, URL.createObjectURL(await f.read()));
            node.src = urls.get(name);
        } catch { /* left empty */ }
    };
    const nodes = root.querySelectorAll('[data-media]');
    if (!('IntersectionObserver' in window)) { nodes.forEach(load); return; }
    mediaObserver?.disconnect();
    mediaObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) { mediaObserver.unobserve(e.target); load(e.target); }
        }
    }, { rootMargin: '600px' });
    nodes.forEach((n) => mediaObserver.observe(n));
}

function selectedMessages() {
    return [...S.selection].sort((a, b) => a - b).map((i) => S.chat.messages[i]);
}

function refreshSelection() {
    const c = S.chat;
    root.querySelectorAll('.msg[data-i]').forEach((node) => {
        node.setAttribute('aria-checked', String(S.selection.has(Number(node.dataset.i))));
    });
    root.querySelectorAll('section.conv[data-conv]').forEach((node) => {
        const cv = c.convs[Number(node.dataset.conv)];
        const st = convState(cv);
        node.classList.remove('on', 'off', 'mixed', 'done');
        node.classList.add(st.state);
        const tick = node.querySelector('.conv-tick');
        tick.setAttribute('aria-checked', st.state === 'mixed' ? 'mixed' : String(st.state === 'on'));
        tick.innerHTML = icon(st.state === 'mixed' ? 'minus' : 'check');
        node.querySelector('.count').innerHTML = convCountLabel(st);
        const more = node.querySelector('.conv-more');
        if (more && !S.expanded.has(cv.id) && hasMore(st)) {
            more.textContent = `See all ${st.msgs.length}${st.state === 'on' || st.state === 'mixed' ? ' · untick some' : ''}`;
        }
    });
    const sel = selectedMessages();
    const touched = c.convs.filter((cv) => cv.indexes.some((i) => S.selection.has(i))).length;
    const bar = root.querySelector('#pickbar');
    if (bar) {
        bar.innerHTML = `<div class="count">${touched ? plural(touched, 'conversation', 'conversations') : 'Tap a conversation'}
            ${sel.length ? `<small>${plural(sel.length, 'message', 'messages')} · ${esc(rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey))}</small>` : ''}</div>
          <button class="btn primary" data-act="next" ${sel.length ? '' : 'disabled'}>Next</button>`;
    }
    renderToolbar();
    if (autoFill()) renderSavePane(); else updateSaveState();
}

/* ---------------------------------------------------------------- filled in for you */

function caseAvailable() {
    return !!(S.choices && S.choices.case && S.choices.case.recordTypeId);
}
function defaultKind() {
    return S.me && S.me.isCx && caseAvailable() ? 'case' : 'interaction';
}

/* Fills what is known into every choice the rep has not made themselves. True when anything changed. */
function autoFill() {
    if (!S.chat || !S.choices) return false;
    const before = JSON.stringify([S.purpose, S.outcome, S.caseSubject, S.auto]);
    const sel = selectedMessages();
    const contact = S.person && S.person.status === 'chosen' ? S.person.contact : null;
    const known = S.person && S.person.status === 'chosen' && !S.person.searchOpen;
    const s = suggestInteraction({
        earlier: S.chat.earlier || [],
        meId: S.me && S.me.Id,
        practice: known ? S.practice : null,
        personName: contact ? contact.Name : '',
        choices: S.choices,
        onlyMine: !!S.chat.meName && sel.length > 0 && sel.every((m) => m.sender === S.chat.meName)
    });
    for (const f of ['purpose', 'outcome']) {
        if (S.touched[f]) continue;
        S[f] = s[f];
        S.auto[f] = s[f] ? s.why[f] : null;
    }
    if (!S.caseSubjectTouched) {
        const cs = caseSubject(sel, S.chat.meName, contact ? contact.Name : S.practice ? S.practice.Name : '');
        S.caseSubject = cs.subject.slice(0, 255);
        S.auto.caseSubject = sel.length ? cs.why : null;
    }
    return JSON.stringify([S.purpose, S.outcome, S.caseSubject, S.auto]) !== before;
}

/* ---------------------------------------------------------------- the save pane */

function personCard(c, { pick = false, chosen = false } = {}) {
    const acc = c.Account || {};
    const line2 = [c.Role__c || c.Title, acc.Name, acc.BillingCity].filter(Boolean).join(' · ');
    const reasons = (c._rank && c._rank.reasons) || [];
    const tags = reasons.map((r) => `<span class="tag ${/No longer|Test/.test(r) ? 'red' : /phone|Same name|Your/.test(r) ? 'green' : ''}">${esc(r)}</span>`).join('');
    const tag = pick ? 'button' : 'div';
    return `<${tag} class="person ${pick ? 'pick' : ''} ${chosen ? 'chosen' : ''}" ${pick ? `data-act="pick-person" data-id="${esc(c.Id)}"` : ''}>
        <span class="avatar">${esc(initials(c.Name))}</span>
        <span><b>${esc(c.Name)}</b><small>${esc(line2 || 'No practice')}</small>${tags ? `<span class="why">${tags}</span>` : ''}</span>
        ${!pick && chosen ? '<button class="btn link" data-act="change-person">Change</button>' : '<span></span>'}
      </${tag}>`;
}

function practiceCard(a, { pick = false, chosen = false } = {}) {
    const tag = pick ? 'button' : 'div';
    const meId = S.me && S.me.Id;
    const yours = a.AE__c === meId || a.ISP__c === meId || a.CSS__c === meId;
    return `<${tag} class="person ${pick ? 'pick' : ''} ${chosen ? 'chosen' : ''}" ${pick ? `data-act="pick-practice" data-id="${esc(a.Id)}"` : ''}>
        <span class="avatar practice">${icon('building')}</span>
        <span><b>${esc(a.Name)}</b><small>${esc(a.BillingCity || '')}</small>
          <span class="why">${yours ? '<span class="tag green">Your practice</span>' : ''}${a.IsTestAccount__c ? '<span class="tag red">Test practice</span>' : ''}</span></span>
        <span></span>
      </${tag}>`;
}

function searchBox(placeholder, id) {
    return `<input type="search" id="${id}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="search">
            <div class="results" id="${id}-results"></div>`;
}

function whoHtml() {
    const p = S.person;
    if (!p || p.status === 'searching') {
        return `<div class="searching"><span class="spinner"></span><span>Looking for ${p && p.query ? `“${esc(p.query)}”` : 'this person'} in Salesforce…</span></div>`;
    }
    if (p.status === 'chosen' && !p.searchOpen) {
        if (!p.contact) return `<div class="person"><span class="avatar">?</span><span><b>No one in particular</b><small>Saved on the practice only</small></span><button class="btn link" data-act="change-person">Change</button></div>`;
        return personCard(p.contact, { chosen: true });
    }
    const lead = p.status === 'unsure'
        ? `<p class="muted">Which ${p.query ? `“${esc(p.query)}”` : 'one'} is it?</p>${p.candidates.map((c) => personCard(c, { pick: true })).join('')}`
        : p.status === 'none'
            ? `<p class="muted">${p.query ? `No one matching “${esc(p.query)}” in Salesforce.` : 'Who was this conversation with?'} Search by name, phone or practice.</p>`
            : '';
    return `${lead}${searchBox('Search a doctor, staff or practice', 'who-search')}${p.error ? `<p class="hint">${esc(p.error)}</p>` : ''}`;
}

function practiceHtml() {
    const p = S.person;
    if (!p || p.status !== 'chosen' || p.searchOpen) return '<p class="faint">Chosen with the person.</p>';
    if (S.practiceSearch) return searchBox('Search a practice', 'practice-search');
    if (!S.practices.length) {
        return `<p class="muted">${esc(p.contact ? p.contact.Name : 'This person')} has no practice in Salesforce.</p>${searchBox('Search a practice', 'practice-search')}`;
    }
    const many = S.practices.length > 1;
    return `${S.practices.map((a) => practiceCard(a, { pick: many, chosen: S.practice && S.practice.Id === a.Id })).join('')}
            <button class="btn link" data-act="practice-other">Another practice</button>`;
}

function filledHtml(why) {
    return why ? `<p class="filled">${icon('check')}${esc(why)}</p>` : '';
}

function kindHtml() {
    if (!caseAvailable()) return '';
    const order = S.me && S.me.isCx ? ['case', 'interaction'] : ['interaction', 'case'];
    const label = { interaction: 'Interaction', case: 'Case' };
    return `<div class="seg" role="radiogroup" aria-label="Save as">${order.map((k) =>
        `<button role="radio" aria-checked="${S.kind === k}" class="${S.kind === k ? 'on' : ''}" data-act="kind" data-kind="${k}">${label[k]}</button>`).join('')}</div>`;
}

function caseFieldsHtml() {
    const ci = (S.choices && S.choices.case) || { topics: [], types: [] };
    const cx = !!(S.me && S.me.isCx);
    const src = caseSource(S.practice);
    const practiceName = S.practice ? S.practice.Name : 'the practice';
    return `
        <div class="field"><label for="case-subject">Subject</label><input type="text" id="case-subject" maxlength="255" value="${esc(S.caseSubject)}">${filledHtml(S.auto.caseSubject)}</div>
        ${cx ? `
          <div class="field"><label for="topic">Topic <small>optional</small></label>${pickerHtml('topic')}</div>
          <div class="field"><label for="case-type">Type <small>optional</small></label>${pickerHtml('case-type')}</div>
          ${src.source ? filledHtml(`Source: ${src.source} (${src.why}) · Origin: WhatsApp`) : ''}` : ''}
        <div class="route">${icon(cx ? 'person' : 'arrow')}<span>${cx
            ? '<b>Comes to you in Omni-Channel</b>Accept it there, as with any case you create.'
            : `<b>Goes to CX</b>${esc(possessive(practiceName))} CX agent picks it up, or the CX team for its region.`}</span></div>`;
}

/*
 * PICKERS. Every list on the save screen is the app's own picker, not the browser's: the whole label
 * shows (never "Practice will follow up & task has been crea…"), the options open in the page under
 * it with the chosen one ticked, and a long list (a case's Type) has a search box and puts first the
 * types that fit the Topic chosen.
 */
const TOPIC_TYPES = {
    Hardware: /hardware|adapter|scanbox/i,
    Billing: /billing|invoic|payment|collection|dispute/i,
    Monitoring: /clinical|pawn|scan report|investigation|smart stl/i,
    'Mobile app': /mobile app/i,
    DentalMind: /dentalmind/i,
    Privacy: /privacy|security/i,
    Insights: /web platform|insight/i,
    Engage: /sales|dso|dm\+/i
};
const PICKERS = {
    purpose: { label: 'Purpose', list: () => S.choices.purposes, get: () => S.purpose,
        set: (v) => { S.purpose = v; S.touched.purpose = true; S.auto.purpose = null; } },
    outcome: { label: 'Outcome', list: () => S.choices.outcomes, get: () => S.outcome,
        set: (v) => { S.outcome = v; S.touched.outcome = true; S.auto.outcome = null; } },
    topic: { label: 'Topic', optional: true, list: () => S.choices.case.topics, get: () => S.topic, set: (v) => { S.topic = v; } },
    'case-type': { label: 'Type', optional: true, list: () => S.choices.case.types, get: () => S.caseType, set: (v) => { S.caseType = v; },
        suggest: () => (S.topic && TOPIC_TYPES[S.topic]) || null }
};

function pickerHtml(id) {
    const p = PICKERS[id];
    const list = p.list() || [];
    const current = p.get();
    const chosen = list.find((o) => o.value === current);
    const open = S.openPicker === id;
    let body = '';
    if (open) {
        const fits = p.suggest ? p.suggest() : null;
        const top = fits ? list.filter((o) => fits.test(o.label)) : [];
        const rest = list.filter((o) => !top.includes(o));
        const row = (o) => `<button type="button" role="option" class="pick-opt" aria-selected="${o.value === current}" data-act="pick-opt" data-id="${id}" data-value="${esc(o.value)}">${icon('check')}<span>${esc(o.label)}</span></button>`;
        body = `<div class="pick-list" role="listbox" aria-label="${esc(p.label)}">
            ${list.length > 12 ? `<input type="search" class="pick-q" id="${id}-q" placeholder="Search ${list.length} ${esc(p.label.toLowerCase())}s" autocomplete="off" enterkeyhint="search">` : ''}
            ${top.length ? `<p class="group">For ${esc(S.topic)}</p>${top.map(row).join('')}<p class="group">All</p>` : ''}
            ${rest.map(row).join('')}
            ${p.optional && current ? `<button type="button" class="pick-opt clear" data-act="pick-opt" data-id="${id}" data-value="">Clear</button>` : ''}
          </div>`;
    }
    return `<button type="button" id="${id}" class="pick-btn ${chosen ? '' : 'empty'} ${open ? 'open' : ''}" data-act="picker" data-id="${id}"
        data-value="${esc(current || '')}" aria-haspopup="listbox" aria-expanded="${open}"><span>${esc(chosen ? chosen.label : 'Choose…')}</span>${icon('chev')}</button>${body}`;
}

function filterPicker(input) {
    const q = input.value.trim().toLowerCase();
    const listEl = input.closest('.pick-list');
    listEl.querySelectorAll('.pick-opt:not(.clear)').forEach((b) => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q); });
    listEl.querySelectorAll('.group').forEach((g) => { g.hidden = !!q; });
}

function selectHtml(id, list, current, { optional = false } = {}) {
    return `<select id="${id}" class="picker ${current ? '' : 'empty'}">
        <option value="" ${current ? '' : 'selected'} ${optional ? '' : 'disabled'}>Choose…</option>
        ${list.map((o) => `<option value="${esc(o.value)}" ${current === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
}

/* The practice is asked only when there is a choice to make: the person card already names it. */
function needsPracticeField() {
    const p = S.person;
    if (!p || p.status !== 'chosen' || p.searchOpen) return false;
    return S.practiceSearch || !p.contact || S.practices.length !== 1 ||
        (S.practice && p.contact.AccountId && S.practice.Id !== p.contact.AccountId);
}

function saveSummary() {
    const sel = selectedMessages();
    return sel.length ? `${plural(sel.length, 'message', 'messages')} · ${rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey)}` : 'No messages ticked yet';
}

function renderSavePane() {
    if (S.view !== 'chat') return;
    const el = root.querySelector('#save-pane');
    if (!el) return;
    const choices = S.choices || { purposes: [], outcomes: [] };
    const active = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
    const keep = active && active.id ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
    el.innerHTML = `
      <div class="save-fields">
        <div class="save-head desktop-only">
          <p class="eyebrow">Save to Salesforce</p>
          <h2 class="save-summary">${esc(saveSummary())}</h2>
        </div>
        ${kindHtml()}
        <div class="field"><span class="label">Who</span>${whoHtml()}</div>
        ${needsPracticeField() || (S.kind === 'case' && !S.practice && S.person && S.person.status === 'chosen' && !S.person.searchOpen)
            ? `<div class="field"><span class="label">Practice</span>${practiceHtml()}</div>` : ''}
        ${S.kind === 'case' ? caseFieldsHtml() : `
        <div class="field"><label for="purpose">Purpose</label>${pickerHtml('purpose')}${filledHtml(S.auto.purpose)}</div>
        <div class="field"><label for="outcome">Outcome</label>${pickerHtml('outcome')}${filledHtml(S.auto.outcome)}</div>`}
        ${S.noteOpen ? `
          <div class="field"><label for="note">Note</label><textarea id="note" rows="3" placeholder="${S.kind === 'case' ? 'What does the practice need?' : 'What was agreed?'}">${esc(S.note)}</textarea></div>
          ${S.kind === 'case' ? '' : `<div class="field"><label for="subject">Subject</label><input type="text" id="subject" maxlength="255" value="${esc(S.subject)}"></div>`}
          <details class="preview"><summary>What Salesforce will keep</summary><pre id="preview"></pre></details>`
        : `<button class="btn link note-link" data-act="note-open">${icon('plus')}Add a note</button>`}
      </div>
      <div class="savebar">
        <div id="save-error">${S.error ? `<div class="error" role="alert">${icon('alert')}<span>${esc(S.error)}</span></div>` : ''}</div>
        <p class="hint" id="save-hint"></p>
        <button class="btn primary big block" data-act="save" id="save-btn">${S.saving ? `<span class="spinner"></span>${esc(S.saving)}` : S.kind === 'case' ? 'Create the case' : 'Save to Salesforce'}</button>
      </div>`;
    if (keep) {
        const again = el.querySelector(`#${keep.id}`);
        if (again) {
            if (/search|-q$/.test(keep.id)) again.value = keep.value;
            if (again.classList.contains('pick-q')) filterPicker(again);
            again.focus();
            try { again.setSelectionRange(keep.start, keep.end); } catch { /* not a text box */ }
        }
    }
    updateSaveState();
}

function missing() {
    const out = [];
    if (!S.selection.size) out.push('tick a conversation');
    if (!S.person || S.person.status !== 'chosen' || S.person.searchOpen) out.push('choose who it was with');
    else if (!S.practice && (S.kind === 'case' || !S.person.contact)) out.push('choose the practice');
    if (S.kind === 'case') {
        if (!S.caseSubject.trim()) out.push('write a subject');
        return out;
    }
    if (!S.purpose) out.push('pick a purpose');
    if (!S.outcome) out.push('pick an outcome');
    return out;
}

function updateSaveState() {
    const btn = root.querySelector('#save-btn');
    if (!btn) return;
    const gaps = missing();
    const hint = root.querySelector('#save-hint');
    const sel = selectedMessages();
    root.querySelectorAll('.save-summary').forEach((n) => { n.textContent = saveSummary(); });
    if (hint) hint.textContent = gaps.length && !S.saving ? `To save: ${gaps.join(', ')}.` : '';
    btn.disabled = !!S.saving || gaps.length > 0;
    const pre = root.querySelector('#preview');
    if (pre) pre.textContent = sel.length ? buildDescription(sel, { forPreview: true }) : '';
}

/* ---------------------------------------------------------------- saving */

/*
 * The words keep each person's name as WhatsApp wrote it. Two exceptions: the rep is written as
 * their Salesforce name, and a sender WhatsApp shows only as a phone number takes the name of the
 * person matched on that number (never the name of someone the rep picked by hand).
 */
function senderLabel(m) {
    const c = S.chat;
    if (c.meName && m.sender === c.meName) return S.me ? S.me.Name : m.sender;
    const contact = S.person && S.person.contact;
    const byPhone = contact && contact._rank && contact._rank.reasons.includes('Same phone number');
    if (byPhone && looksLikePhone(m.sender)) return contact.Name;
    return m.sender;
}

function buildDescription(sel, { forPreview = false } = {}) {
    const lines = [];
    const note = S.note.trim();
    if (note) lines.push(note, '');
    lines.push(`WhatsApp, ${plural(sel.length, 'message', 'messages')}, ${rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey)}:`);
    for (const m of sel) {
        const willUpload = m.attachment && S.chat.media.has(m.attachment) && (S.chat.media.get(m.attachment).size || 0) <= sf.MAX_FILE_BYTES;
        lines.push(transcriptLine({ ...m, uploaded: forPreview ? willUpload : m.uploaded, missingNote: S.chat.missingNote }, senderLabel(m)));
    }
    lines.push('', '—', 'Saved from WhatsApp with Chat to Salesforce.');
    return lines.join('\n');
}

async function save() {
    const gaps = missing();
    if (gaps.length || S.saving) return;
    const sel = selectedMessages();
    const media = S.chat.media;
    const toUpload = sel.filter((m) => m.attachment && media.has(m.attachment));
    const uploadable = toUpload.filter((m) => (media.get(m.attachment).size || 0) <= sf.MAX_FILE_BYTES);
    const tooBig = toUpload.filter((m) => !uploadable.includes(m));
    const marked = sel.map((m) => ({ ...m, uploaded: uploadable.includes(m) }));
    const description = buildDescription(marked);
    if (description.length > DESCRIPTION_MAX) {
        S.error = `That is more than Salesforce keeps in one interaction (${DESCRIPTION_MAX.toLocaleString(LOCALE)} characters; this is ${description.length.toLocaleString(LOCALE)}). Untick some messages, or save the chat in two parts.`;
        renderSavePane();
        return;
    }
    const contact = S.person.contact;
    const practice = S.practice;
    if (S.kind === 'case') return saveAsCase({ sel, description, contact, practice, uploadable, tooBig, media });
    const fields = {
        Subject: (S.subject.trim() || `WhatsApp with ${contact ? contact.Name : practice.Name}`).slice(0, 255),
        Description: description,
        WhoId: contact ? contact.Id : null,
        WhatId: practice ? practice.Id : null,
        ActivityDate: sel[sel.length - 1].dayKey,
        Status: 'Completed',
        Priority: 'Normal',
        TaskSubtype: 'Call',
        Interaction_type__c: 'Text/SMS/Whatsapp',
        This_is_an_Interaction__c: true,
        Employee_Interaction_Type__c: employeeTypeFor(practice, S.me && S.me.Id, S.me && S.me.usualType),
        Purpose_LogACall__c: S.purpose,
        Interaction_Outcome__c: S.outcome
    };
    if (!/^WhatsApp/i.test(fields.Subject)) fields.Subject = `WhatsApp: ${fields.Subject}`.slice(0, 255);
    S.error = null;
    S.saving = 'Saving…';
    renderSavePane();
    let id;
    try {
        id = await guard(sf.saveInteraction(fields));
    } catch (e) {
        S.saving = null;
        if (e instanceof sf.SignedOut) return;
        S.error = e.message;
        renderSavePane();
        return;
    }
    const failed = [...tooBig.map((m) => ({ name: m.attachment, why: 'larger than 25 MB' }))];
    let n = 0;
    for (const m of uploadable) {
        n++;
        S.saving = `Attaching ${n} of ${uploadable.length}…`;
        renderSavePane();
        try {
            await guard(sf.attachFile(id, m.attachment, await media.get(m.attachment).read()));
        } catch (e) {
            if (e instanceof sf.SignedOut) return;
            failed.push({ name: m.attachment, why: e.message });
        }
    }
    if (failed.some((f) => f.why !== 'larger than 25 MB')) {
        // the words say "(attached)" only for files that really are
        let fixed = description;
        for (const f of failed) fixed = fixed.split(` ${f.name} (attached)]`).join(` ${f.name}]`);
        await sf.api(`/sobjects/Task/${id}`, { method: 'PATCH', body: { Description: fixed } }).catch(() => {});
    }
    for (const m of sel) S.chat.savedKeys.add(m.key);
    S.selection = new Set();
    S.saving = null;
    S.note = '';
    S.purpose = null;
    S.outcome = null;
    S.touched = {};
    S.auto = {};
    S.recent = null;
    S.lastSaved = {
        id, count: sel.length, contact, practice,
        files: uploadable.length - failed.filter((f) => f.why !== 'larger than 25 MB').length, failed
    };
    S.view = 'saved';
    render();
}

async function saveAsCase({ sel, description, contact, practice, uploadable, tooBig, media }) {
    const ci = S.choices.case;
    const src = caseSource(practice);
    const fields = {
        RecordTypeId: ci.recordTypeId,
        Origin: 'Whatsapp',
        Status: 'New',
        Subject: S.caseSubject.trim().slice(0, 255),
        Description: description,
        ContactId: contact ? contact.Id : null,
        AccountId: practice.Id
    };
    if (src.source) fields.Source__c = src.source;
    if (S.topic) fields.Topic__c = S.topic;
    if (S.caseType) fields.Type__c = S.caseType;
    S.error = null;
    S.saving = 'Creating the case…';
    renderSavePane();
    let made;
    try {
        made = await guard(sf.saveCase(fields));
    } catch (e) {
        S.saving = null;
        if (e instanceof sf.SignedOut) return;
        S.error = e.message;
        renderSavePane();
        return;
    }
    const failed = tooBig.map((m) => ({ name: m.attachment, why: 'larger than 25 MB' }));
    let n = 0;
    for (const m of uploadable) {
        n++;
        S.saving = `Attaching ${n} of ${uploadable.length}…`;
        renderSavePane();
        try {
            await guard(sf.attachFile(made.id, m.attachment, await media.get(m.attachment).read()));
        } catch (e) {
            if (e instanceof sf.SignedOut) return;
            failed.push({ name: m.attachment, why: e.message });
        }
    }
    for (const m of sel) S.chat.savedKeys.add(m.key);
    S.selection = new Set();
    S.saving = null;
    S.note = '';
    S.topic = null;
    S.caseType = null;
    S.caseSubjectTouched = false;
    S.recent = null;
    S.lastSaved = {
        kind: 'case', id: made.id, number: made.number, toMe: !!(S.me && S.me.isCx), count: sel.length, contact, practice,
        files: uploadable.length - failed.filter((f) => f.why !== 'larger than 25 MB').length, failed
    };
    S.view = 'saved';
    render();
}

function renderSaved() {
    const s = S.lastSaved;
    if (s.kind === 'case') return renderSavedCase(s);
    const where = [s.contact && s.contact.Name, s.practice && s.practice.Name].filter(Boolean).join(' · ');
    const left = S.chat ? S.chat.messages.filter(canPick).length : 0;
    root.innerHTML = `
      ${topbar()}
      <main class="page">
        <section class="card saved-card" role="status">
          <span class="big-tick">${icon('check')}</span>
          <h1>Saved to Salesforce</h1>
          <p class="muted">${plural(s.count, 'message', 'messages')} on ${esc(where)}${s.files ? `, with ${plural(s.files, 'file', 'files')} attached` : ''}.</p>
          ${s.failed.length ? `<div class="error">${icon('alert')}<span>Not attached: ${s.failed.map((f) => `${esc(f.name)} (${esc(f.why)})`).join('; ')}</span></div>` : ''}
          <div class="btn-row">
            <a class="btn primary big" href="${esc(sf.recordUrl(s.id))}" target="_blank" rel="noopener">${icon('external')}Open in Salesforce</a>
            ${left ? '<button class="btn big" data-act="more">Save more from this chat</button>' : ''}
            <button class="btn big" data-act="home">Done</button>
          </div>
        </section>
      </main>`;
}

function renderSavedCase(s) {
    const where = [s.contact && s.contact.Name, s.practice && s.practice.Name].filter(Boolean).join(' · ');
    const left = S.chat ? S.chat.messages.filter(canPick).length : 0;
    root.innerHTML = `
      ${topbar()}
      <main class="page">
        <section class="card saved-card" role="status">
          <span class="big-tick">${icon('check')}</span>
          <h1>${s.number ? `Case ${esc(s.number)} created` : 'Case created'}</h1>
          <p class="muted">${plural(s.count, 'message', 'messages')} on ${esc(where)}${s.files ? `, with ${plural(s.files, 'file', 'files')} attached` : ''}.</p>
          <p class="muted">${s.toMe ? 'It comes to you in Omni-Channel.' : `CX picks it up: ${esc(possessive(s.practice ? s.practice.Name : 'the practice'))} CX agent, or the CX team for its region.`}</p>
          ${s.failed.length ? `<div class="error">${icon('alert')}<span>Not attached: ${s.failed.map((f) => `${esc(f.name)} (${esc(f.why)})`).join('; ')}</span></div>` : ''}
          <div class="btn-row">
            <a class="btn primary big" href="${esc(sf.recordUrl(s.id, 'Case'))}" target="_blank" rel="noopener">${icon('external')}Open the case</a>
            ${left ? '<button class="btn big" data-act="more">Save more from this chat</button>' : ''}
            <button class="btn big" data-act="home">Done</button>
          </div>
        </section>
      </main>`;
}

/* ---------------------------------------------------------------- search boxes */

let searchTimer;
let searchSeq = 0;
async function runSearch(input) {
    const id = input.id;
    const out = root.querySelector(`#${id}-results`);
    const text = input.value;
    const seq = ++searchSeq;
    if (text.trim().length < 2) { out.innerHTML = ''; return; }
    out.innerHTML = '<div class="searching"><span class="spinner"></span><span>Searching…</span></div>';
    try {
        const r = await guard(sf.searchAll(text));
        if (seq !== searchSeq) return;
        const meId = S.me && S.me.Id;
        const tokens = nameTokens(text);
        S._results = { contacts: r.contacts, accounts: r.accounts };
        const contacts = r.contacts
            .map((c) => ({ ...c, _rank: scoreCandidate(c, { tokens, meId }) }))
            .sort((a, b) => b._rank.score - a._rank.score)
            .map((c) => ({ ...c, _rank: { ...c._rank, reasons: c._rank.reasons.filter((x) => !/name/i.test(x)) } }));
        S._results.contacts = contacts;
        const onlyPractices = id === 'practice-search';
        let html = '';
        if (!onlyPractices && contacts.length) html += `<p class="group">People</p>${contacts.map((c) => personCard(c, { pick: true })).join('')}`;
        if (r.accounts.length) html += `<p class="group">Practices</p>${r.accounts.map((a) => practiceCard(a, { pick: true })).join('')}`;
        out.innerHTML = html || `<p class="empty">Nothing found for “${esc(text)}”.</p>`;
    } catch (e) {
        if (e instanceof sf.SignedOut) return;
        out.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    }
}

/* ---------------------------------------------------------------- events */

function onClick(e) {
    if (e.target.closest('audio, a[href]')) return;
    if (S.openPicker && !e.target.closest('.pick-list, .pick-btn')) { S.openPicker = null; renderSavePane(); }
    const target = e.target.closest('[data-act], .msg[data-i]');
    if (!target) {
        if (S.menuOpen && !e.target.closest('.menu')) { S.menuOpen = false; render(); }
        return;
    }
    if (target.matches('.msg[data-i]') && !target.dataset.act) return toggleMessage(target, e.shiftKey);
    const act = target.dataset.act;
    switch (act) {
        case 'signin': signIn(); break;
        case 'consent':
            writeLocal(CONSENT_KEY, { at: new Date().toISOString(), version: 1 });
            proceedAfterWelcome();
            break;
        case 'menu': S.menuOpen = !S.menuOpen; render(); break;
        case 'signout':
            S.menuOpen = false;
            stopHost();
            sf.signOut();
            S.me = null; S.chat = null; S.recent = null; S.view = 'welcome';
            render();
            break;
        case 'withdraw':
            S.menuOpen = false;
            stopHost();
            writeLocal(CONSENT_KEY, null);
            S.chat = null; S.view = 'welcome';
            S.flash = { kind: 'green', text: 'WhatsApp access stopped. Nothing from your chats is kept here.' };
            render();
            break;
        case 'home': goHome(); break;
        case 'install':
            S.installEvent && S.installEvent.prompt();
            S.installEvent = null; render();
            break;
        case 'install-no': writeLocal(INSTALL_DISMISSED_KEY, true); render(); break;
        case 'paste-open': S.pasteOpen = !S.pasteOpen; render(); break;
        case 'clipboard':
            navigator.clipboard.readText().then((t) => {
                const box = root.querySelector('#paste-text');
                if (box) box.value = t;
                if (t && t.trim()) openText(t, '', new Map(), { fromPaste: true });
            }).catch(() => toast('Your browser did not allow reading the clipboard. Paste into the box instead.'));
            break;
        case 'paste-go': {
            const t = root.querySelector('#paste-text').value;
            openText(t, '', new Map(), { fromPaste: true });
            break;
        }
        case 'file': root.querySelector('#file-input').click(); break;
        case 'earlier': S.shownConvs += CONV_PAGE; renderThread(); break;
        case 'conv': {
            const cv = S.chat.convs[Number(target.dataset.conv)];
            const st = convState(cv);
            const on = st.state !== 'on';
            st.open.forEach((m) => (on ? S.selection.add(m.index) : S.selection.delete(m.index)));
            S.userTouched = true;
            refreshSelection();
            break;
        }
        case 'expand': {
            const id = Number(target.dataset.conv);
            S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
            renderThread();
            break;
        }
        case 'sel-none': S.selection.clear(); S.userTouched = true; refreshSelection(); break;
        case 'sel-new': {
            const lastSaved = [...S.chat.messages].reverse().find(isSaved);
            S.chat.messages.filter((m) => canPick(m) && m.index > lastSaved.index).forEach((m) => S.selection.add(m.index));
            S.userTouched = true;
            refreshSelection();
            break;
        }
        case 'me': {
            const name = target.dataset.name;
            S.chat.meName = name;
            const list = (readLocal(ME_NAMES_KEY) || []).filter((n) => n !== name);
            writeLocal(ME_NAMES_KEY, [name, ...list].slice(0, 5));
            renderChat();
            matchPerson();
            break;
        }
        case 'next':
            S.step = 'save';
            root.dataset.step = 'save';
            root.querySelector('.chat-layout').dataset.step = 'save';
            window.scrollTo(0, 0);
            break;
        case 'back':
            if (S.step === 'save' && window.matchMedia('(max-width: 899.98px)').matches) {
                S.step = 'pick';
                root.dataset.step = 'pick';
                root.querySelector('.chat-layout').dataset.step = 'pick';
            } else {
                goHome();
            }
            break;
        case 'note-open':
            S.noteOpen = true;
            renderSavePane();
            root.querySelector('#note')?.focus();
            break;
        case 'pick-person': {
            const all = [...((S.person && S.person.candidates) || []), ...((S._results && S._results.contacts) || [])];
            const c = all.find((x) => x.Id === target.dataset.id);
            if (c) choosePerson(c);
            break;
        }
        case 'pick-practice': {
            const all = [...S.practices, ...((S._results && S._results.accounts) || [])];
            const a = all.find((x) => x.Id === target.dataset.id);
            if (!a) break;
            if (S.person && S.person.status === 'chosen' && !S.person.searchOpen && (S.person.contact || S.practiceSearch)) {
                if (!S.practices.some((p) => p.Id === a.Id)) S.practices = [...S.practices, a];
                S.practice = a;
                S.practiceSearch = false;
                renderSavePane();
            } else {
                choosePracticeOnly(a);
            }
            break;
        }
        case 'change-person':
            S.person = { ...S.person, searchOpen: true, status: S.person.candidates && S.person.candidates.length ? 'unsure' : 'none' };
            renderSavePane();
            root.querySelector('#who-search')?.focus();
            break;
        case 'practice-other':
            S.practiceSearch = true;
            renderSavePane();
            root.querySelector('#practice-search')?.focus();
            break;
        case 'save': save(); break;
        case 'kind':
            S.kind = target.dataset.kind === 'case' ? 'case' : 'interaction';
            S.error = null;
            S.openPicker = null;
            renderSavePane();
            break;
        case 'picker': {
            const id = target.dataset.id;
            S.openPicker = S.openPicker === id ? null : id;
            renderSavePane();
            const pane = root.querySelector('#save-pane');
            const next = pane && (pane.querySelector(`#${id}-q`) || pane.querySelector(`.pick-list [aria-selected="true"]`) || pane.querySelector('.pick-list .pick-opt'));
            if (S.openPicker && next) next.focus({ preventScroll: true }); else pane?.querySelector(`#${id}`)?.focus();
            pane?.querySelector('.pick-list')?.scrollIntoView({ block: 'nearest' });
            break;
        }
        case 'pick-opt': {
            const id = target.dataset.id;
            PICKERS[id].set(target.dataset.value || null);
            S.openPicker = null;
            renderSavePane();
            root.querySelector(`#save-pane #${id}`)?.focus();
            break;
        }
        case 'more':
            S.view = 'chat'; S.step = 'pick';
            render();
            window.scrollTo(0, 0);
            break;
        default:
            if (act.startsWith('host-') && HOST.onAct) HOST.onAct(act, target);
            break;
    }
}

function goHome() {
    S.view = 'home'; S.chat = null; S.menuOpen = false;
    render();
    if (hostStarted && HOST.onHome) HOST.onHome();
}

async function signIn() {
    const r = await sf.startSignIn();
    if (r == null) return; // the site: on its way to Salesforce's login page
    if (r !== true) { S.flash = { kind: 'amber', text: r }; S.view = 'welcome'; render(); return; }
    try {
        await loadSession();
    } catch (e) {
        S.me = null;
        S.flash = { kind: 'amber', text: e.message };
    }
    proceedAfterWelcome();
}

/* ---------------------------------------------------------------- the add-on's hooks */

let hostStarted = false;
const HOST_API = {
    openChat: (chat) => openText(chat.text, '', new Map(), {
        chatName: chat.name, phone: chat.phone, meName: chat.meName, localeHint: chat.localeHint, missingNote: chat.missingNote
    }),
    updateChat: (chat) => refreshChat(chat.text, { meName: chat.meName, localeHint: chat.localeHint }),
    showHome: () => { S.view = 'home'; S.chat = null; render(); },
    refreshHome: () => { if (S.view === 'home') render(); },
    refreshThread: () => { if (S.view === 'chat') renderThread(); },
    toast,
    isBusy: () => !!S.saving,
    view: () => S.view,
    chatName: () => (S.chat ? S.chat.name : null)
};
function startHost() {
    if (!HOST.ready || hostStarted) return;
    hostStarted = true;
    HOST.ready(HOST_API);
}
function stopHost() {
    if (!hostStarted) return;
    hostStarted = false;
    if (HOST.onStop) HOST.onStop();
}

function toggleMessage(node, shift) {
    const i = Number(node.dataset.i);
    const m = S.chat.messages[i];
    if (!canPick(m)) return;
    if (shift && S.lastClicked !== null) {
        const [a, b] = [Math.min(S.lastClicked, i), Math.max(S.lastClicked, i)];
        const on = !S.selection.has(i);
        for (let k = a; k <= b; k++) {
            const mm = S.chat.messages[k];
            if (canPick(mm)) on ? S.selection.add(k) : S.selection.delete(k);
        }
    } else {
        S.selection.has(i) ? S.selection.delete(i) : S.selection.add(i);
    }
    S.lastClicked = i;
    S.userTouched = true;
    refreshSelection();
}

function onKey(e) {
    if (e.key === 'Escape' && S.menuOpen) { S.menuOpen = false; render(); return; }
    if (e.key === 'Escape' && S.openPicker) {
        const id = S.openPicker;
        S.openPicker = null;
        renderSavePane();
        root.querySelector(`#save-pane #${id}`)?.focus();
        return;
    }
    const node = e.target.closest && e.target.closest('.msg[data-i]');
    if (node && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleMessage(node, e.shiftKey); }
    if (e.target.id === 'paste-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        openText(e.target.value, '', new Map(), { fromPaste: true });
    }
}

function onInput(e) {
    const t = e.target;
    if (t.id === 'subject') { S.subject = t.value; S.subjectTouched = true; }
    else if (t.classList.contains('pick-q')) filterPicker(t);
    else if (t.id === 'case-subject') {
        S.caseSubject = t.value; S.caseSubjectTouched = true; S.auto.caseSubject = null;
        t.parentElement.querySelector('.filled')?.remove();
        updateSaveState();
    }
    else if (t.id === 'note') { S.note = t.value; updateSaveState(); }
    else if (t.id === 'who-search' || t.id === 'practice-search') {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(t), 300);
    }
}

function onChange(e) {
    if (e.target.id === 'purpose' || e.target.id === 'outcome') {
        S[e.target.id] = e.target.value || null;
        S.touched[e.target.id] = true;
        S.auto[e.target.id] = null;
        e.target.classList.toggle('empty', !e.target.value);
        e.target.parentElement.querySelector('.filled')?.remove();
        updateSaveState();
        return;
    }
    if (e.target.id === 'topic' || e.target.id === 'case-type') {
        S[e.target.id === 'topic' ? 'topic' : 'caseType'] = e.target.value || null;
        e.target.classList.toggle('empty', !e.target.value);
        return;
    }
    if (e.target.id === 'file-input' && e.target.files.length) {
        openFiles(e.target.files);
        e.target.value = '';
    }
}

function wireDrop() {
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (S.view === 'home') { depth++; root.querySelector('#add-card')?.classList.add('drag'); e.preventDefault(); } });
    window.addEventListener('dragover', (e) => { if (S.view === 'home') e.preventDefault(); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; root.querySelector('#add-card')?.classList.remove('drag'); } });
    window.addEventListener('drop', (e) => {
        if (S.view !== 'home') return;
        e.preventDefault();
        depth = 0;
        root.querySelector('#add-card')?.classList.remove('drag');
        if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
        else {
            const t = e.dataTransfer.getData('text/plain');
            if (t) openText(t, '', new Map(), { fromPaste: true });
        }
    });
    window.addEventListener('paste', (e) => {
        if (S.view !== 'home' || (e.target && e.target.id === 'paste-text')) return;
        const t = e.clipboardData && e.clipboardData.getData('text/plain');
        if (t && t.trim()) { e.preventDefault(); openText(t, '', new Map(), { fromPaste: true }); }
    });
}

/* ---------------------------------------------------------------- start */

/* The phone toolbar sits under the top bar, whose height grows with the phone's text size. */
function measureTopbar() {
    const bar = root.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
}

function render() {
    renderView();
    measureTopbar();
}

function renderView() {
    if (S.view === 'welcome') return renderWelcome();
    if (S.view === 'home') return renderHome();
    if (S.view === 'chat' && S.chat) return renderChat();
    if (S.view === 'saved') return renderSaved();
    return renderHome();
}

let pendingShare = null;
function proceedAfterWelcome() {
    if (!S.me) { S.view = 'welcome'; return render(); }
    if (!hasConsent()) { S.view = 'welcome'; return render(); }
    if (pendingShare) {
        const share = pendingShare;
        pendingShare = null;
        if (share.files.length) return openFiles(share.files);
        if (share.text) return openText(share.text, '', new Map(), { fromPaste: true });
    }
    S.view = 'home';
    render();
    startHost();
}

async function loadSession() {
    const [me, choices] = await Promise.all([sf.loadMe(), sf.loadChoices()]);
    S.me = me;
    S.choices = choices;
}

async function start() {
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    document.addEventListener('click', (e) => { if (S.menuOpen && !root.contains(e.target)) { S.menuOpen = false; render(); } });
    wireDrop();
    window.addEventListener('resize', measureTopbar);
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        S.installEvent = e;
        if (S.view === 'home') render();
    });
    if (HOST.kind !== 'web') root.classList.add(`in-${HOST.kind}`);
    else if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

    const finished = await sf.finishSignIn();
    if (typeof finished === 'string') S.flash = { kind: 'amber', text: finished };
    if (new URLSearchParams(window.location.search).has('shared')) {
        pendingShare = await takeSharedFiles();
        window.history.replaceState({}, '', sf.redirectUri());
    }
    if (sf.isSignedIn()) {
        try {
            await loadSession();
        } catch (e) {
            S.me = null;
            S.flash = { kind: 'amber', text: e instanceof sf.SignedOut ? 'Your Salesforce sign-in has ended. Connect again to carry on.' : e.message };
        }
    }
    proceedAfterWelcome();
}

start();
