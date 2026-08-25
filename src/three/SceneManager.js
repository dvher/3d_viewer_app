import * as THREE from 'three';
import { Renderer } from 'expo-three';

import { BAMBU_PALETTE } from './bambuColors';

// Default per-model tint palette: real Bambu Lab filament colors.
export const MODEL_COLORS = BAMBU_PALETTE;

// The two "channels" in diff mode — kept as dedicated high-contrast colors
// (independent of the tint palette) so overlaps read clearly.
const DIFF_A = 0xff4d4d; // red
const DIFF_B = 0x4dd2ff; // cyan

// Axis directions and their conventional gizmo colors (X red, Y green, Z blue).
const AXES = [
  { name: 'x', dir: new THREE.Vector3(1, 0, 0), color: 0xff5555 },
  { name: 'y', dir: new THREE.Vector3(0, 1, 0), color: 0x5dff7d },
  { name: 'z', dir: new THREE.Vector3(0, 0, 1), color: 0x4d9bff },
];

/**
 * Owns the WebGL scene: camera, lights, the render loop, and the set of loaded
 * model groups. The React layer talks to it through plain method calls and it
 * mutates three.js objects directly (imperative, like OrbitControls would).
 */
export default class SceneManager {
  constructor() {
    this.gl = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.raf = null;
    this.size = { width: 1, height: 1 };
    // Logical (dp) size of the GLView, needed to map touches <-> NDC and to
    // project world points to screen pixels for axis-constrained dragging.
    this.viewSize = { width: 1, height: 1 };

    // id -> { group, color, homePosition }
    this.models = new Map();

    // Orbit camera state (spherical coordinates around `target`).
    this.target = new THREE.Vector3(0, 0, 0);
    this.spherical = { radius: 6, theta: Math.PI / 4, phi: Math.PI / 3 };

    this.mode = 'orbit'; // 'orbit' | 'move'
    this.selectedIds = new Set(); // models targeted by move + shown with gizmo
    this.diff = { enabled: false, aId: null, bId: null };
    // Movement constraint: null = free plane, or 'x'|'y'|'z' to lock to an axis.
    this.activeAxis = null;

    this.raycaster = new THREE.Raycaster();
    this.gizmo = null;
    this.axisMaterials = {}; // 'x'|'y'|'z' -> gizmo handle material

    // On-demand rendering: the loop only draws while renderFrames > 0. Any change
    // calls invalidate(). We render a couple of frames per change so double-
    // buffered surfaces update both buffers. Set continuous=true to fall back to
    // always-render if a device ever shows a stale/blank frame when idle.
    this.renderFrames = 3;
    this.continuous = false;
  }

  invalidate() {
    this.renderFrames = Math.max(this.renderFrames, 2);
  }

  init(gl) {
    this.gl = gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    this.size = { width, height };

    const renderer = new Renderer({ gl });
    renderer.setSize(width, height);
    renderer.setClearColor(0x101418, 1);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101418);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);
    this.camera = camera;

    // Lighting: hemisphere fill + a key directional light that follows nothing
    // (fixed), giving consistent shading as the user orbits.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x202830, 1.0);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 8, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.6);
    rim.position.set(-6, -3, -4);
    scene.add(rim);

    // A subtle grid so translation/orientation are readable.
    const grid = new THREE.GridHelper(20, 20, 0x2a3340, 0x1c232c);
    grid.position.y = -1.2;
    scene.add(grid);
    this.grid = grid;

    this.gizmo = this.buildGizmo();
    this.gizmo.visible = false;
    scene.add(this.gizmo);

    this.updateCamera();
    this.start();
  }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.continuous && this.renderFrames <= 0) return;
      this.renderFrames--;
      this.updateGizmo();
      this.renderer.render(this.scene, this.camera);
      this.gl.endFrameEXP();
    };
    loop();
  }

  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.models.forEach(({ group }) => this.disposeObject(group));
    this.models.clear();
  }

  disposeObject(object) {
    object.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose?.());
        } else {
          child.material?.dispose?.();
        }
      }
    });
  }

  resize(width, height) {
    this.size = { width, height };
    if (this.renderer) this.renderer.setSize(width, height);
    if (this.camera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.invalidate();
  }

  setViewSize(width, height) {
    if (width > 0 && height > 0) this.viewSize = { width, height };
    this.invalidate();
  }

  // ----- Model management ---------------------------------------------------

  addModel(id, group, color) {
    // Spread models out a little along X so multiple imports don't stack.
    const offset = (this.models.size % 6) - 2.5;
    group.position.x += offset * 1.2;
    group.userData.modelId = id;

    this.scene.add(group);
    this.models.set(id, {
      group,
      color,
      homePosition: group.position.clone(),
    });
    // Auto-select the first model so move mode has a target immediately.
    if (this.selectedIds.size === 0) this.selectedIds.add(id);
    this.invalidate();
  }

  removeModel(id) {
    const entry = this.models.get(id);
    if (!entry) return;
    this.scene.remove(entry.group);
    this.disposeObject(entry.group);
    this.models.delete(id);
    this.selectedIds.delete(id);
    if (this.diff.aId === id || this.diff.bId === id) {
      this.setDiff(false);
    }
    this.invalidate();
  }

  setMode(mode) {
    this.mode = mode;
    this.invalidate();
  }

  // ----- Selection ----------------------------------------------------------

  setSelection(ids) {
    this.selectedIds = new Set(ids.filter((id) => this.models.has(id)));
    this.invalidate();
  }

  toggleSelection(id) {
    if (!this.models.has(id)) return;
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
    this.invalidate();
  }

  clearSelection() {
    this.selectedIds.clear();
    this.invalidate();
  }

  selectedEntries() {
    const out = [];
    this.selectedIds.forEach((id) => {
      const e = this.models.get(id);
      if (e) out.push(e);
    });
    return out;
  }

  selectionCentroid() {
    const c = new THREE.Vector3();
    const entries = this.selectedEntries();
    if (!entries.length) return c;
    entries.forEach((e) => c.add(e.group.position));
    return c.multiplyScalar(1 / entries.length);
  }

  frameAll() {
    // Reset the orbit camera to a comfortable default framing.
    this.target.set(0, 0, 0);
    this.spherical = { radius: 6, theta: Math.PI / 4, phi: Math.PI / 3 };
    this.updateCamera();
  }

  resetPositions() {
    this.models.forEach(({ group, homePosition }) => {
      group.position.copy(homePosition);
      group.rotation.set(0, 0, 0);
    });
    this.invalidate();
  }

  // ----- Diff / overlay mode ------------------------------------------------

  /**
   * Toggle diff mode. When enabled, exactly two models (aId, bId) are stacked at
   * the origin, forced to contrasting colors, and made semi-transparent so
   * overlapping vs. differing geometry is visible. Other models are hidden.
   */
  setDiff(enabled, aId = this.diff.aId, bId = this.diff.bId) {
    this.diff = { enabled, aId, bId };
    this.invalidate();

    if (!enabled) {
      // Restore every model to its original materials and home transform.
      this.models.forEach(({ group, homePosition }) => {
        group.visible = true;
        group.position.copy(homePosition);
        this.restoreAppearance(group);
      });
      return;
    }

    this.models.forEach((entry, id) => {
      const isA = id === aId;
      const isB = id === bId;
      if (isA || isB) {
        entry.group.visible = true;
        entry.group.position.set(0, 0, 0);
        const color = isA ? DIFF_A : DIFF_B;
        this.applyDiffAppearance(entry.group, color, 0.5);
      } else {
        entry.group.visible = false;
      }
    });
  }

  /**
   * Force a group's materials to `color` at `opacity`, saving each material's
   * original color/opacity/blend flags the first time so restoreAppearance can
   * put them back exactly (important for textured GLB models).
   */
  applyDiffAppearance(group, color, opacity) {
    group.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (!m.userData.__origAppearance) {
          m.userData.__origAppearance = {
            color: m.color ? m.color.getHex() : null,
            opacity: m.opacity,
            transparent: m.transparent,
            depthWrite: m.depthWrite,
            map: m.map ?? null,
            vertexColors: m.vertexColors,
          };
        }
        m.color?.setHex(color);
        m.map = null; // hide textures so the two channels read as flat tints
        m.vertexColors = false; // show the pure diff channel color, not baked colors
        m.transparent = true;
        m.opacity = opacity;
        m.depthWrite = false; // let overlaps blend instead of z-fighting
        m.needsUpdate = true;
      });
    });
  }

  restoreAppearance(group) {
    group.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        const orig = m.userData.__origAppearance;
        if (!orig) return;
        if (orig.color !== null) m.color?.setHex(orig.color);
        m.map = orig.map;
        m.vertexColors = orig.vertexColors;
        m.opacity = orig.opacity;
        m.transparent = orig.transparent;
        m.depthWrite = orig.depthWrite;
        m.needsUpdate = true;
        delete m.userData.__origAppearance;
      });
    });
  }

  // ----- Picking (raycasting) -----------------------------------------------

  toNDC(localX, localY) {
    return new THREE.Vector2(
      (localX / this.viewSize.width) * 2 - 1,
      -((localY / this.viewSize.height) * 2 - 1)
    );
  }

  /**
   * Raycast from a view-local touch point and return the id of the topmost model
   * hit, or null. Only visible models participate.
   */
  pickModel(localX, localY) {
    this.raycaster.setFromCamera(this.toNDC(localX, localY), this.camera);
    const groups = [];
    this.models.forEach((e) => {
      if (e.group.visible) groups.push(e.group);
    });
    const hits = this.raycaster.intersectObjects(groups, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o) {
        if (o.userData && o.userData.modelId) return o.userData.modelId;
        o = o.parent;
      }
    }
    return null;
  }

  /**
   * Raycast against the axis gizmo and return 'x' | 'y' | 'z' if a handle was
   * hit, otherwise null.
   */
  pickAxis(localX, localY) {
    if (!this.gizmo || !this.gizmo.visible) return null;
    this.raycaster.setFromCamera(this.toNDC(localX, localY), this.camera);
    const hits = this.raycaster.intersectObjects(this.gizmo.children, true);
    for (const hit of hits) {
      let o = hit.object;
      while (o) {
        if (o.userData && o.userData.axis) return o.userData.axis;
        o = o.parent;
      }
    }
    return null;
  }

  // ----- Gizmo --------------------------------------------------------------

  buildGizmo() {
    const gizmo = new THREE.Group();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const L = 1.4; // shaft length in gizmo-local units

    for (const { name, dir, color } of AXES) {
      const material = new THREE.MeshBasicMaterial({
        color,
        depthTest: false, // draw on top of models so handles stay grabbable
        transparent: true,
        opacity: 0.95,
      });
      const quat = new THREE.Quaternion().setFromUnitVectors(yAxis, dir);

      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, L, 12), material);
      shaft.quaternion.copy(quat);
      shaft.position.copy(dir.clone().multiplyScalar(L / 2));

      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.28, 14), material);
      tip.quaternion.copy(quat);
      tip.position.copy(dir.clone().multiplyScalar(L + 0.14));

      const axisGroup = new THREE.Group();
      axisGroup.userData.axis = name;
      shaft.userData.axis = name;
      tip.userData.axis = name;
      axisGroup.add(shaft, tip);
      gizmo.add(axisGroup);
      this.axisMaterials[name] = material;
    }

    gizmo.traverse((o) => {
      o.renderOrder = 999; // paint after everything else
    });
    return gizmo;
  }

  setActiveAxis(axis) {
    this.activeAxis = axis === 'x' || axis === 'y' || axis === 'z' ? axis : null;
    this.invalidate();
  }

  updateGizmo() {
    if (!this.gizmo) return;
    const show =
      this.mode === 'move' && !this.diff.enabled && this.selectedIds.size > 0;
    this.gizmo.visible = show;
    if (!show) return;
    this.gizmo.position.copy(this.selectionCentroid());
    // Keep a roughly constant on-screen size regardless of zoom distance.
    this.gizmo.scale.setScalar(this.spherical.radius * 0.14);
    // Highlight the locked axis (dim the others); full brightness when free.
    for (const name of ['x', 'y', 'z']) {
      const mat = this.axisMaterials[name];
      if (mat) mat.opacity = !this.activeAxis || this.activeAxis === name ? 0.95 : 0.18;
    }
  }

  // ----- Camera / object manipulation ---------------------------------------

  rotateCamera(dx, dy) {
    const ROT = 0.005;
    this.spherical.theta -= dx * ROT;
    this.spherical.phi -= dy * ROT;
    const EPS = 0.001;
    this.spherical.phi = Math.max(EPS, Math.min(Math.PI - EPS, this.spherical.phi));
    this.updateCamera();
  }

  zoomCamera(factor) {
    this.spherical.radius = Math.max(0.5, Math.min(80, this.spherical.radius / factor));
    this.updateCamera();
  }

  panCamera(dx, dy) {
    // Move the orbit target within the camera's local plane.
    const scale = this.spherical.radius * 0.0015;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    this.target.addScaledVector(right, -dx * scale);
    this.target.addScaledVector(up, dy * scale);
    this.updateCamera();
  }

  /** Free move: translate all selected models in the camera's screen plane. */
  moveSelected(dx, dy) {
    const entries = this.selectedEntries();
    if (!entries.length) return;
    const scale = this.spherical.radius * 0.0015;
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    this.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    const delta = new THREE.Vector3()
      .addScaledVector(right, dx * scale)
      .addScaledVector(up, -dy * scale);
    entries.forEach((e) => {
      e.group.position.add(delta);
      if (!this.diff.enabled) e.homePosition.copy(e.group.position);
    });
    this.invalidate();
  }

  /**
   * Axis-constrained move (slicer style): translate all selected models along a
   * single world axis by the amount the drag traveled along that axis's screen
   * projection.
   */
  moveSelectedAlongAxis(axis, dx, dy) {
    const entries = this.selectedEntries();
    if (!entries.length) return;
    const axisVec = AXES.find((a) => a.name === axis)?.dir;
    if (!axisVec) return;

    // Project the selection centroid and centroid+axis to screen pixels; the
    // difference gives the on-screen direction and pixels-per-world-unit.
    const origin = this.selectionCentroid();
    const a = this.projectToScreen(origin);
    const b = this.projectToScreen(origin.clone().add(axisVec));
    let sx = b.x - a.x;
    let sy = b.y - a.y;
    const pixPerUnit = Math.hypot(sx, sy) || 1e-6;
    sx /= pixPerUnit;
    sy /= pixPerUnit;

    // Component of the drag along the axis's screen direction (screen y is down,
    // matching the touch delta sign).
    const pixelsAlong = dx * sx + dy * sy;
    const worldDelta = pixelsAlong / pixPerUnit;

    entries.forEach((e) => {
      e.group.position.addScaledVector(axisVec, worldDelta);
      if (!this.diff.enabled) e.homePosition.copy(e.group.position);
    });
    this.invalidate();
  }

  projectToScreen(v) {
    const p = v.clone().project(this.camera); // NDC, -1..1
    return {
      x: (p.x * 0.5 + 0.5) * this.viewSize.width,
      y: (-p.y * 0.5 + 0.5) * this.viewSize.height,
    };
  }

  updateCamera() {
    const { radius, theta, phi } = this.spherical;
    const x = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.cos(theta);
    this.camera.position.set(
      this.target.x + x,
      this.target.y + y,
      this.target.z + z
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.invalidate();
  }
}
