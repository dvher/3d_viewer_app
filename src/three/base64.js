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
  let len = base64.length;
  // Ignore trailing padding when computing the output length.
  let padding = 0;
  if (len > 0 && base64[len - 1] === '=') padding++;
  if (len > 1 && base64[len - 2] === '=') padding++;

  const byteLength = (len * 3) / 4 - padding;
  const bytes = new Uint8Array(byteLength);

  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const e1 = LOOKUP[base64.charCodeAt(i)];
    const e2 = LOOKUP[base64.charCodeAt(i + 1)];
    const e3 = LOOKUP[base64.charCodeAt(i + 2)];
    const e4 = LOOKUP[base64.charCodeAt(i + 3)];

    if (p < byteLength) bytes[p++] = (e1 << 2) | (e2 >> 4);
    if (p < byteLength) bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (p < byteLength) bytes[p++] = ((e3 & 3) << 6) | (e4 & 63);
  }

  return bytes.buffer;
}

/**
 * Decode a base64 string into a UTF-8 JS string.
 * @param {string} base64
 * @returns {string}
 */
export function base64ToUtf8(base64) {
  const buffer = base64ToArrayBuffer(base64);
  return new TextDecoder('utf-8').decode(new Uint8Array(buffer));
}
