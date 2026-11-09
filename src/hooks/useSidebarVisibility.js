import { useState, useSyncExternalStore } from "react";

// Below this width the settings sidebar leaves the app too little room (pages switch to their
// phone layout), so it starts hidden there.
const NARROW_QUERY = "(width < 1000px)";

let narrowQuery;
const getNarrowQuery = () => {
  if (narrowQuery === undefined) {
    narrowQuery = typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
  }
  return narrowQuery;
};

const subscribe = (onChange) => {
  const query = getNarrowQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
};

const isNarrow = () => getNarrowQuery()?.matches ?? false;

// Settings sidebar of the full window. Wide windows follow the saved preference
// (ui.sidebarCollapsed). Narrow windows start with it hidden and the rail button opens/closes it
// for this session only; a change of the saved preference (main's Ctrl+,) counts as that toggle
// too. Once the window is wide again the saved preference applies again.
export function useSidebarVisibility(collapsed, setCollapsed) {
  const savedOpen = !collapsed;
  const narrow = useSyncExternalStore(subscribe, isNarrow);
  const [session, setSession] = useState({ narrow, savedOpen, open: false });

  let sessionOpen = session.open;
  if (session.narrow !== narrow || session.savedOpen !== savedOpen) {
    // Becoming narrow starts hidden; a preference change while staying narrow toggles.
    sessionOpen = narrow && session.narrow ? !session.open : false;
    setSession({ narrow, savedOpen, open: sessionOpen });
  }

  return {
    open: narrow ? sessionOpen : savedOpen,
    toggle: () => {
      if (narrow) setSession((current) => ({ ...current, open: !current.open }));
      else setCollapsed(savedOpen);
    }
  };
}
