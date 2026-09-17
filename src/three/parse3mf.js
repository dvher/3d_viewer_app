import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';

import { BAMBU_PALETTE } from './bambuColors.js';
import { bytesToText } from './base64';

// A small, fast, self-contained 3MF parser.
//
// Why not three's ThreeMFLoader: it relies on `document.querySelector`, which our
// React Native DOMParser polyfill does not implement. Why no DOM parse at all: a
// printable mesh has hundreds of thousands of <vertex>/<triangle> elements;
// building a DOM creates one JS object per node, which is very slow and blows
// Hermes's per-object property limit ("Property storage exceeds 196607
// properties"). So we scan the model XML text directly with regex.
//
// Covers: the core geometry model; the production extension (root 3dmodel.model
// referencing meshes in separate .model parts via `p:path`); and COLORS from
//   - standard 3MF <basematerials>/<colorgroup> via object/triangle pid+pindex,
//   - Bambu per-object filament assignment (Metadata/*.config -> filament_colour),
//   - Bambu per-triangle `paint_color` painting (best-effort: regions are exact,
//     the code->filament hue mapping is approximate, as the encoding is
//     proprietary).

function normPath(p) {
  return String(p || '').replace(/^\/+/, '').toLowerCase();
}

function attrOf(attrs, name) {
  const m = attrs.match(new RegExp('\\b' + name.replace(':', '\\:') + '="([^"]*)"'));
  return m ? m[1] : null;
}

function pathOf(attrs) {
  return attrOf(attrs, 'p:path') || attrOf(attrs, 'path');
}

// '#RRGGBB' / '#RRGGBBAA' -> 0xRRGGBB integer (alpha ignored). null if invalid.
function hexToInt(hex) {
  if (!hex) return null;
  const m = String(hex).match(/^#?([0-9a-fA-F]{6})/);
  return m ? parseInt(m[1], 16) : null;
}

function parseMatrix(str) {
  const m = new THREE.Matrix4();
  if (!str) return m;
  const v = str.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((n) => Number.isNaN(n))) return m;
  m.set(
    v[0], v[3], v[6], v[9],
    v[1], v[4], v[7], v[10],
    v[2], v[5], v[8], v[11],
    0, 0, 0, 1
  );
  return m;
}

const OBJECT_OPEN_RE = /<object\b([^>]*)>/g;
const COMPONENT_RE = /<component\b([^>]*?)\/?>/g;
const ITEM_RE = /<item\b([^>]*?)\/?>/g;

// Regex-free scanning for the per-vertex/per-triangle hot loops. A printable
// mesh has hundreds of thousands of these elements; Hermes' backtracking regex
// engine parses them agonizingly slowly (a 22 MB colored 3MF took ~166 s),
// whereas native String.indexOf is orders of magnitude faster.

// Find the next occurrence of `tag` (e.g. '<vertex') whose following character
// is a tag delimiter — so '<triangle' won't match inside '<triangles>'.
function findTag(text, tag, from, end) {
  let i = text.indexOf(tag, from);
  while (i !== -1 && i < end) {
    const after = text.charCodeAt(i + tag.length);
    // space, tab, \n, \r, '/', '>'
    if (after === 32 || after === 9 || after === 10 || after === 13 || after === 47 || after === 62) {
      return i;
    }
    i = text.indexOf(tag, i + tag.length);
  }
  return -1;
}

// Read the quoted value of attribute `key` (e.g. ' x="') from a single tag's
// text. `tag` must be just the one element (sliced from the document) — never
// the whole document: String.indexOf has no end bound, so searching a 17 MB
// string for an attribute that's absent scans to EOF, which turns the per-
// element loops into O(n²) and hangs on large meshes.
function attrIn(tag, key) {
  const i = tag.indexOf(key);
  if (i === -1) return null;
  const s = i + key.length;
  const e = tag.indexOf('"', s);
  return e === -1 ? null : tag.slice(s, e);
}

// Count occurrences of `tag` in text[start,end). Used to size typed arrays up
// front so geometry is filled directly into them — no giant intermediate JS
// arrays (which balloon memory and GC time on million-triangle meshes).
function countTag(text, tag, start, end) {
  let n = 0;
  for (let i = findTag(text, tag, start, end); i !== -1; i = findTag(text, tag, i + tag.length, end)) {
    n++;
  }
  return n;
}

function regionHasColor(text, start, end) {
  const has = (needle) => {
    const i = text.indexOf(needle, start);
    return i !== -1 && i < end;
  };
  return has('paint_color') || has(' pid=') || has(' p1=');
}

function writeColor(colors, vi, int) {
  colors[vi * 3] = ((int >> 16) & 255) / 255;
  colors[vi * 3 + 1] = ((int >> 8) & 255) / 255;
  colors[vi * 3 + 2] = (int & 255) / 255;
}

// Best-effort decode of a Bambu/Orca `paint_color` code to a filament color.
// The first hex digit is treated as the (1-based) filament index; sub-triangle
// split data in the rest of the code is ignored (whole triangle takes the color).
function paintColorInt(code, palette, cache) {
  if (cache.has(code)) return cache.get(code);
  let int = null;
  if (palette && palette.length) {
    const e = parseInt(code[0], 16);
    if (!Number.isNaN(e)) {
      const idx = e > 0 ? (e - 1) % palette.length : 0;
      int = palette[idx];
    }
  }
  cache.set(code, int);
  return int;
}

/**
 * Build a plain (uncolored) BufferGeometry from text[start,end).
 */
function buildGeometryPlain(text, start, end) {
  const vCount = countTag(text, '<vertex', start, end);
  const tCount = countTag(text, '<triangle', start, end);
  if (!vCount || !tCount) return null;

  const positions = new Float32Array(vCount * 3);
  let p = 0;
  for (let vi = findTag(text, '<vertex', start, end); vi !== -1; ) {
    const tagEnd = text.indexOf('>', vi);
    const tag = text.slice(vi, tagEnd);
    positions[p++] = +attrIn(tag, ' x="');
    positions[p++] = +attrIn(tag, ' y="');
    positions[p++] = +attrIn(tag, ' z="');
    vi = findTag(text, '<vertex', tagEnd + 1, end);
  }

  const index = new Uint32Array(tCount * 3);
  let q = 0;
  for (let ti = findTag(text, '<triangle', start, end); ti !== -1; ) {
    const tagEnd = text.indexOf('>', ti);
    const tag = text.slice(ti, tagEnd);
    index[q++] = +attrIn(tag, ' v1="');
    index[q++] = +attrIn(tag, ' v2="');
    index[q++] = +attrIn(tag, ' v3="');
    ti = findTag(text, '<triangle', tagEnd + 1, end);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build a BufferGeometry with a per-vertex `color` attribute using 3MF material
 * references and/or Bambu paint_color. Vertex colors use last-writer-wins at
 * region boundaries (keeps the geometry indexed — no vertex explosion).
 */
function buildGeometryColored(text, start, end, ctx) {
  const vCount = countTag(text, '<vertex', start, end);
  const tCount = countTag(text, '<triangle', start, end);
  if (!vCount || !tCount) return null;

  const positions = new Float32Array(vCount * 3);
  let p = 0;
  for (let vi = findTag(text, '<vertex', start, end); vi !== -1; ) {
    const tagEnd = text.indexOf('>', vi);
    const tag = text.slice(vi, tagEnd);
    positions[p++] = +attrIn(tag, ' x="');
    positions[p++] = +attrIn(tag, ' y="');
    positions[p++] = +attrIn(tag, ' z="');
    vi = findTag(text, '<vertex', tagEnd + 1, end);
  }

  const { groups, palette, objectPid, objectPindex, defaultFill } = ctx;

  // Unpainted vertices fall back to the object's filament color, else the first
  // filament, else white — so painted models don't show bare white patches.
  const fill =
    defaultFill != null ? defaultFill : palette && palette[0] != null ? palette[0] : 0xffffff;
  const fr = ((fill >> 16) & 255) / 255;
  const fg = ((fill >> 8) & 255) / 255;
  const fb = (fill & 255) / 255;

  const colors = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i++) {
    colors[i * 3] = fr;
    colors[i * 3 + 1] = fg;
    colors[i * 3 + 2] = fb;
  }
  const index = new Uint32Array(tCount * 3);
  let q = 0;
  const paintCache = new Map();
  const objDefault =
    objectPid != null && objectPindex != null && groups.get(objectPid)
      ? groups.get(objectPid)[+objectPindex]
      : null;

  for (let ti = findTag(text, '<triangle', start, end); ti !== -1; ) {
    const tagEnd = text.indexOf('>', ti);
    const tag = text.slice(ti, tagEnd);
    const a = +attrIn(tag, ' v1="');
    const b = +attrIn(tag, ' v2="');
    const c = +attrIn(tag, ' v3="');
    index[q++] = a;
    index[q++] = b;
    index[q++] = c;

    let c1 = null;
    let c2 = null;
    let c3 = null;

    const paint = attrIn(tag, 'paint_color="');
    if (paint !== null) {
      const col = paintColorInt(paint, palette, paintCache);
      c1 = c2 = c3 = col;
    } else {
      const p1 = attrIn(tag, ' p1="');
      if (p1 !== null) {
        const pid = attrIn(tag, ' pid="');
        const grp = groups.get(pid !== null ? pid : objectPid);
        if (grp) {
          const p2 = attrIn(tag, ' p2="');
          const p3 = attrIn(tag, ' p3="');
          c1 = grp[+p1];
          c2 = grp[+(p2 !== null ? p2 : p1)];
          c3 = grp[+(p3 !== null ? p3 : p1)];
        }
      }
    }

    if (c1 == null && objDefault != null) c1 = c2 = c3 = objDefault;

    if (c1 != null) writeColor(colors, a, c1);
    if (c2 != null) writeColor(colors, b, c2);
    if (c3 != null) writeColor(colors, c, c3);

    ti = findTag(text, '<triangle', tagEnd + 1, end);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  return geometry;
}

class Archive {
  constructor(files, palette) {
    this.texts = {};
    for (const name of Object.keys(files)) {
      const key = normPath(name);
      // bytesToText (not fflate's strFromU8) — the latter routes through the slow
      // pure-JS TextDecoder polyfill, which dominates parse time on large models.
      if (key.endsWith('.model')) this.texts[key] = bytesToText(files[name]);
    }
    this.palette = palette;
    this.parsed = new Map(); // partKey -> Map<id, { geometry, components }>
    this.groups = new Map(); // partKey -> Map<pid, [int,...]>
  }

  groupsIn(partKey, text) {
    if (this.groups.has(partKey)) return this.groups.get(partKey);
    const map = new Map();
    this.groups.set(partKey, map);

    // <basematerials id="N"> ... <base displaycolor="#..."/> ...
    const bmRe = /<basematerials\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/basematerials>/g;
    let bm;
    while ((bm = bmRe.exec(text))) {
      const cols = [];
      const baseRe = /<base\b[^>]*\bdisplaycolor="([^"]*)"/g;
      let b;
      while ((b = baseRe.exec(bm[2]))) cols.push(hexToInt(b[1]));
      map.set(bm[1], cols);
    }
    // (m:)colorgroup id="N" ... (m:)color color="#..."
    const cgRe = /<(?:\w+:)?colorgroup\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g;
    let cg;
    while ((cg = cgRe.exec(text))) {
      const cols = [];
      const colRe = /<(?:\w+:)?color\b[^>]*\bcolor="([^"]*)"/g;
      let c;
      while ((c = colRe.exec(cg[2]))) cols.push(hexToInt(c[1]));
      map.set(cg[1], cols);
    }
    return map;
  }

  objectsIn(partKey, defaultFill) {
    if (this.parsed.has(partKey)) return this.parsed.get(partKey);
    const map = new Map();
    this.parsed.set(partKey, map);

    const text = this.texts[partKey];
    if (!text) return map;

    const groups = this.groupsIn(partKey, text);

    OBJECT_OPEN_RE.lastIndex = 0;
    const opens = [];
    let om;
    while ((om = OBJECT_OPEN_RE.exec(text))) {
      opens.push({ attrs: om[1], tagEnd: OBJECT_OPEN_RE.lastIndex });
    }

    for (const o of opens) {
      const id = attrOf(o.attrs, 'id');
      if (!id) continue;
      if (o.attrs.trim().endsWith('/')) {
        map.set(id, { geometry: null, components: [] });
        continue;
      }
      const close = text.indexOf('</object>', o.tagEnd);
      const end = close === -1 ? text.length : close;

      const colored = groups.size > 0 || regionHasColor(text, o.tagEnd, end);
      const geometry = colored
        ? buildGeometryColored(text, o.tagEnd, end, {
            groups,
            palette: this.palette,
            objectPid: attrOf(o.attrs, 'pid'),
            objectPindex: attrOf(o.attrs, 'pindex'),
            defaultFill,
          })
        : buildGeometryPlain(text, o.tagEnd, end);

      const components = [];
      COMPONENT_RE.lastIndex = o.tagEnd;
      let cm;
      while ((cm = COMPONENT_RE.exec(text)) && cm.index < end) {
        const path = pathOf(cm[1]);
        components.push({
          partKey: path ? normPath(path) : partKey,
          objectid: attrOf(cm[1], 'objectid'),
          matrix: parseMatrix(attrOf(cm[1], 'transform')),
        });
      }
      map.set(id, { geometry, components });
    }
    return map;
  }

  instantiate(partKey, id, seen, baseColor) {
    if (!id) return null;
    const record = this.objectsIn(partKey, baseColor).get(id);
    if (!record) return null;

    const key = `${partKey}|${id}`;
    if (seen.has(key)) return null;
    seen.add(key);

    const group = new THREE.Group();
    if (record.geometry) {
      const mesh = new THREE.Mesh(record.geometry);
      // Uniform fallback color for meshes without intrinsic vertex colors
      // (e.g. a part assigned to a single filament). Applied as a material color
      // later; -1 means "use the app's per-model tint".
      if (baseColor != null && !record.geometry.attributes.color) {
        mesh.userData.baseColor = baseColor;
      }
      group.add(mesh);
    }
    for (const comp of record.components) {
      const child = this.instantiate(comp.partKey, comp.objectid, seen, baseColor);
      if (child) {
        child.applyMatrix4(comp.matrix);
        group.add(child);
      }
    }

    seen.delete(key);
    return group.children.length ? group : null;
  }
}

// Pull the filament palette and per-object filament assignment out of Bambu's
// Metadata configs, if present. Returns { palette:[int], objColor:Map<id,int> }.
function parseBambuColors(files) {
  const result = { palette: null, objColor: new Map() };
  const find = (suffix) =>
    Object.keys(files).find((n) => n.toLowerCase().endsWith(suffix));

  const projName = find('project_settings.config');
  if (projName) {
    try {
      const json = JSON.parse(strFromU8(files[projName]));
      const arr = json.filament_colour || json.filament_colours;
      if (Array.isArray(arr)) result.palette = arr.map((h) => hexToInt(h));
    } catch (e) {
      // ignore malformed config
    }
  }

  // Fall back to the bundled real Bambu Lab palette when the file ships no
  // filament colors of its own, so Bambu paint references still get real colors.
  if (!result.palette) result.palette = BAMBU_PALETTE;

  const msName = find('model_settings.config');
  if (msName && result.palette) {
    const text = strFromU8(files[msName]);
    // Split into <object id="N"> ... blocks and read each object's extruder.
    const objRe = /<object\b[^>]*\bid="([^"]*)"[^>]*>/g;
    const starts = [];
    let om;
    while ((om = objRe.exec(text))) starts.push({ id: om[1], at: objRe.lastIndex });
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i].at;
      const to = i + 1 < starts.length ? starts[i + 1].at : text.length;
      const ex = text.slice(from, to).match(/key="extruder"\s+value="([0-9]+)"/);
      if (ex) {
        const idx = (parseInt(ex[1], 10) - 1) % result.palette.length;
        const col = result.palette[idx >= 0 ? idx : 0];
        if (col != null) result.objColor.set(starts[i].id, col);
      }
    }
  }
  return result;
}

/**
 * Parse a 3MF ArrayBuffer into a THREE.Group ready for the scene. Meshes may
 * carry a per-vertex `color` attribute or a `userData.baseColor` (uniform fill).
 * @param {ArrayBuffer} arrayBuffer
 * @returns {THREE.Group}
 */
export function parse3MF(arrayBuffer) {
  // Decompress model parts and the two Bambu config files (for colors); skip
  // thumbnails/textures entirely.
  const files = unzipSync(new Uint8Array(arrayBuffer), {
    filter: (f) => {
      const n = f.name.toLowerCase();
      return (
        n.endsWith('.model') ||
        n.endsWith('project_settings.config') ||
        n.endsWith('model_settings.config')
      );
    },
  });

  const { palette, objColor } = parseBambuColors(files);
  const archive = new Archive(files, palette);

  const modelParts = Object.keys(archive.texts);
  const rootKey =
    modelParts.find((n) => n === '3d/3dmodel.model') ||
    modelParts.find((n) => n.endsWith('/3dmodel.model')) ||
    modelParts.find((n) => !n.includes('/objects/')) ||
    modelParts[0];
  if (!rootKey) throw new Error('3MF: no model part (.model) found in archive');

  const root = new THREE.Group();
  const rootText = archive.texts[rootKey];

  const buildStart = rootText.indexOf('<build');
  const buildEnd = buildStart === -1 ? -1 : rootText.indexOf('</build>', buildStart);
  const items = [];
  if (buildStart !== -1) {
    ITEM_RE.lastIndex = buildStart;
    const stop = buildEnd === -1 ? rootText.length : buildEnd;
    let im;
    while ((im = ITEM_RE.exec(rootText)) && im.index < stop) items.push(im[1]);
  }

  if (items.length) {
    for (const attrs of items) {
      const path = pathOf(attrs);
      const objectid = attrOf(attrs, 'objectid');
      const node = archive.instantiate(
        path ? normPath(path) : rootKey,
        objectid,
        new Set(),
        objColor.get(objectid)
      );
      if (node) {
        node.applyMatrix4(parseMatrix(attrOf(attrs, 'transform')));
        root.add(node);
      }
    }
  } else {
    for (const id of archive.objectsIn(rootKey).keys()) {
      const node = archive.instantiate(rootKey, id, new Set(), objColor.get(id));
      if (node) root.add(node);
    }
  }

  if (!root.children.length) throw new Error('3MF: no renderable geometry found');
  return root;
}
