import { useMemo } from "react";
import { getLimits } from "./lib/limits.js";
import { useAppRuntime } from "./hooks/useAppRuntime.js";
import { useServiceActions } from "./hooks/useServiceActions.js";
import { useStatusMessages } from "./hooks/useStatusMessages.js";
import { ShellMessage } from "./components/EmptyState.jsx";
import { BubbleView } from "./views/BubbleView.jsx";
import { DockView } from "./views/DockView.jsx";
import { FullView } from "./views/FullView.jsx";
import { TriggerView } from "./views/TriggerView.jsx";

const RIGHT_CORNERS = new Set(["top-right", "bottom-right"]);

// One renderer bundle serves every window; `mode` comes from the ?mode= query (full|dock|bubble|trigger).
export default function App({ mode }) {
  if (mode === "trigger") return <TriggerView />;
  return <ShellApp mode={mode} />;
}

function ShellApp({ mode }) {
  const status = useStatusMessages();
  const { appState, runtime, loadError, retryLoad, run } = useAppRuntime({ notify: status.notify });
  const actions = useServiceActions({ appState, run, notify: status.notify, mode });
  const limits = useMemo(() => getLimits(appState), [appState]);

  if (!appState) {
    if (loadError) {
      return (
        <ShellMessage
          title="Comms Hub couldn't start"
          body={loadError}
          action={
            <button type="button" className="primary-button" onClick={retryLoad}>
              Try again
            </button>
          }
        />
      );
    }
    // The dock window is transparent and 72 px wide; show nothing until state arrives.
    return mode === "dock" ? null : <ShellMessage busy title="Loading your apps…" />;
  }

  const corner = appState.ui.dockCorner ?? "bottom-left";
  const cornerClass = `${RIGHT_CORNERS.has(corner) ? "right-anchored" : "left-anchored"} ${corner}`;
  const shared = { appState, runtime, run, status, actions, limits, cornerClass };

  if (mode === "dock") return <DockView {...shared} />;
  if (mode === "bubble") return <BubbleView {...shared} />;
  return <FullView {...shared} />;
}
