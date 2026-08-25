# Development shell for building the Android APK on NixOS.
#
#   nix-shell            # enter the shell with JDK + a composed Android SDK
#   pnpm install         # (first time) install JS deps
#   pnpm run apk         # prebuild + assemble a standalone release APK
#
# The Android SDK is managed with tadfisher/android-nixpkgs, which exposes each
# SDK component as an individual, NixOS-patched Nix package. We select exactly
# the components Expo 51 / React Native 0.74 expect (platform 34, build-tools
# 34.0.0, NDK 26.1, CMake 3.22.1), plus platform-tools and cmdline-tools. expo-gl
# ships native C++, hence the NDK + CMake. No use of ~/Android/Sdk.
{ pkgs ? import <nixpkgs> {
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  }
}:

let
  # Pin android-nixpkgs. Bump this rev to update the available SDK component set.
  android-nixpkgs = import (builtins.fetchTarball {
    url = "https://github.com/tadfisher/android-nixpkgs/archive/refs/heads/main.tar.gz";
  }) { inherit pkgs; channel = "stable"; };

  android-sdk = android-nixpkgs.sdk (sdkPkgs: with sdkPkgs; [
    cmdline-tools-latest
    platform-tools
    build-tools-34-0-0
    platforms-android-34
    ndk-26-1-10909125
    cmake-3-22-1
  ]);

  sdkRoot = "${android-sdk}/share/android-sdk";
in
pkgs.mkShell {
  buildInputs = [
    pkgs.jdk17          # Expo 51 / AGP 8.x officially target JDK 17
    android-sdk
  ];

  JAVA_HOME = "${pkgs.jdk17}";

  shellHook = ''
    export ANDROID_HOME="${sdkRoot}"
    export ANDROID_SDK_ROOT="${sdkRoot}"
    export ANDROID_NDK_ROOT="${sdkRoot}/ndk/26.1.10909125"
    export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
    echo "Android SDK: $ANDROID_HOME"
    echo "JDK:         $JAVA_HOME"
  '';
}
