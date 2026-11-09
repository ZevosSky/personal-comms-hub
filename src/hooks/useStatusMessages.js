import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBridgeEvent } from "./useBridgeEvent.js";

const INFO_MS = 4000;
const ERROR_MS = 10000;
const MAX_MESSAGES = 4;

// Short-lived status messages. Info auto-dismisses after ~4 s; errors stay up to ~10 s or until
// dismissed and take priority over info while visible.
export function useStatusMessages({ listenToMain = true } = {}) {
  const [messages, setMessages] = useState([]);
  const timers = useRef(new Map());
  const nextId = useRef(0);

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const notify = useCallback(
    (text, tone = "info") => {
      const value = String(text ?? "").trim().slice(0, 300);
      if (!value) return;
      const normalizedTone = tone === "error" ? "error" : "info";
      nextId.current += 1;
      const id = nextId.current;
      setMessages((current) => {
        const kept = current.filter((message) => {
          const duplicate = message.text === value && message.tone === normalizedTone;
          if (duplicate) {
            clearTimeout(timers.current.get(message.id));
            timers.current.delete(message.id);
          }
          return !duplicate;
        });
        return [...kept, { id, text: value, tone: normalizedTone }].slice(-MAX_MESSAGES);
      });
      timers.current.set(id, setTimeout(() => dismiss(id), normalizedTone === "error" ? ERROR_MS : INFO_MS));
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useBridgeEvent(
    "onStatusMessage",
    (payload) => {
      const text = typeof payload === "string" ? payload : payload?.text;
      notify(text, payload?.tone === "error" ? "error" : "info");
    },
    listenToMain
  );

  const current = useMemo(() => {
    const errors = messages.filter((message) => message.tone === "error");
    return errors.length ? errors[errors.length - 1] : messages[messages.length - 1] ?? null;
  }, [messages]);

  return { current, notify, dismiss };
}
