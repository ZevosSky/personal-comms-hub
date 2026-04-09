Packaging assets live here.

Current setup:
- `electron-builder` uses this folder as `buildResources`
- packaged installers are emitted into `release/`
- Windows NSIS installer builds from this repo on Windows
- Linux AppImage config is present, but final AppImage creation should be run on Linux or CI

Recommended future additions:
- `icon.ico` for Windows installers
- `icon.png` for Linux packages
- installer/license artwork if you want branded setup screens
