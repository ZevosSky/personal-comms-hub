#!/usr/bin/env sh
# Run the native integration checks in a real X11 desktop, including a window manager.
# Xvfb alone does not provide reliable view layout, focus, or window placement.
set -eu

if [ "${1:-}" != "--inside-desktop" ]; then
  if [ "$#" -eq 0 ]; then
    echo "Usage: sh scripts/run-linux-desktop-tests.sh <command> [arguments...]" >&2
    exit 2
  fi
  for dependency in dbus-run-session dbus-send xvfb-run openbox wmctrl xprop dunst; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
      echo "Missing Linux desktop test dependency: $dependency" >&2
      exit 1
    fi
  done
  script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  # Do not inherit a WSL/Wayland compositor while the tests use their own X server.
  unset WAYLAND_DISPLAY
  export XDG_SESSION_TYPE=x11
  export GDK_BACKEND=x11
  exec dbus-run-session -- xvfb-run -a -s "-screen 0 1920x1080x24 -nolisten tcp" \
    sh "$script_directory/run-linux-desktop-tests.sh" --inside-desktop "$@"
fi
shift

desktop_directory=$(mktemp -d "${TMPDIR:-/tmp}/comms-hub-desktop.XXXXXX")
export XDG_RUNTIME_DIR="$desktop_directory"
chmod 700 "$XDG_RUNTIME_DIR"
window_manager_pid=
notification_daemon_pid=
cleanup() {
  command_status=$?
  trap - EXIT
  if [ -n "$notification_daemon_pid" ]; then
    kill "$notification_daemon_pid" 2>/dev/null || true
    wait "$notification_daemon_pid" 2>/dev/null || true
  fi
  if [ -n "$window_manager_pid" ]; then
    kill "$window_manager_pid" 2>/dev/null || true
    wait "$window_manager_pid" 2>/dev/null || true
  fi
  if [ "$command_status" -ne 0 ]; then
    for log_file in "$desktop_directory/openbox.log" "$desktop_directory/dunst.log"; do
      if [ -f "$log_file" ]; then cat "$log_file" >&2; fi
    done
  fi
  rm -rf -- "$desktop_directory"
  exit "$command_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

openbox --sm-disable >"$desktop_directory/openbox.log" 2>&1 &
window_manager_pid=$!
attempt=0
until wmctrl -m >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ] || ! kill -0 "$window_manager_pid" 2>/dev/null; then
    echo "The Linux test window manager did not become ready." >&2
    exit 1
  fi
  sleep 0.1
done

# Electron checks for an org.freedesktop.Notifications service before showing native toasts.
# An isolated D-Bus session has none until a notification daemon is started.
dunst -config /dev/null >"$desktop_directory/dunst.log" 2>&1 &
notification_daemon_pid=$!
attempt=0
until dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
  /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
  string:org.freedesktop.Notifications 2>/dev/null | grep -q 'boolean true'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 100 ] || ! kill -0 "$notification_daemon_pid" 2>/dev/null; then
    echo "The Linux test notification daemon did not become ready." >&2
    exit 1
  fi
  sleep 0.1
done

"$@"
