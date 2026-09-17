import * as THREE from 'three';

import { bytesToText } from './base64';

// A small, dependency-free STL parser used instead of three.js' STLLoader.
//
// three's STLLoader parses ASCII STL with backtracking regexes (`[\s\S]*?`),
// which are catastrophically slow on React Native's Hermes engine — a ~1.5 MB
// ASCII STL took ~50 s. This parser scans ASCII linearly (no regex) and reads
// binary STL straight from a DataView, so both paths are effectively instant.

const isWhitespace = (code) =>
  code === 32 /* space */ ||
  code === 10 /* \n */ ||
  code === 13 /* \r */ ||
  code === 9 /* \t */;

/**
 * Binary STL is an 80-byte header + a uint32 triangle count + 50 bytes per
 * triangle. If that exact size relationship holds, it's binary; otherwise ASCII
 * (a real ASCII file matching the formula by coincidence is astronomically
 * unlikely).
 */
function isBinary(buffer) {
  if (buffer.byteLength < 84) return false;
  const faces = new DataView(buffer).getUint32(80, true);
  return 84 + faces * 50 === buffer.byteLength;
}

function parseBinary(buffer) {
  const view = new DataView(buffer);
  const faces = view.getUint32(80, true);
  const positions = new Float32Array(faces * 9);
  const normals = new Float32Array(faces * 9);

  let offset = 84;
  let p = 0;
  for (let f = 0; f < faces; f++) {
    const nx = view.getFloat32(offset, true);
    const ny = view.getFloat32(offset + 4, true);
    const nz = view.getFloat32(offset + 8, true);
    offset += 12;
    for (let v = 0; v < 3; v++) {
      positions[p] = view.getFloat32(offset, true);
      positions[p + 1] = view.getFloat32(offset + 4, true);
      positions[p + 2] = view.getFloat32(offset + 8, true);
      normals[p] = nx;
      normals[p + 1] = ny;
      normals[p + 2] = nz;
      p += 3;
      offset += 12;
    }
    offset += 2; // per-face attribute byte count, unused
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geometry;
}

function parseAscii(buffer) {
  const text = bytesToText(new Uint8Array(buffer));
  const len = text.length;
  const positions = [];
  const normals = [];
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let i = 0;

  // Single linear pass over whitespace-delimited tokens.
  const nextToken = () => {
    while (i < len && isWhitespace(text.charCodeAt(i))) i++;
    if (i >= len) return null;
    const start = i;
    while (i < len && !isWhitespace(text.charCodeAt(i))) i++;
    return text.slice(start, i);
  };

  let token;
  while ((token = nextToken()) !== null) {
    if (token === 'facet') {
      nextToken(); // 'normal'
      nx = parseFloat(nextToken());
      ny = parseFloat(nextToken());
      nz = parseFloat(nextToken());
    } else if (token === 'vertex') {
      positions.push(
        parseFloat(nextToken()),
        parseFloat(nextToken()),
        parseFloat(nextToken())
      );
      // STL is flat-shaded: every vertex of a facet shares the facet normal.
      normals.push(nx, ny, nz);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

/**
 * Parse an STL (binary or ASCII) ArrayBuffer into a BufferGeometry with position
 * and (flat) normal attributes.
 */
export function parseSTL(buffer) {
  return isBinary(buffer) ? parseBinary(buffer) : parseAscii(buffer);
}
