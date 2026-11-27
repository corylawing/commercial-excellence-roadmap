/*
 * OPENS THE .ZIP AN IPHONE EXPORT MAKES ("WhatsApp Chat - Name.zip": _chat.txt + photos, voice
 * messages, documents), in the browser, with no library: the zip's own table of contents, and the
 * browser's built-in DecompressionStream for the squeezed files. Files are unpacked only when
 * asked for, so a chat with 400 photos opens as fast as one without.
 */

const SIG_END = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_END64_LOCATOR = 0x07064b50;

export class ZipError extends Error {}

async function readBytes(blob, start, length) {
    return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 0x100000000; }

const utf8 = new TextDecoder('utf-8');

/**
 * @param {Blob} blob the .zip
 * @returns {Promise<Array<{name:string,size:number,read:()=>Promise<Blob>}>>}
 */
export async function listZip(blob) {
    const tailLength = Math.min(blob.size, 65557);
    const tail = await readBytes(blob, blob.size - tailLength, tailLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (u32(tail, i) === SIG_END) { end = i; break; }
    }
    if (end < 0) throw new ZipError('This file is not a WhatsApp export (it is not a zip).');
    let count = u16(tail, end + 10);
    let cdSize = u32(tail, end + 12);
    let cdOffset = u32(tail, end + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
        const loc = end - 20;
        if (loc >= 0 && u32(tail, loc) === SIG_END64_LOCATOR) {
            const end64At = u64(tail, loc + 8);
            const end64 = await readBytes(blob, end64At, 56);
            count = u64(end64, 32);
            cdSize = u64(end64, 40);
            cdOffset = u64(end64, 48);
        }
    }
    const cd = await readBytes(blob, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
        if (u32(cd, p) !== SIG_CENTRAL) throw new ZipError('This zip is damaged. Export the chat again.');
        const flags = u16(cd, p + 8);
        const method = u16(cd, p + 10);
        let compressed = u32(cd, p + 20);
        let size = u32(cd, p + 24);
        const nameLen = u16(cd, p + 28);
        const extraLen = u16(cd, p + 30);
        const commentLen = u16(cd, p + 32);
        let localAt = u32(cd, p + 42);
        const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
        // zip64: the real sizes sit in the extra field when the 32-bit ones are full
        let e = p + 46 + nameLen;
        const eEnd = e + extraLen;
        while (e + 4 <= eEnd) {
            const id = u16(cd, e), len = u16(cd, e + 2);
            if (id === 0x0001) {
                let q = e + 4;
                if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
                if (compressed === 0xffffffff) { compressed = u64(cd, q); q += 8; }
                if (localAt === 0xffffffff) { localAt = u64(cd, q); }
            }
            e += 4 + len;
        }
        p = eEnd + commentLen;
        if (name.endsWith('/')) continue;                       // a folder
        if ((flags & 1) === 1) throw new ZipError('This zip is password protected.');
        entries.push({
            name,
            baseName: name.split('/').pop(),
            size,
            read: async () => {
                const local = await readBytes(blob, localAt, 30);
                if (u32(local, 0) !== SIG_LOCAL) throw new ZipError('This zip is damaged. Export the chat again.');
                const start = localAt + 30 + u16(local, 26) + u16(local, 28);
                const raw = blob.slice(start, start + compressed);
                if (method === 0) return raw;
                if (method !== 8) throw new ZipError(`Cannot open ${name} (packed in an unusual way).`);
                if (typeof DecompressionStream === 'undefined') {
                    throw new ZipError('This browser is too old to open the export. Update it, or export the chat "Without media".');
                }
                const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
                return new Response(stream).blob();
            }
        });
    }
    return entries;
}

export function isZip(file) {
    return /\.zip$/i.test(file.name || '') || /zip/i.test(file.type || '');
}
