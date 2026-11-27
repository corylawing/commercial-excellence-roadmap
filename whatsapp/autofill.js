/*
 * FILLED IN FOR YOU: what the app already knows, so most saves are one tap. Every choice made here
 * carries the sentence the screen shows under it ("Same as your last chat with Lisa"), and the rep
 * can change any of them. Pure functions: no screen, no network.
 *
 * Interaction (Cory, 2026-11-27: "automatically choose options when we know"):
 *   purpose and outcome = the rep's own last WhatsApp interaction with this person; otherwise from the
 *   practice: a customer → Support/Account Growth + Successful Account Maintenance (the commonest pair
 *   on WhatsApp interactions, about 550 of them in the 6 months to 27 Nov 2026), not a customer yet →
 *   New Business (outcome left to the rep); and when only the rep's own messages are ticked, the
 *   outcome is No Response.
 * Case: Source = Customer for a customer practice, Prospect otherwise; the subject is the first words
 *   of the first ticked message the other person wrote.
 */
import { nameTokens } from './match.js';

export const CUSTOMER_PURPOSE = 'Support/Account Growth';
export const CUSTOMER_OUTCOME = 'Successful Account Maintenance Call/Meeting';
export const PROSPECT_PURPOSE = 'New Business';
export const NO_RESPONSE = 'No Response';

function firstName(name) {
    const t = nameTokens(name);
    return t[0] || String(name || '').trim().split(/\s+/)[0] || 'them';
}

/**
 * @param {object} p
 * @param {Array} p.earlier     earlier saves on this person (sf.earlierSaves), newest first
 * @param {string} p.meId       the rep's user id
 * @param {object} p.practice   the practice chosen (needs Name, Customer_Active__c)
 * @param {string} p.personName the person chosen
 * @param {{purposes:Array, outcomes:Array}} p.choices  the picklists offered
 * @param {boolean} p.onlyMine  every ticked message is the rep's own
 * @returns {{purpose:string|null, outcome:string|null, why:{purpose?:string, outcome?:string}}}
 */
export function suggestInteraction({ earlier = [], meId = null, practice = null, personName = '', choices = {}, onlyMine = false }) {
    const offered = (list, v) => !!v && (list || []).some((o) => o.value === v);
    const purposes = choices.purposes || [];
    const outcomes = choices.outcomes || [];
    let purpose = null, outcome = null;
    const why = {};
    const mine = earlier.find((r) => !r.isCase && meId && r.OwnerId && String(r.OwnerId).slice(0, 15) === String(meId).slice(0, 15) &&
        offered(purposes, r.Purpose_LogACall__c));
    if (mine) {
        const words = `Same as your last chat with ${firstName(personName)}`;
        purpose = mine.Purpose_LogACall__c; why.purpose = words;
        if (offered(outcomes, mine.Interaction_Outcome__c)) { outcome = mine.Interaction_Outcome__c; why.outcome = words; }
    } else if (practice && practice.Name) {
        if (practice.Customer_Active__c) {
            if (offered(purposes, CUSTOMER_PURPOSE)) { purpose = CUSTOMER_PURPOSE; why.purpose = `${practice.Name} is a customer`; }
            if (offered(outcomes, CUSTOMER_OUTCOME)) { outcome = CUSTOMER_OUTCOME; why.outcome = `${practice.Name} is a customer`; }
        } else if (offered(purposes, PROSPECT_PURPOSE)) {
            purpose = PROSPECT_PURPOSE; why.purpose = `${practice.Name} is not a customer yet`;
        }
    }
    if (onlyMine && offered(outcomes, NO_RESPONSE)) { outcome = NO_RESPONSE; why.outcome = 'Only your own messages are ticked'; }
    return { purpose, outcome, why };
}

/** Source__c for a case: who raised it, read from the practice. */
export function caseSource(practice) {
    if (!practice) return { source: null, why: null };
    return practice.Customer_Active__c
        ? { source: 'Customer', why: `${practice.Name} is a customer` }
        : { source: 'Prospect', why: `${practice.Name} is not a customer yet` };
}

/** "WhatsApp: ScanBox pro units for the new surgery" from the first ticked message the other person wrote. */
export function caseSubject(messages, meName, fallbackName) {
    const theirs = (messages || []).find((m) => m.sender !== meName && m.kind === 'text' && String(m.text || '').trim());
    if (!theirs) return { subject: `WhatsApp with ${fallbackName || 'a customer'}`, why: null };
    let words = String(theirs.text).replace(/\s+/g, ' ').trim()
        .replace(/^(hi|hello|hey|bonjour|hola|hallo|ciao|olá|ola|dear)\b[^,.!?]{0,25}[,.!?]+\s*/i, '');
    if (!words) words = String(theirs.text).replace(/\s+/g, ' ').trim();
    if (words.length > 70) words = words.slice(0, 70).replace(/\s+\S*$/, '') + '…';
    return { subject: `WhatsApp: ${words}`, why: `From ${firstName(theirs.sender)}'s first message` };
}
