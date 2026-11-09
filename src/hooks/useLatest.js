import { useLayoutEffect, useRef } from "react";

// Ref that always holds the latest value, for stable callbacks/subscriptions.
export function useLatest(value) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
