/*
 * CHAT TO SALESFORCE — save WhatsApp conversations to Salesforce as interactions.
 *
 * The journey, every screen one job:
 *   Connect   sign in with Salesforce (its own "Allow access?" screen), then allow WhatsApp chats
 *   Home      bring a chat in: paste copied messages, open an exported chat, or share from WhatsApp
 *   Pick      tap the messages to keep; earlier saves are marked and never offered twice
 *   Save      who (matched by phone, then name), practice, purpose, outcome → one interaction
 *
 * The chat is read in this browser only. What leaves it is what the rep saves, to Salesforce.
 */
import {
    parseChat, chatNameFromFile, looksLikePhone, transcriptLine, keysInDescription, fingerprint
} from './parser.js';
import { listZip, isZip } from './zip.js';
import { nameTokens, scoreCandidate, confidentPick, employeeTypeFor, guessMe } from './match.js';
import * as sf from './sf.js';

const root = document.getElementById('app');
const LOCALE = navigator.language || 'en-GB';
const CONSENT_KEY = 'c2s.consent';
const ME_NAMES_KEY = 'c2s.myWhatsAppNames';
const HOWTO_SEEN_KEY = 'c2s.howtoSeen';
const INSTALL_DISMISSED_KEY = 'c2s.installDismissed';
const PAGE = 400;
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
    shown: PAGE,
    person: null,
    practices: [],
    practice: null,
    practiceSearch: false,
    purpose: null,
    outcome: null,
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
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'
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
        ? `<button class="icon-btn" data-act="home" aria-label="Back to start">${icon('back')}</button>
           <div class="title"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`
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
              ${!signedIn ? '<p class="muted">Next, allow the chats you send from WhatsApp.</p>' : consent ? `<p class="ok-line">${icon('check')}WhatsApp chats allowed</p>` : `
                <div class="consent">
                  <p><b>Allow Chat to Salesforce to open the WhatsApp chats you send it?</b></p>
                  <ul>
                    <li>${icon('hand')}<span>You choose a chat in WhatsApp and send it here. Nothing else on your phone is read.</span></li>
                    <li>${icon('eye')}<span>You pick the messages to keep. Only those are saved to Salesforce, on the doctor you confirm.</span></li>
                    <li>${icon('shield')}<span>The chat is opened on this device only and is not stored anywhere else.</span></li>
                  </ul>
                  <label class="check"><input type="checkbox" id="consent-box"> I allow Chat to Salesforce to open the WhatsApp chats I send it</label>
                  <button class="btn primary big" data-act="consent" disabled>Allow WhatsApp chats</button>
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

function howtoHtml(which) {
    const steps = {
        iphone: [
            'In WhatsApp, open the chat and tap the <b>person’s name</b> at the top.',
            'Tap <b>Export Chat</b>, then <b>Attach Media</b> to bring photos, or <b>Without Media</b>.',
            'Tap <b>Save to Files</b>. Come back here and press <b>Open exported chat</b>.',
            'Only a few messages? <b>Select</b> them in WhatsApp, <b>Copy</b>, and press <b>Paste messages</b>.'
        ],
        android: [
            'In WhatsApp, open the chat, tap <b>⋮</b> › <b>More</b> › <b>Export chat</b>.',
            'Choose <b>Include media</b> to bring photos, or <b>Without media</b>.',
            'Pick <b>Chat to Salesforce</b> in the list. Not there? Add this app to your home screen, or save the file and press <b>Open exported chat</b>.',
            'Only a few messages? Select them in WhatsApp, tap <b>Copy</b>, and press <b>Paste messages</b>.'
        ],
        computer: [
            'Open WhatsApp on your computer (the app or web.whatsapp.com) and the chat.',
            'Drag across the messages you need so the times and names are included, and copy them (<b>Ctrl+C</b> or <b>⌘C</b>).',
            'Press <b>Paste messages</b>. An exported chat file can also be dropped on this page.'
        ]
    }[which];
    return `<ol>${steps.map((s) => `<li><span>${s}</span></li>`).join('')}</ol>`;
}

function renderHome() {
    S.view = 'home';
    const d = device();
    const seen = readLocal(HOWTO_SEEN_KEY);
    const flash = S.flash ? `<div class="notice ${S.flash.kind || 'amber'}">${icon('alert')}<span>${esc(S.flash.text)}</span></div>` : '';
    const install = S.installEvent && !isStandalone() && !readLocal(INSTALL_DISMISSED_KEY)
        ? `<section class="card notice green" aria-label="Add to home screen">
             ${icon('download')}<span class="spacer">Add Chat to Salesforce to your home screen so it shows when you share a chat from WhatsApp.</span>
             <span class="chips"><button class="btn primary" data-act="install">Add</button><button class="icon-btn" data-act="install-no" aria-label="Not now">${icon('close')}</button></span>
           </section>` : '';
    root.innerHTML = `
      ${topbar()}
      <main class="page">
        ${flash}
        ${install}
        <section class="card add-card" id="add-card">
          <p class="eyebrow">Save a WhatsApp chat</p>
          <h1>Which conversation?</h1>
          <p class="muted">Bring the messages in, tick the ones to keep, and save them on the doctor.</p>
          <div class="btn-row">
            <button class="btn primary big" data-act="paste-open">${icon('paste')}Paste messages</button>
            <button class="btn big" data-act="file">${icon('open')}Open exported chat</button>
          </div>
          <input type="file" id="file-input" class="sr-only" multiple accept=".txt,.zip,text/plain,application/zip,image/*,audio/*,video/*,application/pdf" tabindex="-1">
          ${S.pasteOpen ? `
            <div class="paste-box">
              <label for="paste-text" class="eyebrow">Paste the messages copied from WhatsApp</label>
              <textarea id="paste-text" rows="6" placeholder="[27/11/2026, 10:32] Sophie Martin: Bonjour…"></textarea>
              <div class="btn-row">
                ${navigator.clipboard && navigator.clipboard.readText ? `<button class="btn" data-act="clipboard">${icon('paste')}Paste from clipboard</button>` : ''}
                <button class="btn primary" data-act="paste-go">Continue</button>
              </div>
            </div>` : ''}
          ${d === 'computer' ? '<p class="faint drop-hint">or drop an exported chat (.txt or .zip) anywhere on this page</p>' : ''}
        </section>
        <section class="card">
          <details class="howto-wrap" ${seen ? '' : 'open'}>
            <summary class="eyebrow">How to get a chat out of WhatsApp</summary>
            <div class="howto-tabs" role="tablist">
              ${['iphone', 'android', 'computer'].map((k) => `<button role="tab" data-act="howto" data-k="${k}" aria-selected="${k === d}">${{ iphone: 'iPhone', android: 'Android', computer: 'Computer' }[k]}</button>`).join('')}
            </div>
            <div class="howto" id="howto">${howtoHtml(d)}</div>
          </details>
        </section>
        <section class="card">
          <p class="eyebrow">Saved recently</p>
          <div class="recent" id="recent">${recentHtml()}</div>
        </section>
      </main>`;
    if (!seen) writeLocal(HOWTO_SEEN_KEY, true);
    S.flash = null;
    if (S.pasteOpen) root.querySelector('#paste-text')?.focus();
    if (S.recent === null) loadRecent();
}

function recentHtml() {
    if (S.recent === null) return '<p class="faint"><span class="spinner"></span></p>';
    if (S.recent === 'error') return '<p class="empty">Could not load your recent saves.</p>';
    if (!S.recent.length) return '<p class="empty">Nothing yet. WhatsApp chats you save show here.</p>';
    return S.recent.map((t) => `
      <a href="${esc(sf.recordUrl(t.Id))}" target="_blank" rel="noopener">
        <b>${esc(t.Subject)}</b>
        <small>${esc([t.Who && t.Who.Name, t.What && t.What.Name].filter(Boolean).join(' · ') || '—')}</small>
        <time datetime="${esc(t.ActivityDate || '')}">${t.ActivityDate ? esc(fmtShort.format(dayDate(t.ActivityDate))) : ''}</time>
      </a>`).join('');
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

function openText(text, fileName, media = new Map(), { fromPaste = false } = {}) {
    const parsed = parseChat(text, { localeHint: LOCALE });
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
    const chatName = chatNameFromFile(fileName);
    const meName = plain ? null : guessMe(parsed.senders, {
        myName: S.me ? S.me.Name : '',
        chatName,
        remembered: parsed.senders.map((s) => s.name).find((n) => remembered.includes(n)) || ''
    });
    S.chat = { ...parsed, name: chatName, fileName, media, meName, plain, savedKeys: new Set(), savedInfo: new Map(), fromPaste };
    S.selection = new Set();
    if (fromPaste) parsed.messages.forEach((m) => { if (selectable(m)) S.selection.add(m.index); });
    S.shown = PAGE;
    S.step = 'pick';
    S.person = null;
    S.practices = [];
    S.practice = null;
    S.practiceSearch = false;
    S.purpose = null;
    S.outcome = null;
    S.subject = '';
    S.subjectTouched = false;
    S.note = '';
    S.error = null;
    S.saving = null;
    S.pasteOpen = false;
    S.view = 'chat';
    render();
    scrollToNewest();
    matchPerson();
}

/* A chat opens on its newest message, as WhatsApp does. */
function scrollToNewest() {
    const go = () => {
        const last = root.querySelector('#thread > :last-child');
        if (last) last.scrollIntoView({ block: 'end' });
    };
    requestAnimationFrame(() => requestAnimationFrame(go));
    setTimeout(go, 400);
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
    const phone = looksLikePhone(target) ? target : (others.find((o) => looksLikePhone(o.name)) || {}).name;
    const tokens = looksLikePhone(target) ? [] : nameTokens(target);
    if (!target || (!phone && !tokens.length)) { S.person = { status: 'none', query: target }; renderSavePane(); return; }
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
    } catch (e) {
        if (e instanceof sf.SignedOut) return;
    }
    renderSavePane();
    renderThread();
}

function choosePracticeOnly(account) {
    S.person = { status: 'chosen', query: S.person ? S.person.query : '', contact: null };
    S.practices = [account];
    S.practice = account;
    S.practiceSearch = false;
    if (!S.subjectTouched) S.subject = `WhatsApp with ${account.Name}`;
    renderSavePane();
}

function markEarlierSaves(rows) {
    const c = S.chat;
    c.savedKeys = new Set();
    c.savedInfo = new Map();
    for (const row of rows) {
        for (const k of keysInDescription(row.Description)) {
            if (!c.savedKeys.has(k)) {
                c.savedKeys.add(k);
                c.savedInfo.set(k, { by: row.Owner && row.Owner.Name, at: row.CreatedDate });
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

function renderChat() {
    const c = S.chat;
    const sel = c.messages.filter(selectable);
    const sub = sel.length ? `${plural(sel.length, 'message', 'messages')} · ${rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey)}` : '';
    root.innerHTML = `
      ${topbar({ back: true, title: c.name || (otherSenders()[0] || {}).name || 'WhatsApp chat', sub })}
      <div class="chat-layout" data-step="${S.step}">
        <section class="messages-pane" aria-label="Messages">
          <div class="toolbar" id="toolbar"></div>
          <div id="notices"></div>
          <div class="thread" id="thread" role="group" aria-label="Tap the messages to save"></div>
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
      <button class="chip" data-act="sel-all" ${pickable.length ? '' : 'disabled'}>All${pickable.length > 1 ? ` (${pickable.length.toLocaleString(LOCALE)})` : ''}</button>
      <button class="chip" data-act="sel-none" ${S.selection.size ? '' : 'disabled'}>None</button>
      <span class="spacer"></span>
      <span class="faint desktop-only">${S.selection.size ? `${plural(S.selection.size, 'message', 'messages')} ticked` : 'Tap the messages to save'}</span>`;
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
    const savedCount = c.messages.filter(isSaved).length;
    if (savedCount) parts.push(`<div class="notice green">${icon('check')}<span>${plural(savedCount, 'message is', 'messages are')} already in Salesforce and greyed out.</span></div>`);
    el.innerHTML = parts.join('');
}

function mediaHtml(m) {
    const kind = m.mediaKind;
    const have = m.attachment && S.chat.media.has(m.attachment);
    const label = { photo: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', document: 'Document', sticker: 'Sticker', contact: 'Contact card' }[kind] || 'Media';
    if (!have) {
        const why = m.attachment ? 'not in what was shared' : 'not in the export';
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
    const savedTitle = info && info.by ? `Saved to Salesforce by ${info.by}` : 'Already in Salesforce';
    return `<div class="msg ${me ? 'me' : ''} ${saved ? 'saved' : ''}" role="checkbox" aria-checked="${checked}" aria-disabled="${saved}" tabindex="${saved ? -1 : 0}" data-i="${m.index}">
      <span class="tick">${icon('check')}</span>
      <div class="bubble">
        ${me ? '' : `<div class="from">${esc(m.sender)}</div>`}
        ${m.kind === 'media' ? mediaHtml(m) : ''}
        ${m.text ? `<div class="text">${esc(m.text)}</div>` : ''}
        <div class="meta">${saved ? `<span class="saved-tag" title="${esc(savedTitle)}">${icon('check')}In Salesforce</span>` : ''}${m.edited ? '<span>edited</span>' : ''}<time>${esc(fmtTime.format(m.at))}</time></div>
      </div>
    </div>`;
}

function renderThread() {
    if (S.view !== 'chat') return;
    const c = S.chat;
    const el = root.querySelector('#thread');
    if (!el) return;
    const start = Math.max(0, c.messages.length - S.shown);
    const visible = c.messages.slice(start);
    let html = start > 0 ? `<button class="btn more-earlier" data-act="earlier">Show earlier messages (${start.toLocaleString(LOCALE)} more)</button>` : '';
    let day = null;
    for (const m of visible) {
        if (m.dayKey !== day) {
            day = m.dayKey;
            html += `<div class="day" data-day="${day}"><span>${esc(dayLabel(day))}</span><button data-act="day" data-day="${day}"></button></div>`;
        }
        html += messageHtml(m);
    }
    el.innerHTML = html;
    renderToolbar();
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
    root.querySelectorAll('.day button[data-day]').forEach((b) => {
        const msgs = c.messages.filter((m) => m.dayKey === b.dataset.day && canPick(m));
        const all = msgs.length && msgs.every((m) => S.selection.has(m.index));
        b.textContent = all ? 'Untick day' : 'Tick day';
        b.hidden = !msgs.length;
    });
    const sel = selectedMessages();
    const bar = root.querySelector('#pickbar');
    if (bar) {
        bar.innerHTML = `<div class="count">${sel.length ? plural(sel.length, 'message', 'messages') : 'Tap the messages to save'}
            ${sel.length ? `<small>${esc(rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey))}</small>` : ''}</div>
          <button class="btn primary" data-act="next" ${sel.length ? '' : 'disabled'}>Next</button>`;
    }
    renderToolbar();
    updateSaveState();
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

function chipsHtml(list, current, act) {
    return `<div class="choices" role="radiogroup">${list.map((o) => `<button class="chip ${current === o.value ? 'on' : ''}" role="radio" aria-checked="${current === o.value}" data-act="${act}" data-v="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div>`;
}

function renderSavePane() {
    if (S.view !== 'chat') return;
    const el = root.querySelector('#save-pane');
    if (!el) return;
    const choices = S.choices || { purposes: [], outcomes: [] };
    const sel = selectedMessages();
    const active = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
    const keep = active && active.id ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
    el.innerHTML = `
      <button class="btn link mobile-only" data-act="back-pick">${icon('back')}Back to the messages</button>
      <div>
        <p class="eyebrow">Save to Salesforce</p>
        <h2 id="save-summary">${sel.length ? `${plural(sel.length, 'message', 'messages')} · ${esc(rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey))}` : 'No messages ticked yet'}</h2>
      </div>
      <div class="field"><span class="label">Who</span>${whoHtml()}</div>
      <div class="field"><span class="label">Practice</span>${practiceHtml()}</div>
      <div class="field"><span class="label">Purpose</span>${chipsHtml(choices.purposes, S.purpose, 'purpose')}</div>
      <div class="field"><span class="label">Outcome</span>${chipsHtml(choices.outcomes, S.outcome, 'outcome')}</div>
      <div class="field"><label for="subject">Subject</label><input type="text" id="subject" maxlength="255" value="${esc(S.subject)}"></div>
      <div class="field"><label for="note">Note</label><textarea id="note" rows="3" placeholder="What was agreed? (optional)">${esc(S.note)}</textarea></div>
      <details class="preview"><summary>What Salesforce will keep</summary><pre id="preview"></pre></details>
      <div id="save-error">${S.error ? `<div class="error" role="alert">${icon('alert')}<span>${esc(S.error)}</span></div>` : ''}</div>
      <p class="hint" id="save-hint"></p>
      <button class="btn primary big block" data-act="save" id="save-btn">${S.saving ? `<span class="spinner"></span>${esc(S.saving)}` : 'Save to Salesforce'}</button>`;
    if (keep) {
        const again = el.querySelector(`#${keep.id}`);
        if (again) {
            if (/search/.test(keep.id)) again.value = keep.value;
            again.focus();
            try { again.setSelectionRange(keep.start, keep.end); } catch { /* not a text box */ }
        }
    }
    updateSaveState();
}

function missing() {
    const out = [];
    if (!S.selection.size) out.push('tick the messages to save');
    if (!S.person || S.person.status !== 'chosen' || S.person.searchOpen) out.push('choose who it was with');
    else if (!S.practice && !S.person.contact) out.push('choose the practice');
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
    const summary = root.querySelector('#save-summary');
    if (summary) summary.textContent = sel.length ? `${plural(sel.length, 'message', 'messages')} · ${rangeLabel(sel[0].dayKey, sel[sel.length - 1].dayKey)}` : 'No messages ticked yet';
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
        lines.push(transcriptLine({ ...m, uploaded: forPreview ? willUpload : m.uploaded }, senderLabel(m)));
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
    S.recent = null;
    S.lastSaved = {
        id, count: sel.length, contact, practice,
        files: uploadable.length - failed.filter((f) => f.why !== 'larger than 25 MB').length, failed
    };
    S.view = 'saved';
    render();
}

function renderSaved() {
    const s = S.lastSaved;
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
    const target = e.target.closest('[data-act], .msg[data-i]');
    if (!target) {
        if (S.menuOpen && !e.target.closest('.menu')) { S.menuOpen = false; render(); }
        return;
    }
    if (target.matches('.msg[data-i]') && !target.dataset.act) return toggleMessage(target, e.shiftKey);
    const act = target.dataset.act;
    switch (act) {
        case 'signin': sf.startSignIn(); break;
        case 'consent':
            writeLocal(CONSENT_KEY, { at: new Date().toISOString(), version: 1 });
            proceedAfterWelcome();
            break;
        case 'menu': S.menuOpen = !S.menuOpen; render(); break;
        case 'signout':
            S.menuOpen = false;
            sf.signOut();
            S.me = null; S.chat = null; S.recent = null; S.view = 'welcome';
            render();
            break;
        case 'withdraw':
            S.menuOpen = false;
            writeLocal(CONSENT_KEY, null);
            S.chat = null; S.view = 'welcome';
            S.flash = { kind: 'green', text: 'WhatsApp access stopped. Nothing from your chats is kept here.' };
            render();
            break;
        case 'home':
            S.view = 'home'; S.chat = null; S.menuOpen = false;
            render();
            break;
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
        case 'howto':
            root.querySelectorAll('[data-act="howto"]').forEach((b) => b.setAttribute('aria-selected', String(b === target)));
            root.querySelector('#howto').innerHTML = howtoHtml(target.dataset.k);
            break;
        case 'earlier': S.shown += PAGE; renderThread(); break;
        case 'day': {
            const msgs = S.chat.messages.filter((m) => m.dayKey === target.dataset.day && canPick(m));
            const all = msgs.every((m) => S.selection.has(m.index));
            msgs.forEach((m) => (all ? S.selection.delete(m.index) : S.selection.add(m.index)));
            refreshSelection();
            break;
        }
        case 'sel-all':
            S.chat.messages.filter(canPick).forEach((m) => S.selection.add(m.index));
            refreshSelection();
            break;
        case 'sel-none': S.selection.clear(); refreshSelection(); break;
        case 'sel-new': {
            const lastSaved = [...S.chat.messages].reverse().find(isSaved);
            S.chat.messages.filter((m) => canPick(m) && m.index > lastSaved.index).forEach((m) => S.selection.add(m.index));
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
            root.querySelector('.chat-layout').dataset.step = 'save';
            window.scrollTo(0, 0);
            break;
        case 'back-pick':
            S.step = 'pick';
            root.querySelector('.chat-layout').dataset.step = 'pick';
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
        case 'purpose': S.purpose = target.dataset.v; renderSavePane(); break;
        case 'outcome': S.outcome = target.dataset.v; renderSavePane(); break;
        case 'save': save(); break;
        case 'more':
            S.view = 'chat'; S.step = 'pick';
            render();
            scrollToNewest();
            break;
        default: break;
    }
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
    refreshSelection();
}

function onKey(e) {
    if (e.key === 'Escape' && S.menuOpen) { S.menuOpen = false; render(); return; }
    const node = e.target.closest && e.target.closest('.msg[data-i]');
    if (node && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); toggleMessage(node, e.shiftKey); }
    if (e.target.id === 'paste-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        openText(e.target.value, '', new Map(), { fromPaste: true });
    }
}

function onInput(e) {
    const t = e.target;
    if (t.id === 'subject') { S.subject = t.value; S.subjectTouched = true; }
    else if (t.id === 'note') { S.note = t.value; updateSaveState(); }
    else if (t.id === 'who-search' || t.id === 'practice-search') {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(t), 300);
    }
}

function onChange(e) {
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
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

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
