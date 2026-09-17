// Minimal, dependency-free base64 -> ArrayBuffer / string decoders.
//
// expo-file-system reads binary files as base64 strings; three.js loaders want
// an ArrayBuffer (STL/GLB/3MF) or a UTF-8 string (OBJ). We decode manually so we
// do not depend on `atob`/`Buffer` being present in every runtime.

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < CHARS.length; i++) {
    table[CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Decode a base64 string into an ArrayBuffer.
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
export function base64ToArrayBuffer(base64) {
  const len = base64.length;
  // base64 is always a multiple of 4 chars; count trailing '=' padding (61).
  let padding = 0;
  if (len >= 1 && base64.charCodeAt(len - 1) === 61) padding++;
  if (len >= 2 && base64.charCodeAt(len - 2) === 61) padding++;

  const byteLength = (len >> 2) * 3 - padding;
  const bytes = new Uint8Array(byteLength);
  const lookup = LOOKUP; // hoist to a local for the hot loop

  // Decode every full 4-char quad into 3 bytes. Packing the quad into a single
  // 24-bit integer and dropping the per-byte bounds checks (only the padded tail
  // needs them) roughly halves the work versus a naive char-at-a-time loop.
  const fullQuads = padding ? len - 4 : len;
  let p = 0;
  let i = 0;
  for (; i < fullQuads; i += 4) {
    const n =
      (lookup[base64.charCodeAt(i)] << 18) |
      (lookup[base64.charCodeAt(i + 1)] << 12) |
      (lookup[base64.charCodeAt(i + 2)] << 6) |
      lookup[base64.charCodeAt(i + 3)];
    bytes[p++] = (n >> 16) & 0xff;
    bytes[p++] = (n >> 8) & 0xff;
    bytes[p++] = n & 0xff;
  }

  // Final (possibly padded) quad.
  if (padding) {
    const n =
      (lookup[base64.charCodeAt(i)] << 18) |
      (lookup[base64.charCodeAt(i + 1)] << 12) |
      (lookup[base64.charCodeAt(i + 2)] << 6) |
      lookup[base64.charCodeAt(i + 3)];
    if (p < byteLength) bytes[p++] = (n >> 16) & 0xff;
    if (p < byteLength) bytes[p++] = (n >> 8) & 0xff;
    if (p < byteLength) bytes[p++] = n & 0xff;
  }

  return bytes.buffer;
}

/**
 * Decode bytes to a JS string treating each byte as a Latin-1 code unit, in
 * chunks via String.fromCharCode.
 *
 * This deliberately avoids TextDecoder: the app polyfills it with a pure-JS
 * implementation (`text-encoding`) that decodes byte-by-byte in JS, which is
 * catastrophically slow on large buffers (a ~150 MB 3MF XML took minutes). Our
 * parsers only ever match ASCII tags, attributes and numbers, and ASCII bytes
 * survive a Latin-1 decode unchanged, so geometry is byte-exact; only non-ASCII
 * text we never read (names/metadata) would differ.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToText(bytes) {
  const CHUNK = 0x8000; // stay well under the argument-count limit for apply()
  const len = bytes.length;
  if (len <= CHUNK) return String.fromCharCode.apply(null, bytes);
  let out = '';
  for (let i = 0; i < len; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/**
 * Decode a base64 string into a JS string (see bytesToText for the encoding
 * caveat — fine for the ASCII text formats we parse).
 * @param {string} base64
 * @returns {string}
 */
export function base64ToUtf8(base64) {
  return bytesToText(new Uint8Array(base64ToArrayBuffer(base64)));
}
