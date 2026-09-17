import * as FileSystem from 'expo-file-system';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { base64ToArrayBuffer, base64ToUtf8 } from './base64';
import { parse3MF } from './parse3mf';

export const SUPPORTED_EXTENSIONS = ['stl', '3mf', 'glb', 'gltf', 'obj'];

// Target size (largest bounding-box dimension) that every imported model is
// scaled to, so a tiny screw and a large bracket both arrive at a usable size.
const NORMALIZED_SIZE = 2;

function extensionOf(name = '') {
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

// Read up to `max` bytes as a loose ASCII string for text-format sniffing.
function asciiPrefix(bytes, max = 512) {
  let s = '';
  const n = Math.min(bytes.length, max);
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Guess the model format from its raw bytes. Used when a file arrives via an
 * Android "open with" intent, where the content:// URI often carries no usable
 * filename/extension. Returns a SUPPORTED_EXTENSIONS value, or null if unknown.
 */
function sniffExtension(base64) {
  const bytes = new Uint8Array(base64ToArrayBuffer(base64));
  if (bytes.length < 4) return null;

  // 3MF is a ZIP archive ("PK\x03\x04").
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return '3mf';
  // Binary glTF magic "glTF".
  if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return 'glb';
  // JSON glTF starts with '{'.
  if (bytes[0] === 0x7b) return 'gltf';

  const head = asciiPrefix(bytes);
  // ASCII STL begins with the "solid" keyword.
  if (/^\s*solid\b/i.test(head)) return 'stl';
  // Binary STL: 80-byte header + uint32 triangle count, then 50 bytes/triangle.
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const triCount = view.getUint32(80, true);
    if (bytes.length === 84 + triCount * 50) return 'stl';
  }
  // OBJ is a text file of vertex/face directives.
  if (/^\s*(#|v\s|vn\s|vt\s|f\s|o\s|g\s|s\s|mtllib|usemtl)/m.test(head)) return 'obj';

  return null;
}

/**
 * Prepare an object's meshes for the scene.
 *
 * - GLB/glTF ('keep'): leave the loader's real materials/textures intact.
 * - STL/OBJ/3MF ('lit'): assign a lightweight MeshLambertMaterial (cheaper to
 *   shade than PBR — a real win on large meshes). Color priority is:
 *     1. per-vertex colors baked by the 3MF parser (vertexColors),
 *     2. a per-mesh `userData.baseColor` (e.g. a 3MF part's filament color),
 *     3. the app's per-model tint `color` (STL/OBJ, or colorless 3MF).
 */
function prepareMaterials(object, color, mode) {
  object.traverse((child) => {
    if (!child.isMesh) return;
    if (child.geometry && !child.geometry.attributes.normal) {
      child.geometry.computeVertexNormals();
    }
    if (mode === 'keep') return;

    const hasVertexColors = !!child.geometry?.attributes?.color;
    const base = child.userData.baseColor;
    child.material = new THREE.MeshLambertMaterial({
      color: hasVertexColors ? 0xffffff : base != null ? base : color,
      vertexColors: hasVertexColors,
      side: THREE.DoubleSide,
    });
  });
}

/**
 * Center an object at the origin and uniformly scale it to NORMALIZED_SIZE.
 * Returns the applied scale so callers can reason about real-world size later.
 */
function normalize(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return 1;

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = NORMALIZED_SIZE / maxDim;

  // Offset the model so its bounding-box center sits at the group origin, then
  // scale the wrapping group. The group becomes the object we move/rotate.
  const pivot = new THREE.Group();
  object.position.set(-center.x, -center.y, -center.z);
  pivot.add(object);
  pivot.scale.setScalar(scale);
  return { pivot, scale };
}

async function parseByExtension(ext, base64) {
  switch (ext) {
    case 'stl': {
      const geometry = new STLLoader().parse(base64ToArrayBuffer(base64));
      return new THREE.Mesh(geometry);
    }
    case 'obj': {
      return new OBJLoader().parse(base64ToUtf8(base64));
    }
    case 'glb':
    case 'gltf': {
      const buffer = base64ToArrayBuffer(base64);
      const gltf = await new Promise((resolve, reject) => {
        new GLTFLoader().parse(buffer, '', resolve, reject);
      });
      return gltf.scene;
    }
    case '3mf': {
      return parse3MF(base64ToArrayBuffer(base64));
    }
    default:
      throw new Error(`Unsupported file type: .${ext}`);
  }
}

/**
 * Load a picked document into a normalized, colored THREE.Object3D ready to be
 * dropped into the scene.
 *
 * @param {{ uri: string, name: string }} file  Result from DocumentPicker.
 * @param {number} color  Hex color used to tint the model.
 * @returns {Promise<{ object: THREE.Object3D, ext: string }>}
 */
export async function loadModel(file, color) {
  const base64 = await FileSystem.readAsStringAsync(file.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Prefer the filename's extension; when it's missing or unknown (common for
  // files opened through an Android "open with" content:// URI), sniff the
  // format from the raw bytes.
  let ext = extensionOf(file.name);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    ext = sniffExtension(base64);
  }
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported or unrecognized 3D file`);
  }

  const raw = await parseByExtension(ext, base64);
  // GLB/glTF keep their real materials; STL/OBJ/3MF get a lit material (with
  // 3MF colors applied by the parser when present).
  const mode = ext === 'glb' || ext === 'gltf' ? 'keep' : 'lit';
  prepareMaterials(raw, color, mode);

  const { pivot } = normalize(raw);
  pivot.name = file.name;
  return { object: pivot, ext };
}
