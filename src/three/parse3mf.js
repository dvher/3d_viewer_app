import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';

import { BAMBU_PALETTE } from './bambuColors.js';

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
const VERTEX_RE = /<vertex\b[^>]*?\bx="([^"]*)"[^>]*?\by="([^"]*)"[^>]*?\bz="([^"]*)"/g;
const TRIANGLE_RE = /<triangle\b[^>]*?\bv1="([^"]*)"[^>]*?\bv2="([^"]*)"[^>]*?\bv3="([^"]*)"/g;
// Colored variant also captures the trailing attributes (pid/p1.. or paint_color).
const TRIANGLE_COLOR_RE = /<triangle\b[^>]*?\bv1="([^"]*)"[^>]*?\bv2="([^"]*)"[^>]*?\bv3="([^"]*)"([^>]*?)\/?>/g;
const COMPONENT_RE = /<component\b([^>]*?)\/?>/g;
const ITEM_RE = /<item\b([^>]*?)\/?>/g;
// Precompiled hot-path attribute readers for the per-triangle color scan.
const RE_PAINT = /paint_color="([^"]*)"/;
const RE_PID = /\bpid="([^"]*)"/;
const RE_P1 = /\bp1="([^"]*)"/;
const RE_P2 = /\bp2="([^"]*)"/;
const RE_P3 = /\bp3="([^"]*)"/;

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
  const posArr = [];
  VERTEX_RE.lastIndex = start;
  let m;
  while ((m = VERTEX_RE.exec(text)) && m.index < end) posArr.push(+m[1], +m[2], +m[3]);
  if (!posArr.length) return null;

  const idxArr = [];
  TRIANGLE_RE.lastIndex = start;
  while ((m = TRIANGLE_RE.exec(text)) && m.index < end) idxArr.push(+m[1], +m[2], +m[3]);
  if (!idxArr.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(posArr), 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(idxArr), 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build a BufferGeometry with a per-vertex `color` attribute using 3MF material
 * references and/or Bambu paint_color. Vertex colors use last-writer-wins at
 * region boundaries (keeps the geometry indexed — no vertex explosion).
 */
function buildGeometryColored(text, start, end, ctx) {
  const posArr = [];
  VERTEX_RE.lastIndex = start;
  let m;
  while ((m = VERTEX_RE.exec(text)) && m.index < end) posArr.push(+m[1], +m[2], +m[3]);
  if (!posArr.length) return null;

  const { groups, palette, objectPid, objectPindex, defaultFill } = ctx;

  // Unpainted vertices fall back to the object's filament color, else the first
  // filament, else white — so painted models don't show bare white patches.
  const fill =
    defaultFill != null ? defaultFill : palette && palette[0] != null ? palette[0] : 0xffffff;
  const fr = ((fill >> 16) & 255) / 255;
  const fg = ((fill >> 8) & 255) / 255;
  const fb = (fill & 255) / 255;

  const vertCount = posArr.length / 3;
  const colors = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    colors[i * 3] = fr;
    colors[i * 3 + 1] = fg;
    colors[i * 3 + 2] = fb;
  }
  const idxArr = [];
  const paintCache = new Map();
  const objDefault =
    objectPid != null && objectPindex != null && groups.get(objectPid)
      ? groups.get(objectPid)[+objectPindex]
      : null;

  TRIANGLE_COLOR_RE.lastIndex = start;
  while ((m = TRIANGLE_COLOR_RE.exec(text)) && m.index < end) {
    const a = +m[1];
    const b = +m[2];
    const c = +m[3];
    idxArr.push(a, b, c);

    const extra = m[4];
    let c1 = null;
    let c2 = null;
    let c3 = null;

    const paint = extra.length ? extra.match(RE_PAINT) : null;
    if (paint) {
      const col = paintColorInt(paint[1], palette, paintCache);
      c1 = c2 = c3 = col;
    } else if (extra.length) {
      const p1 = extra.match(RE_P1);
      if (p1) {
        const pid = extra.match(RE_PID);
        const grp = groups.get(pid ? pid[1] : objectPid);
        if (grp) {
          const p2 = extra.match(RE_P2);
          const p3 = extra.match(RE_P3);
          c1 = grp[+p1[1]];
          c2 = grp[+(p2 ? p2[1] : p1[1])];
          c3 = grp[+(p3 ? p3[1] : p1[1])];
        }
      }
    }

    if (c1 == null && objDefault != null) c1 = c2 = c3 = objDefault;

    if (c1 != null) writeColor(colors, a, c1);
    if (c2 != null) writeColor(colors, b, c2);
    if (c3 != null) writeColor(colors, c, c3);
  }
  if (!idxArr.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(posArr), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(idxArr), 1));
  geometry.computeVertexNormals();
  return geometry;
}

class Archive {
  constructor(files, palette) {
    this.texts = {};
    for (const name of Object.keys(files)) {
      const key = normPath(name);
      if (key.endsWith('.model')) this.texts[key] = strFromU8(files[name]);
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
