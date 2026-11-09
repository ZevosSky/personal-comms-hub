import { useEffect, useRef, useState } from "react";
import { invokeBridge, sendBridge } from "../lib/bridge.js";
import { useBridgeEvent } from "../hooks/useBridgeEvent.js";
import { Icon } from "./Icon.jsx";

const SEARCH_DELAY_MS = 180;

// Find-in-page strip. Rendered above the service viewport (never over it), so the reported
// viewport shrinks while it is open. `focusToken` changes re-focus the input (Ctrl+F again).
//
// Bridge contract: `findNext: true` steps to the next/previous match of the current text
// (Enter / Shift+Enter); false (the default) starts a new search. Main maps this onto
// Electron's own option, which has the opposite meaning.
export function FindBar({ serviceName, focusToken, onClose }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);
  const latestRequest = useRef(null);
  const searchedText = useRef("");
  const timer = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      sendBridge("stopFindInPage");
    },
    []
  );

  useBridgeEvent("onFindResult", (payload) => {
    if (!payload || !searchedText.current) return;
    const { requestId } = payload;
    if (latestRequest.current !== null && Number(requestId) < Number(latestRequest.current)) return;
    setResult({
      active: Number(payload.activeMatchOrdinal) || 0,
      matches: Number(payload.matches) || 0,
      final: payload.finalUpdate !== false
    });
  });

  const search = async (query, { forward = true, newSession = true } = {}) => {
    clearTimeout(timer.current);
    searchedText.current = query;
    if (!query) {
      latestRequest.current = null;
      setResult(null);
      sendBridge("stopFindInPage");
      return;
    }
    try {
      const requestId = await invokeBridge("findInPage", query, { forward, findNext: !newSession });
      if (requestId !== null && requestId !== undefined) latestRequest.current = requestId;
      else if (newSession) setResult({ active: 0, matches: 0, final: true });
    } catch {
      setResult(null);
    }
  };

  const onChange = (event) => {
    const value = event.target.value;
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => search(value), SEARCH_DELAY_MS);
  };

  const step = (forward) => {
    if (!text) return;
    search(text, { forward, newSession: searchedText.current !== text });
  };

  const close = () => {
    clearTimeout(timer.current);
    onClose();
  };

  const noMatches = Boolean(text) && result?.final && result.matches === 0;
  const counter = !text || !result ? "" : result.matches ? `${result.active}/${result.matches}` : "No results";

  return (
    <div
      className="find-bar"
      role="search"
      aria-label={`Find in ${serviceName || "app"}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <Icon name="search" size={14} className="find-icon" />
      <input
        ref={inputRef}
        type="text"
        className={`find-input ${noMatches ? "no-matches" : ""}`}
        value={text}
        placeholder={`Find in ${serviceName || "app"}`}
        aria-label={`Find in ${serviceName || "app"}`}
        spellCheck={false}
        onChange={onChange}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(!event.shiftKey);
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {counter}
      </span>
      <button type="button" className="find-button" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!text} onClick={() => step(false)}>
        <Icon name="up" size={14} />
      </button>
      <button type="button" className="find-button" aria-label="Next match" title="Next (Enter)" disabled={!text} onClick={() => step(true)}>
        <Icon name="down" size={14} />
      </button>
      <button type="button" className="find-button" aria-label="Close find bar" title="Close (Esc)" onClick={close}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
