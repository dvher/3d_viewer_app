# 3D Viewer

This project is mostly vibe coded and reviewed by me, it is a personal project 
born from the frustration that there are not many good 3D file viewers online. 
If you may want to contribute and modify it feel free to do so, but because of 
the vibe coded nature of this project it is not to be used commercially.

It is released under the **PolyForm Noncommercial License 1.0.0** — you are free
to use, modify, and share it for any noncommercial purpose, but commercial use is
not permitted. See [`LICENSE`](./LICENSE) and the [License](#license) section for
details.

A cross-platform mobile app to view and compare 3D models on your phone. Import
**STL, 3MF, GLB/glTF, and OBJ** files, orbit around them from any angle, load
several at once, move them around in space, and overlay two of them at reduced
opacity to spot the differences.

Built with **Expo + React Native + three.js**, so the same codebase runs on
Android today and can be compiled for **iOS** later with no code changes — only
`expo run:ios` / an Apple build is needed.

## Features

- **View** STL, 3MF, GLB/glTF and OBJ files.
- **Orbit / zoom / pan** — one finger to rotate, two fingers to pinch-zoom and pan.
- **Multi-import** — select several files at once; each gets its own color.
- **Move mode** — drag the selected model to reposition it in 3D space.
- **Diff mode** — mark exactly two models (tap the `◇` badge) and press **Diff**
  to stack them at the origin, tinted red vs. cyan at 50% opacity. Overlapping
  geometry blends; differences stand out.

## Requirements

- Node.js 18+
- [pnpm](https://pnpm.io/)
- The **Expo Go** app on your phone (Android/iOS), *or* an Android emulator / iOS simulator.

## Getting started

```bash
pnpm install
pnpm start
```

Then scan the QR code with **Expo Go** (Android) / the Camera app (iOS), or press
`a` for an Android emulator / `i` for the iOS simulator.

> This project pins pnpm to a **hoisted** `node_modules` layout, because React
> Native's Metro bundler cannot follow pnpm's default symlinked store. The
> setting lives in **`pnpm-workspace.yaml`** (`nodeLinker: hoisted`) for newer
> pnpm, with an equivalent `node-linker=hoisted` in `.npmrc` for older pnpm.
> Keep both. If a fresh `pnpm install` ever produces symlinks in `node_modules`,
> run `pnpm install --config.node-linker=hoisted` once.

## Building native binaries

Expo Go covers development. For standalone builds:

```bash
# Local native builds (requires Android SDK / Xcode installed)
pnpm exec expo run:android
pnpm exec expo run:ios

# Or cloud builds via EAS (no local SDKs needed)
pnpm dlx eas-cli build -p android
pnpm dlx eas-cli build -p ios
```

## How it works

| Area | File |
| --- | --- |
| App entry + polyfills | `App.js`, `src/polyfills.js` |
| File import + format parsing + normalization | `src/three/loadModel.js` |
| WebGL scene, camera, render loop, diff logic | `src/three/SceneManager.js` |
| UI, gestures (PanResponder), state | `src/screens/ViewerScreen.js` |
| base64 → ArrayBuffer/string decoding | `src/three/base64.js` |

Files are read as base64 by `expo-file-system`, decoded to an `ArrayBuffer`
(STL/GLB/3MF) or UTF-8 string (OBJ), and parsed by the matching three.js loader.
Each model is centered and uniformly scaled to a common size so a tiny screw and
a large bracket both arrive usable.

## Notes & limitations

- **3MF** and **GLB** parsing rely on browser globals (`DOMParser`, `TextDecoder`)
  that don't exist in React Native's Hermes engine. They're polyfilled in
  `src/polyfills.js` (`@xmldom/xmldom`, `text-encoding`).
- Embedded **textures** in GLB/glTF may not render in all cases because React
  Native has no `createImageBitmap`; geometry always loads. Diff/overlay works on
  geometry regardless of textures.
- The diff overlay is a **visual** comparison (semi-transparent superposition),
  not a numeric mesh-distance report.

## iOS portability

Nothing in the app uses Android-only APIs. `expo-gl`, `expo-document-picker`,
`expo-file-system`, three.js and the gesture handling (`PanResponder`) are all
cross-platform. The `app.json` already declares an iOS `bundleIdentifier`, so an
iOS build is a matter of running the iOS build command on a Mac.

## License

Licensed under the **[PolyForm Noncommercial License 1.0.0](./LICENSE)**.

In short:

- ✅ **Use, modify, and share** the software for any **noncommercial** purpose —
  personal projects, hobby use, study, research, and use by nonprofits,
  educational institutions, and governments are all permitted.
- ✅ **Contribute** — changes and new works based on this project are welcome
  under the same terms.
- ❌ **No commercial use.** You may not use the software for commercial purposes.
- ⚠️ **No warranty.** The software is provided "as is", without warranty or
  liability, as far as the law allows.

If you keep or redistribute the code, keep the `LICENSE` file (or a link to it)
with your copy. The full legal text lives in [`LICENSE`](./LICENSE).
