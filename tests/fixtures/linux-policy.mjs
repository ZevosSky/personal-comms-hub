// Exercise the Linux capability path on Windows CI too; this does not emulate a Linux desktop.
process.env.COMMS_TEST_LINUX = "1";
await import("./app-shell.mjs");
