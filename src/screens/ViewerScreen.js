import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  PanResponder,
  StyleSheet,
  Linking,
} from 'react-native';
import { GLView } from 'expo-gl';
import * as DocumentPicker from 'expo-document-picker';

import SceneManager, { MODEL_COLORS } from '../three/SceneManager';
import { loadModel, SUPPORTED_EXTENSIONS } from '../three/loadModel';

// GitHub repository — used for the "report a bug" link.
const GITHUB_URL = 'https://github.com/dvher/3d_viewer_app';
const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues/new`;

let ID = 0;
const nextId = () => `m${++ID}`;

// Group a number's integer part with thousands separators (Hermes' Intl is
// unreliable), e.g. 1234567 -> "1,234,567".
function groupThousands(n) {
  const [int, frac] = String(n).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

// Format a millimeter value adaptively: sub-millimeter volumes read better in
// mm³, everyday parts in cm³.
function formatVolume(mm3) {
  const cm3 = mm3 / 1000;
  if (cm3 >= 0.1) return `${groupThousands(cm3.toFixed(2))} cm³`;
  return `${groupThousands(Math.round(mm3))} mm³`;
}

// Derive a display name (with extension when present) from an incoming file URI.
function nameFromUri(uri) {
  try {
    const path = decodeURIComponent(uri.split('?')[0].split('#')[0]);
    const last = path.split('/').pop();
    if (last && last.includes('.')) return last;
  } catch {
    // fall through to the default below
  }
  return 'Shared model';
}

// A single-finger drag under this many dp still counts as a tap.
const TAP_MOVE_THRESHOLD = 8;
// Hold this long without moving to toggle a model in the multi-selection.
const LONG_PRESS_MS = 450;

export default function ViewerScreen() {
  const managerRef = useRef(new SceneManager());

  // Mutable gesture bookkeeping shared across PanResponder callbacks.
  const gestureRef = useRef({
    lastX: 0,
    lastY: 0,
    lastDist: 0,
    touches: 0,
    startX: 0,
    startY: 0,
    startLocalX: 0,
    startLocalY: 0,
    moved: false,
    axis: null,
    longPressFired: false,
    longPressTimer: null,
  });

  const [models, setModels] = useState([]); // [{ id, name, color, diffSelected }]
  const [mode, setMode] = useState('orbit'); // 'orbit' | 'move'
  const [moveAxis, setMoveAxis] = useState('free'); // 'free' | 'x' | 'y' | 'z'
  const [selectedIds, setSelectedIds] = useState([]); // move-selection (tap / long-press)
  const [diffOn, setDiffOn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null); // { name, size, volume, area, triangles } | null
  const [caliper, setCaliper] = useState([]); // [{ point: Vector3, modelId, scale }] (0–2)

  const manager = managerRef.current;

  // Keep React's selection mirror in sync with the manager's source of truth.
  const syncSelection = useCallback(() => {
    setSelectedIds([...managerRef.current.selectedIds]);
  }, []);

  // ----- Caliper (interactive measure) --------------------------------------

  const clearCaliper = useCallback(() => {
    setCaliper([]);
    managerRef.current.clearCaliper();
  }, []);

  // Plant a measurement point at a view-local touch. Two points make a
  // measurement; a third tap starts a fresh one.
  const placePoint = useCallback((localX, localY) => {
    const hit = managerRef.current.pickSurface(localX, localY);
    if (!hit) return;
    setCaliper((prev) => {
      const next = prev.length >= 2 ? [hit] : [...prev, hit];
      managerRef.current.renderCaliper(next.map((p) => p.point));
      return next;
    });
  }, []);

  // Straight-line distance between the two points, in the file's native units
  // (mm). World distance is divided by the model's normalization scale; only
  // meaningful when both points sit on the same model.
  const caliperDistance = useMemo(() => {
    if (caliper.length < 2) return null;
    const [a, b] = caliper;
    if (a.modelId !== b.modelId) return { crossModel: true };
    return { mm: a.point.distanceTo(b.point) / a.scale };
  }, [caliper]);

  // Stop the render loop when the screen unmounts.
  useEffect(() => () => manager.dispose(), [manager]);

  // ----- GL lifecycle -------------------------------------------------------

  const onContextCreate = useCallback(
    (gl) => {
      manager.init(gl);
      manager.setMode(mode);
    },
    [manager, mode]
  );

  const onLayout = useCallback(
    (e) => {
      const { width, height } = e.nativeEvent.layout;
      manager.setViewSize(width, height);
    },
    [manager]
  );

  // ----- File import --------------------------------------------------------

  // Next color to hand out; a ref so it survives re-renders and stays correct
  // regardless of which entry point (picker or "open with" intent) adds a model.
  const colorIndexRef = useRef(0);

  // Load a batch of { uri, name } assets into the scene. `validateExt` filters
  // by filename extension up front (used by the picker); intent-opened files
  // skip it because their content:// URI may not expose an extension — the
  // loader sniffs the format from the bytes instead.
  const addAssets = useCallback(
    async (assets, { validateExt = true } = {}) => {
      if (!assets.length) return;
      setLoading(true);
      const added = [];
      try {
        for (const asset of assets) {
          const name = asset.name || nameFromUri(asset.uri);
          if (validateExt) {
            const ext = (name.split('.').pop() || '').toLowerCase();
            if (!SUPPORTED_EXTENSIONS.includes(ext)) {
              setError(`Skipped "${name}" — unsupported type .${ext}`);
              continue;
            }
          }
          const id = nextId();
          const color = MODEL_COLORS[colorIndexRef.current++ % MODEL_COLORS.length];
          try {
            const { object } = await loadModel({ uri: asset.uri, name }, color);
            manager.addModel(id, object, color);
            added.push({ id, name, color, diffSelected: false });
          } catch (err) {
            setError(`Failed to load "${name}": ${err.message}`);
          }
        }
        if (added.length) {
          setModels((prev) => [...prev, ...added]);
          syncSelection();
        }
      } finally {
        setLoading(false);
      }
    },
    [manager, syncSelection]
  );

  const importFiles = useCallback(async () => {
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
        type: '*/*', // many devices don't map .stl/.3mf MIME types; filter by name below
      });
      if (result.canceled) return;
      await addAssets(result.assets ?? []);
    } catch (err) {
      setError(err.message ?? String(err));
    }
  }, [addAssets]);

  // Handle files opened via an Android "open with" intent (content://) as well
  // as any custom-scheme deep link. Runs once for the URL that launched the app
  // and again for every URL delivered while it's already running.
  useEffect(() => {
    const handleUrl = (url) => {
      if (!url) return;
      if (url.startsWith('file://') || url.startsWith('content://')) {
        setError(null);
        addAssets([{ uri: url, name: nameFromUri(url) }], { validateExt: false });
      }
    };

    Linking.getInitialURL().then(handleUrl).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handleUrl(e?.url));
    return () => sub.remove();
  }, [addAssets]);

  const reportBug = useCallback(() => {
    Linking.openURL(GITHUB_ISSUES_URL).catch(() =>
      setError('Could not open the browser to report a bug.')
    );
  }, []);

  const removeModel = useCallback(
    (id) => {
      manager.removeModel(id);
      setModels((prev) => prev.filter((m) => m.id !== id));
      syncSelection();
      setStats((s) => (s && s.id === id ? null : s));
      if (caliper.some((p) => p.modelId === id)) clearCaliper();
      if (diffOn) setDiffOn(false);
    },
    [manager, diffOn, syncSelection, caliper, clearCaliper]
  );

  // ----- Measurements (computed on demand, never at load time) ---------------

  const showStats = useCallback(
    (id) => {
      const model = models.find((m) => m.id === id);
      const s = manager.computeStats(id);
      if (!model || !s) return;
      setStats({ id, name: model.name, ...s });
    },
    [manager, models]
  );

  // ----- Diff selection (independent from the move-selection) ----------------

  const toggleDiffSelect = useCallback((id) => {
    setModels((prev) => {
      const selectedCount = prev.filter((m) => m.diffSelected).length;
      return prev.map((m) => {
        if (m.id !== id) return m;
        // Enforce a maximum of two selected models for diffing.
        if (!m.diffSelected && selectedCount >= 2) return m;
        return { ...m, diffSelected: !m.diffSelected };
      });
    });
  }, []);

  const diffSelected = useMemo(
    () => models.filter((m) => m.diffSelected).map((m) => m.id),
    [models]
  );

  const canDiff = diffSelected.length === 2;

  const toggleDiff = useCallback(() => {
    if (!diffOn && !canDiff) {
      setError('Select exactly two models (tap the ◇ badge) to compare.');
      return;
    }
    const next = !diffOn;
    setDiffOn(next);
    setError(null);
    if (next) {
      // Diff repositions models, so any active caliper measurement is now stale;
      // also drop out of measure mode since it's unavailable while diffing.
      clearCaliper();
      if (mode === 'measure') {
        setMode('orbit');
        manager.setMode('orbit');
        manager.setActiveAxis(null);
      }
      manager.setDiff(true, diffSelected[0], diffSelected[1]);
      manager.frameAll();
    } else {
      manager.setDiff(false);
    }
  }, [diffOn, canDiff, diffSelected, manager, mode, clearCaliper]);

  // ----- Mode / selection ---------------------------------------------------

  const changeMode = useCallback(
    (m) => {
      setMode(m);
      manager.setMode(m);
      // Reflect the current axis lock on the gizmo when entering move mode.
      manager.setActiveAxis(m === 'move' && moveAxis !== 'free' ? moveAxis : null);
      // Leaving measure mode drops the current measurement.
      if (m !== 'measure') clearCaliper();
    },
    [manager, moveAxis, clearCaliper]
  );

  const selectAxis = useCallback(
    (axis) => {
      setMoveAxis(axis);
      manager.setActiveAxis(axis === 'free' ? null : axis);
    },
    [manager]
  );

  // Chip tap: make this model the sole move-selection.
  const selectModel = useCallback(
    (id) => {
      manager.setSelection([id]);
      syncSelection();
    },
    [manager, syncSelection]
  );

  const resetView = useCallback(() => {
    manager.frameAll();
    if (!diffOn) manager.resetPositions();
    // Positions may have changed under the markers; drop any measurement.
    if (caliper.length) clearCaliper();
  }, [manager, diffOn, caliper.length, clearCaliper]);

  // ----- Touch gestures -----------------------------------------------------

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          const ne = evt.nativeEvent;
          const t = ne.touches;
          const g = gestureRef.current;
          const m = managerRef.current;

          g.touches = t.length;
          g.moved = false;
          g.axis = null;
          g.longPressFired = false;
          clearTimeout(g.longPressTimer);

          if (t.length >= 2) {
            g.lastDist = distance(t[0], t[1]);
            g.lastX = (t[0].pageX + t[1].pageX) / 2;
            g.lastY = (t[0].pageY + t[1].pageY) / 2;
            return;
          }

          g.startX = g.lastX = ne.pageX;
          g.startY = g.lastY = ne.pageY;
          g.startLocalX = ne.locationX;
          g.startLocalY = ne.locationY;

          // In move mode, a drag that starts on an axis handle is axis-locked.
          if (mode === 'move') {
            g.axis = m.pickAxis(ne.locationX, ne.locationY);
          }

          // Long press (without moving) toggles this model in the selection.
          // Disabled in measure mode, where a tap plants a caliper point.
          if (mode === 'measure') return;
          g.longPressTimer = setTimeout(() => {
            if (g.moved) return;
            const id = m.pickModel(g.startLocalX, g.startLocalY);
            if (id) {
              m.toggleSelection(id);
              syncSelection();
              g.longPressFired = true;
            }
          }, LONG_PRESS_MS);
        },
        onPanResponderMove: (evt) => {
          const t = evt.nativeEvent.touches;
          const g = gestureRef.current;
          const m = managerRef.current;

          if (t.length >= 2) {
            // Two fingers: pinch-zoom + pan the camera (in any mode).
            clearTimeout(g.longPressTimer);
            g.moved = true;

            const dist = distance(t[0], t[1]);
            const cx = (t[0].pageX + t[1].pageX) / 2;
            const cy = (t[0].pageY + t[1].pageY) / 2;

            if (g.touches < 2) {
              // Just transitioned 1 -> 2 fingers; reset baselines.
              g.lastDist = dist;
              g.lastX = cx;
              g.lastY = cy;
            }
            if (g.lastDist > 0) m.zoomCamera(dist / g.lastDist);
            m.panCamera(cx - g.lastX, cy - g.lastY);

            g.lastDist = dist;
            g.lastX = cx;
            g.lastY = cy;
            g.touches = t.length;
            return;
          }

          // Single finger.
          const px = t[0].pageX;
          const py = t[0].pageY;

          if (g.touches >= 2) {
            // Returned from two fingers to one; reset baseline, skip this frame.
            g.lastX = px;
            g.lastY = py;
            g.touches = 1;
            return;
          }

          if (!g.moved) {
            const moved = Math.hypot(px - g.startX, py - g.startY) > TAP_MOVE_THRESHOLD;
            if (moved) {
              g.moved = true;
              clearTimeout(g.longPressTimer);
            }
          }

          const dx = px - g.lastX;
          const dy = py - g.lastY;

          if (g.moved && !g.longPressFired) {
            if (mode === 'move' && m.selectedIds.size > 0) {
              // Button-selected axis wins; when free, a grabbed arrow still locks.
              const axis = moveAxis !== 'free' ? moveAxis : g.axis;
              if (axis) m.moveSelectedAlongAxis(axis, dx, dy);
              else m.moveSelected(dx, dy);
            } else {
              m.rotateCamera(dx, dy);
            }
          }

          g.lastX = px;
          g.lastY = py;
          g.touches = 1;
        },
        onPanResponderRelease: (evt) => {
          const g = gestureRef.current;
          const m = managerRef.current;
          clearTimeout(g.longPressTimer);

          // A clean tap (no drag, no long-press). In measure mode it plants a
          // caliper point; otherwise it selects the tapped model, or clears the
          // selection on empty space. Tapping an axis handle is ignored so it
          // doesn't wipe the selection.
          if (!g.moved && !g.longPressFired && !g.axis) {
            if (mode === 'measure') {
              placePoint(g.startLocalX, g.startLocalY);
            } else {
              const id = m.pickModel(g.startLocalX, g.startLocalY);
              if (id) m.setSelection([id]);
              else m.clearSelection();
              syncSelection();
            }
          }

          g.touches = 0;
          g.lastDist = 0;
          g.axis = null;
          g.moved = false;
          g.longPressFired = false;
        },
        onPanResponderTerminate: () => {
          const g = gestureRef.current;
          clearTimeout(g.longPressTimer);
          g.touches = 0;
          g.lastDist = 0;
          g.axis = null;
          g.moved = false;
          g.longPressFired = false;
        },
      }),
    [mode, moveAxis, syncSelection, placePoint]
  );

  // ----- Render -------------------------------------------------------------

  const hasModels = models.length > 0;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <View style={styles.root}>
      <View style={styles.glWrap} onLayout={onLayout} {...panResponder.panHandlers}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />

        {!hasModels && (
          <View pointerEvents="box-none" style={styles.emptyOverlay}>
            <Text pointerEvents="none" style={styles.emptyTitle}>3D Viewer</Text>
            <Text pointerEvents="none" style={styles.emptyText}>
              Import STL, 3MF, GLB or OBJ files to get started.
            </Text>
            <TouchableOpacity style={styles.emptyBugLink} onPress={reportBug}>
              <Text style={styles.emptyBugText}>Found a bug? Report it on GitHub ↗</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Always-reachable bug-report link */}
        <TouchableOpacity style={styles.bugCorner} onPress={reportBug} hitSlop={10}>
          <Text style={styles.bugCornerText}>⚑ Bug</Text>
        </TouchableOpacity>

        {/* Header hint */}
        <View pointerEvents="none" style={styles.header}>
          <Text style={styles.headerText}>
            {diffOn
              ? 'Diff mode · two models overlapped'
              : mode === 'move'
              ? 'Move · drag model or an axis handle · tap to select · long-press to multi-select'
              : mode === 'measure'
              ? 'Measure · tap two points on a model · drag to orbit'
              : 'Orbit · drag rotates · pinch zoom · tap to select · long-press to multi-select'}
          </Text>
        </View>
      </View>

      {/* Error / status toast */}
      {error ? (
        <TouchableOpacity onPress={() => setError(null)} style={styles.toast}>
          <Text style={styles.toastText}>{error}</Text>
        </TouchableOpacity>
      ) : null}

      {/* Model strip */}
      {hasModels && (
        <View style={styles.stripWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {models.map((m) => {
              const isSelected = selectedSet.has(m.id);
              return (
                <View key={m.id} style={[styles.chip, isSelected && styles.chipSelected]}>
                  <TouchableOpacity style={styles.chipMain} onPress={() => selectModel(m.id)}>
                    <View style={[styles.swatch, { backgroundColor: `#${m.color.toString(16).padStart(6, '0')}` }]} />
                    <Text numberOfLines={1} style={styles.chipName}>
                      {m.name}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.chipActions}>
                    <TouchableOpacity onPress={() => showStats(m.id)}>
                      <Text style={styles.infoBadge}>ⓘ</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => toggleDiffSelect(m.id)}>
                      <Text style={[styles.diffBadge, m.diffSelected && styles.diffBadgeOn]}>
                        {m.diffSelected ? '◆' : '◇'}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeModel(m.id)}>
                      <Text style={styles.removeBadge}>✕</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Axis lock selector (Move mode only) */}
      {mode === 'move' && !diffOn && hasModels && (
        <View style={styles.axisBar}>
          <Text style={styles.axisLabel}>Move axis</Text>
          <AxisChip label="Free" active={moveAxis === 'free'} onPress={() => selectAxis('free')} />
          <AxisChip label="X" color="#ff5555" active={moveAxis === 'x'} onPress={() => selectAxis('x')} />
          <AxisChip label="Y" color="#5dff7d" active={moveAxis === 'y'} onPress={() => selectAxis('y')} />
          <AxisChip label="Z" color="#4d9bff" active={moveAxis === 'z'} onPress={() => selectAxis('z')} />
        </View>
      )}

      {/* Caliper readout (Measure mode only) */}
      {mode === 'measure' && !diffOn && hasModels && (
        <View style={styles.caliperBar}>
          <Text style={styles.caliperText}>
            {caliperDistance
              ? caliperDistance.crossModel
                ? 'Points are on different models'
                : `Distance  ${caliperDistance.mm.toFixed(2)} mm`
              : caliper.length === 1
              ? 'Tap the second point'
              : 'Tap a point on the model'}
          </Text>
          {caliper.length > 0 && (
            <TouchableOpacity style={styles.caliperClear} onPress={clearCaliper}>
              <Text style={styles.caliperClearText}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <ToolButton label={loading ? '…' : 'Import'} onPress={importFiles} primary disabled={loading} />
        <ToolButton
          label="Orbit"
          onPress={() => changeMode('orbit')}
          active={mode === 'orbit' && !diffOn}
          disabled={diffOn}
        />
        <ToolButton
          label="Move"
          onPress={() => changeMode('move')}
          active={mode === 'move' && !diffOn}
          disabled={diffOn || !hasModels}
        />
        <ToolButton
          label="Measure"
          onPress={() => changeMode('measure')}
          active={mode === 'measure' && !diffOn}
          disabled={diffOn || !hasModels}
        />
        <ToolButton
          label={diffOn ? 'Diff ✓' : 'Diff'}
          onPress={toggleDiff}
          active={diffOn}
          disabled={!hasModels}
        />
        <ToolButton label="Reset" onPress={resetView} disabled={!hasModels} />
      </View>

      {loading && (
        <View pointerEvents="none" style={styles.loading}>
          <ActivityIndicator size="large" color="#4dd2ff" />
          <Text style={styles.loadingText}>Loading model…</Text>
        </View>
      )}

      {/* Measurements panel (on-demand) */}
      {stats && (
        <View style={styles.statsBackdrop}>
          <View style={styles.statsCard}>
            <Text numberOfLines={1} style={styles.statsTitle}>
              {stats.name}
            </Text>
            <StatRow
              label="Dimensions"
              value={`${stats.size.x.toFixed(1)} × ${stats.size.y.toFixed(1)} × ${stats.size.z.toFixed(1)} mm`}
            />
            <StatRow label="Volume" value={formatVolume(stats.volume)} strong />
            <StatRow label="Surface area" value={`${groupThousands((stats.area / 100).toFixed(2))} cm²`} />
            <StatRow label="Triangles" value={groupThousands(stats.triangles)} />
            <Text style={styles.statsNote}>
              Assumes the file is in millimeters (STL/3MF standard).
            </Text>
            <TouchableOpacity style={styles.statsClose} onPress={() => setStats(null)}>
              <Text style={styles.statsCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function StatRow({ label, value, strong }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, strong && styles.statValueStrong]}>{value}</Text>
    </View>
  );
}

function ToolButton({ label, onPress, active, primary, disabled }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.btn,
        primary && styles.btnPrimary,
        active && styles.btnActive,
        disabled && styles.btnDisabled,
      ]}
    >
      <Text numberOfLines={1} style={[styles.btnText, active && styles.btnTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function AxisChip({ label, color, active, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.axisChip, active && styles.axisChipActive, active && color && { borderColor: color }]}
    >
      {color ? <View style={[styles.axisDot, { backgroundColor: color }]} /> : null}
      <Text style={[styles.axisChipText, active && styles.axisChipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function distance(a, b) {
  const dx = a.pageX - b.pageX;
  const dy = a.pageY - b.pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101418' },
  glWrap: { flex: 1, overflow: 'hidden' },
  header: {
    position: 'absolute',
    top: 44,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  headerText: {
    color: '#8a97a6',
    fontSize: 12,
    textAlign: 'center',
    backgroundColor: 'rgba(16,20,24,0.6)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },
  emptyOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: '#e8edf2', fontSize: 28, fontWeight: '700', marginBottom: 8 },
  emptyText: { color: '#8a97a6', fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  emptyBugLink: { marginTop: 22, paddingHorizontal: 14, paddingVertical: 8 },
  emptyBugText: { color: '#4dd2ff', fontSize: 13, fontWeight: '600' },
  bugCorner: {
    position: 'absolute',
    top: 44,
    right: 12,
    backgroundColor: 'rgba(16,20,24,0.6)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  bugCornerText: { color: '#8a97a6', fontSize: 12, fontWeight: '600' },
  toast: {
    position: 'absolute',
    top: 76,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(180,60,60,0.92)',
    borderRadius: 8,
    padding: 10,
  },
  toastText: { color: '#fff', fontSize: 12 },
  axisBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    backgroundColor: '#161b21',
    borderTopWidth: 1,
    borderTopColor: '#20272f',
  },
  axisLabel: { color: '#8a97a6', fontSize: 12, marginRight: 2 },
  axisChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#232b34',
    borderWidth: 1,
    borderColor: '#2a323c',
  },
  axisChipActive: { backgroundColor: '#2f3a45', borderColor: '#4dd2ff' },
  axisDot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  axisChipText: { color: '#dfe6ed', fontSize: 13, fontWeight: '600' },
  axisChipTextActive: { color: '#ffffff' },
  stripWrap: { backgroundColor: '#161b21', borderTopWidth: 1, borderTopColor: '#20272f' },
  strip: { paddingHorizontal: 8, paddingVertical: 8, gap: 8 },
  chip: {
    backgroundColor: '#1e252d',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a323c',
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 6,
    minWidth: 150,
    maxWidth: 220,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chipSelected: { borderColor: '#4dd2ff', backgroundColor: '#22303a' },
  chipMain: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  swatch: { width: 14, height: 14, borderRadius: 3, marginRight: 8 },
  chipName: { color: '#dfe6ed', fontSize: 13, flexShrink: 1 },
  chipActions: { flexDirection: 'row', alignItems: 'center', marginLeft: 6 },
  infoBadge: { color: '#6f7d8c', fontSize: 16, paddingHorizontal: 6 },
  diffBadge: { color: '#6f7d8c', fontSize: 16, paddingHorizontal: 6 },
  diffBadgeOn: { color: '#ffd24d' },
  removeBadge: { color: '#7a8794', fontSize: 14, paddingHorizontal: 6 },
  caliperBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#161b21',
    borderTopWidth: 1,
    borderTopColor: '#20272f',
  },
  caliperText: { color: '#ffd24d', fontSize: 14, fontWeight: '600', flexShrink: 1 },
  caliperClear: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#232b34',
    borderWidth: 1,
    borderColor: '#2a323c',
  },
  caliperClearText: { color: '#dfe6ed', fontSize: 12, fontWeight: '600' },
  toolbar: {
    flexDirection: 'row',
    padding: 10,
    gap: 6,
    backgroundColor: '#161b21',
    borderTopWidth: 1,
    borderTopColor: '#20272f',
    paddingBottom: 28,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 2,
    borderRadius: 10,
    backgroundColor: '#232b34',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: '#2d6cdf' },
  btnActive: { backgroundColor: '#4dd2ff' },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#dfe6ed', fontSize: 12, fontWeight: '600' },
  btnTextActive: { color: '#0b1015' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#8a97a6', marginTop: 10 },
  statsBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(8,10,13,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  statsCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#1a2028',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2a323c',
    padding: 18,
  },
  statsTitle: { color: '#e8edf2', fontSize: 16, fontWeight: '700', marginBottom: 12 },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: '#232b34',
  },
  statLabel: { color: '#8a97a6', fontSize: 13 },
  statValue: { color: '#dfe6ed', fontSize: 14, fontWeight: '600', marginLeft: 12 },
  statValueStrong: { color: '#4dd2ff', fontSize: 16 },
  statsNote: { color: '#6f7d8c', fontSize: 11, marginTop: 12, fontStyle: 'italic' },
  statsClose: {
    marginTop: 16,
    backgroundColor: '#2d6cdf',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  statsCloseText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
