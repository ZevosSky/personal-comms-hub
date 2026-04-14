# Comms Hub

Comms Hub is an Electron + React desktop app for keeping several web-based messaging tools in one place. It currently includes built-in entries for Gmail, Discord, Messenger, Slack, and Teams, and it also supports adding custom web apps with your own icons. ( I'm going to be honest I just made this because I didn't like any of the options out there ) 

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

Or use the helper scripts:

```bash
build.bat install
```

```bash
./build.sh install
```

### Run In Development

This starts the Vite dev server and launches Electron against it:

```bash
npm run dev
```

Or:

```bash
build.bat dev
```

```bash
./build.sh dev
```

### Run The Built App Locally

Build the renderer first:

```bash
npm run build
```

Or:

```bash
build.bat build
```

```bash
./build.sh build
```

Then launch Electron against the built files:

```bash
npm start
```

Or:

```bash
build.bat start
```

```bash
./build.sh start
```

### Helper Scripts

The repo includes two top-level helper scripts:

- `build.bat` for Windows Command Prompt / PowerShell
- `build.sh` for Linux, macOS, and WSL shells

They support:

- `install`
- `dev`
- `build`
- `start`
- `smoke`
- `dist`
- `dist:win`
- `dist:linux`

To show their built-in help:

```bash
build.bat help
```

```bash
./build.sh help
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

Or:

```bash
build.bat dist:win
```

The installer is generated at:

```bash
release/Comms Hub Setup 1.2.0.exe
```

### Linux AppImage

Build the Linux AppImage:

```bash
npm run dist:linux
```

Or:

```bash
./build.sh dist:linux
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

Or:

```bash
build.bat dist
```

```bash
./build.sh dist
```

## GitHub Actions Builds

This repo includes a GitHub Actions workflow at [.github/workflows/build-installers.yml](C:/Users/Gary%20Yang/Documents/CommsApp/.github/workflows/build-installers.yml) that:

- builds the Windows installer on `windows-latest`
- builds the Linux AppImage on `ubuntu-latest`
- runs smoke checks on both Windows and Linux first
- uploads both outputs as workflow artifacts
- publishes a GitHub Release automatically only for version tags like `v1.2.0`

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

## Version Tags And Releases

GitHub Releases in this repo are driven by Git tags.

Recommended flow:

1. Update the version in `package.json`
2. Commit the change
3. Create a tag that starts with `v`
4. Push the branch and the tag

Example:

```bash
git add package.json
git commit -m "Bump version to 1.2.0"
git tag v1.2.0
git push origin main
git push origin v1.2.0
```

What happens next:

- the GitHub Actions workflow runs smoke checks
- it builds the Windows and Linux installers
- it creates a GitHub Release for that tag
- it uploads the generated installer files to the release

If you do not push a `v*` tag, the workflow only produces build artifacts in Actions and does not create a release.

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

## Things I might add in the future

------

- animations
- better setting support for things like dissabling keeping specific tabs open
- slightly better memeory optimizations / leak checks
- agregated message center (don't hold your breath on this one)
