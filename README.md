# Comms Hub

Comms Hub is an Electron + React desktop app for keeping several web-based messaging tools in one place. It currently includes built-in entries for Gmail, Discord, Messenger, Slack, and Teams, and it also supports adding custom web apps with your own icons.

## Build From Source

### Requirements

- Node.js 20+ recommended
- npm
- Windows for the current Windows installer flow
- Linux or WSL with Linux-native `node`/`npm` if you want to build the Linux AppImage

### Install Dependencies

From the project root:

```bash
npm install
```

### Run In Development

This starts the Vite dev server and launches Electron against it:

```bash
npm run dev
```

### Run The Built App Locally

Build the renderer first:

```bash
npm run build
```

Then launch Electron against the built files:

```bash
npm start
```

## Packaging

Packaged output is written to:

```bash
release/
```

### Windows Installer

Build the Windows NSIS installer:

```bash
npm run dist:win
```

The installer is generated at:

```bash
release/Comms Hub Setup 0.1.0.exe
```

### Linux AppImage

Build the Linux AppImage:

```bash
npm run dist:linux
```

Note:
- run `npm install` first so local `electron` and `electron-builder` are present
- prefer `npm run dist:linux` over raw `npx electron-builder --linux`
- this works best on Linux or in WSL using Linux-native `node` and `npm`
- if WSL is accidentally using Windows `node`, the AppImage step can fail with Windows-path tool errors

### Generic Packaging Command

Run the default packaging command:

```bash
npm run dist
```

## GitHub Actions Builds

This repo includes a GitHub Actions workflow at [.github/workflows/build-installers.yml](C:/Users/Gary%20Yang/Documents/CommsApp/.github/workflows/build-installers.yml) that:

- builds the Windows installer on `windows-latest`
- builds the Linux AppImage on `ubuntu-latest`
- uploads both outputs as workflow artifacts

It runs on:

- pushes to `main` or `master`
- pull requests
- manual `workflow_dispatch`

If you want a manual build from the GitHub UI:

1. Open the repository on GitHub
2. Go to `Actions`
3. Open `Build Installers`
4. Click `Run workflow`

After the workflow finishes, download the generated installers from the workflow artifacts section.

## Installer Notes

- Windows installer output includes Start Menu and Desktop shortcuts
- uninstall is available through Windows Installed Apps / Apps & features as `Comms Hub`
- the installer is currently unsigned, so Windows SmartScreen may show an unknown publisher warning

## Local App Data

On Windows, local app config and embedded session data are stored under:

```text
%APPDATA%\Comms Hub\
```

That includes:
- saved app configuration
- notification history
- uploaded custom icons
- persistent Chromium session data for embedded services
