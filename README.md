# Comms Hub

Comms Hub is an Electron + React desktop app for keeping several web-based messaging tools in one place. It currently includes built-in entries for Gmail, Discord, Messenger, Slack, and Teams, and it also supports adding custom web apps with your own icons. ( I'm going to be honest I just made this because I didn't like any of the options out there ) 

## Build From Source

### Requirements

- Node.js 20+ recommended
- npm
- Windows for the current Windows installer flow

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
release/Comms Hub Setup <version>.exe
```

### Linux Packages

Linux packages and runtime support are temporarily disabled while Linux startup is being repaired. The current release workflow does not publish Linux artifacts.

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
- runs renderer and unit smoke checks on both Windows and Linux
- runs Electron integration checks on Windows
- uploads installer outputs as workflow artifacts
- publishes a GitHub Release automatically only for version tags like `v1.2.2`

It runs on:

- pushes to `main` or `master`
- pushes of version tags like `v1.2.2`
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
git commit -m "Bump version to 1.2.2"
git tag v1.2.2
git push origin main
git push origin v1.2.2
```

What happens next:

- the GitHub Actions workflow runs smoke checks
- it builds the Windows installer
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

## Runtime and Platform Support

Linux builds and runtime support are temporarily disabled while startup behavior is being repaired.

Selected and pinned apps stay loaded. Other apps sleep after 10 minutes unless protected by an active edit, media playback, or an unload refusal from the page. Turning the saver off keeps visited apps loaded. Login storage is preserved, although a sleeping app reloads when resumed and pauses its notifications while asleep.

App entries are managed independently and preserve their existing login sessions. The bubble size is saved for the app; the 50–200% page zoom is saved separately for each entry.

### Verification

Run `npm run smoke` for the renderer build and unit checks, then `npm run test:electron` on Windows for native lifecycle and production-renderer integration checks. The integration suite uses temporary profiles and local synthetic pages.

## Things I might add in the future

------

- animations
- agregated message center (don't hold your breath on this one)
