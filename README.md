# Comms Hub

Comms Hub is an Electron + React desktop app for keeping several web-based messaging tools in one place. It currently includes built-in entries for Gmail, Discord, Messenger, Slack, and Teams, and it also supports adding custom web apps with your own icons. ( I'm going to be honest I just made this because I didn't like any of the options out there ) 

## Build From Source

### Requirements

- Node.js 22.12 or newer (Electron 44's installer requires it)
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

This starts the Vite dev server and launches Electron against it. Development runs use their own profile (`%APPDATA%\Comms Hub Dev` on Windows), so they never touch the installed app's settings or sign-ins and can run next to it:

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

These runs also use a profile of their own (`%APPDATA%\Comms Hub Local` on Windows). The installed app encrypts its cookies and plain Electron does not, so opening the installed app's profile would delete those cookies and sign you out of every app. Because the profiles differ, `npm start` runs next to the installed app instead of handing over to it.

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

This repo includes a GitHub Actions workflow at [.github/workflows/build-installers.yml](.github/workflows/build-installers.yml) that:

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
- saved app configuration (`comms-app-config.json`)
- uploaded custom icons (a replaced icon is deleted once no app uses it)
- persistent Chromium session data for embedded services

Runs from source use `%APPDATA%\Comms Hub Dev` (`npm run dev`) or `%APPDATA%\Comms Hub Local` (`npm start`) instead.

If the settings file is ever damaged, Comms Hub moves it aside as `comms-app-config.corrupt-<timestamp>.json` and starts from defaults, so nothing is lost. Notification history is kept in memory only.

Packaged builds encrypt cookies with the operating system's key store. Upgrading keeps existing sign-ins; going back to 1.3.0 or an earlier release may sign you out of the embedded apps.

## Using Comms Hub

### Keyboard And Mouse

Shortcuts work in the main window, the dock bubble and inside every app. On macOS use Cmd instead of Ctrl.

| Shortcut | Action |
| --- | --- |
| Ctrl+1 … Ctrl+9 | Select the first … ninth visible app |
| Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PageDown / Ctrl+PageUp | Next / previous app |
| Ctrl+R or F5 / Ctrl+Shift+R | Reload the selected app / reload it without the cache |
| Ctrl+= / Ctrl+- / Ctrl+0, Ctrl+mouse wheel | Zoom the selected app (saved per app) / reset zoom |
| Ctrl+F | Find in the selected app; typing goes to the find bar and Esc returns to the page (a collapsed dock expands first) |
| Alt+Left / Alt+Right, mouse back/forward buttons | Back / forward in the selected app |
| Ctrl+Shift+I or F12 | Developer tools for the selected app |
| Ctrl+, | Show or hide the settings sidebar |

Ctrl+W does nothing, so it can't close the app by accident. There is no menu bar on Windows and Linux.

In a window narrower than 1000 px the settings sidebar starts hidden, so the app keeps enough room. The settings button on the rail shows it for that session without changing the saved setting.

Right-click inside an app for spelling suggestions, cut/copy/paste (including paste as plain text), copying or opening links, copying or saving images, back/forward/reload and Inspect. Right-click an app in the rail to reload it, put it to sleep, keep it loaded, turn its desktop alerts on or off, edit it, open it in your browser, reset its remembered site permissions (shown only when it has some), or remove it (built-in apps are hidden instead). In dock mode, Edit… expands the dock and opens the editor in the bubble.

### Links, Pop-ups And Downloads

- Links to other sites open in your default browser. Web, `mailto:` and `tel:` links open directly; links to known desktop apps (Teams, Slack, Discord, Zoom and similar) ask first and show the address; `file:`, `javascript:` and other risky schemes are blocked; anything unknown asks with Cancel as the default.
- Pop-ups from the same site (Gmail's pop-out compose, Discord pop-outs) and Google/Microsoft sign-in windows open in their own Comms Hub window with the app's sign-in. An app with an open pop-up isn't put to sleep by the memory saver. A pop-up's notifications count for its app, and clicking one brings the pop-up forward.
- Pop-ups always open as normal windows, on the screen you're using: a page can't make one frameless, always on top, full screen, see-through, hidden from the taskbar or impossible to close, or move it off screen. Each app can have 5 pop-ups open at once and open 10 per 30 seconds; past that, a link it tries to pop out opens in your browser instead and an empty pop-up (such as a new compose window) doesn't open. An empty pop-up filled by embedded content from another site (an ad, for example) is closed at once.
- Downloads go straight to your Downloads folder under a unique name, with progress on the taskbar and a notification you can click to show the file in its folder. A failed download shows a "Download failed" notification and clears the taskbar progress; that includes a download whose connection drops partway (reported once it has been stuck for 10 seconds; the partial file is removed). Turn on "Ask where to save downloads" in settings to get the Save As dialog instead.
- A custom app needs an http:// or https:// address (a bare `outlook.com` gets https://). Local network names such as `http://nas:5000` are accepted, with a reminder to check the address.
- Removing a custom app asks first, and can also delete its sign-in data, cache and uploaded icon. Built-in apps can only be hidden. If removing (or saving) fails in the Add/Edit dialog, the error is shown in the dialog.

### Notifications

Each web notification shows one desktop notification, if "Desktop notifications" is on in settings and "Desktop alerts" is on for that app. Only pages on the app's own site can notify; embedded content from other sites, or another site the app has moved to, can't. A notification's title starts with the app's name ("Slack: New message") unless it already is the name or starts with "Slack:", and titles are shown on one line. If one app sends more than 5 within 30 seconds, the extra ones are folded into a single "N more notifications" notification. Clicking a notification opens Comms Hub, selects the app and passes the click to the page so it can open the conversation. Rail badges show the app's unread count when it has one, otherwise the notifications you haven't seen since you last opened the app; the tray tooltip shows the total.

When no Comms Hub window is visible (in the tray, or with the dock collapsed), error messages such as a blocked link appear as a desktop notification instead, if "Desktop notifications" is on.

Upgrading from 1.x: an app whose desktop alerts were off but still showed the site's own notifications gets its desktop alerts turned back on, because Comms Hub's notification is now the only one. Other settings, including the global switch, are kept.

### Camera, Microphone And Screen Sharing

- An app's own site can use the camera and microphone. Pages from any other site ask with Allow, Block or Not now, unless you remembered an answer for that site; this includes a site the app itself has moved to and pages in its pop-ups. An app's own site is the site of its address and of the page that address leads to, plus a built-in app's known sister sites (such as teams.live.com for Teams). Sites are compared using the public suffix list, so two different `github.io` sites are not the same site. Allow or Block is remembered for that app and site when "Remember for this app" is ticked (it is by default); Not now (also Enter, Esc or closing the prompt) is never remembered. To forget remembered answers, right-click the app in the rail and choose "Reset site permissions".
- Screen sharing always opens a picker of screens and windows; nothing is shared until you choose. Comms Hub enforces this itself, so a page can't capture without it, and a pick is used once. When the request comes from a page outside the app's own site, the picker names that site. Each window shows one picker at a time; other requests wait their turn, and an unanswered picker closes after 2 minutes. On Windows the picker offers "Also share system audio" (unchecked every time); it is added only when the app asked for audio.

### Memory Controls

The selected app and apps set to "Keep alive" stay loaded. With the memory saver on, other apps sleep after 5, 10 (default), 15, 30 or 60 minutes unless you're in the middle of writing something, on a call, or playing media. Turning the saver off keeps visited apps loaded. "Sleep now" frees any loaded app except the selected one at once; a kept-alive app put to sleep stays asleep until you select it. If the app has pop-out windows open, "Sleep now" asks first: "Close windows and sleep" closes them, and if one won't close (for example, it holds an unsent message) the app stays awake and you're told it can't sleep right now. Settings shows each app's memory use; the This App section also shows the selected app's CPU. When Comms Hub starts in dock mode, the full window isn't loaded until you first open it ("Open full app" in the tray, dock or bubble); after switching from the full window to dock mode, the hidden full window is unloaded after a minute and reloads when you open it again (your apps stay loaded). Sign-ins are kept while an app sleeps; it reloads when selected and doesn't receive notifications while asleep.

Each app keeps its own sign-in. The bubble size is saved for the whole app; the 50–200% zoom is saved per app.

### Window, Tray And Startup

- Closing the main window quits Comms Hub. Turn on "Keep running in tray when closed" in settings to keep it running in the tray instead.
- "Launch at login" starts Comms Hub with Windows, hidden in the tray (in dock mode, as the collapsed dock button); "Start minimized" does the same for every launch.
- Only one copy runs at a time; opening it again brings the existing window forward.
- If one of Comms Hub's own windows crashes, it reloads itself, up to 3 times a minute.
- An app that fails to load because of a network problem tries again by itself, and again as soon as the network is back or the PC wakes up.
- The main window remembers its size, position and maximized state (minimum 800×560) and moves back on screen if a monitor was disconnected.
- The tray menu has Open full app, Enter dock mode (or Show dock), and Quit Comms Hub.

### Platform Support

Linux builds and runtime support are temporarily disabled while startup behavior is being repaired.

### Verification

Run `npm run smoke` for the renderer build and unit checks, then `npm run test:electron` on Windows for native lifecycle and production-renderer integration checks. The integration suite uses temporary profiles and local synthetic pages.

## Things I might add in the future

------

- animations
- agregated message center (don't hold your breath on this one)
