import { useLayoutEffect, useRef, useState } from "react";
import { describeRailService, formatBadgeCount, getServiceCondition } from "../lib/format.js";
import { dropAmongVisible, moveAmongVisible } from "../lib/order.js";

const DOT_CONDITIONS = new Set(["loading", "error", "offline"]);

// App switcher used by the full rail and the dock rail: status cues, unread badges, roving focus
// (ArrowUp/ArrowDown/Home/End), Alt+ArrowUp/Down and drag-and-drop reordering, right-click menu.
export function RailServiceList({
  services,
  allIds,
  activeId,
  runtimeServices = {},
  badges = {},
  variant = "full",
  className = "",
  onSelect,
  onReorder,
  onContextMenu
}) {
  const visibleIds = services.map((service) => service.id);
  const orderKey = visibleIds.join("\u0000");
  const [focusId, setFocusId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const dragged = useRef(null);
  const buttons = useRef(new Map());
  const pendingFocus = useRef(null);

  const rovingId = visibleIds.includes(focusId)
    ? focusId
    : visibleIds.includes(activeId)
      ? activeId
      : visibleIds[0];

  // After a keyboard reorder, keep focus on the moved app once the new order arrives.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || pending.orderKey === orderKey) return;
    pendingFocus.current = null;
    const button = buttons.current.get(pending.id);
    if (button && document.activeElement !== button) button.focus();
  }, [orderKey]);

  const focusAt = (index) => {
    const id = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, index))];
    if (!id) return;
    setFocusId(id);
    buttons.current.get(id)?.focus();
  };

  const onKeyDown = (event, id) => {
    const index = visibleIds.indexOf(id);
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (event.altKey && vertical) {
      event.preventDefault();
      const next = moveAmongVisible(allIds, visibleIds, id, event.key === "ArrowUp" ? -1 : 1);
      if (next) {
        const pending = { id, orderKey };
        pendingFocus.current = pending;
        setTimeout(() => {
          if (pendingFocus.current === pending) pendingFocus.current = null;
        }, 2000);
        onReorder(next);
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowUp") focusAt(index - 1);
    else if (event.key === "ArrowDown") focusAt(index + 1);
    else if (event.key === "Home") focusAt(0);
    else if (event.key === "End") focusAt(visibleIds.length - 1);
    else return;
    event.preventDefault();
  };

  const clearDrag = () => {
    dragged.current = null;
    setDraggingId(null);
    setDropTarget(null);
  };

  const dragHandlers = (id) => ({
    draggable: true,
    onDragStart: (event) => {
      dragged.current = id;
      setDraggingId(id);
      event.dataTransfer.effectAllowed = "move";
      try {
        // A private type: text/plain would be typed into a page's editor if dropped there.
        event.dataTransfer.setData("application/x-comms-hub-service", id);
      } catch {
        // Some drag sources disallow custom data; the ref carries the id.
      }
    },
    onDragOver: (event) => {
      const source = dragged.current;
      if (!source) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      const changes = dropAmongVisible(allIds, visibleIds, source, id, position) !== null;
      event.dataTransfer.dropEffect = changes ? "move" : "none";
      const next = changes ? { id, position } : null;
      setDropTarget((current) =>
        current?.id === next?.id && current?.position === next?.position ? current : next
      );
    },
    onDrop: (event) => {
      event.preventDefault();
      const source = dragged.current;
      const rect = event.currentTarget.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
      clearDrag();
      if (!source) return;
      const next = dropAmongVisible(allIds, visibleIds, source, id, position);
      if (next) onReorder(next);
    },
    onDragEnd: clearDrag
  });

  return (
    <div
      className={className}
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Apps"
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
      }}
    >
      {services.map((service) => {
        const runtime = runtimeServices[service.id];
        const badge = badges[service.id] ?? { count: 0, kind: "alerts" };
        const isActive = service.id === activeId;
        const condition = getServiceCondition(service, runtime);
        const label = describeRailService(service, runtime, badge, { isActive });
        const drop = dropTarget?.id === service.id ? dropTarget.position : null;
        return (
          <button
            key={service.id}
            ref={(element) => {
              if (element) buttons.current.set(service.id, element);
              else buttons.current.delete(service.id);
            }}
            type="button"
            className={[
              variant === "dock" ? "dock-rail-button" : "rail-icon-button",
              isActive ? "active" : "",
              `is-${condition}`,
              draggingId === service.id ? "is-dragging" : "",
              drop ? `drop-${drop}` : ""
            ]
              .filter(Boolean)
              .join(" ")}
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            title={label}
            tabIndex={service.id === rovingId ? 0 : -1}
            onFocus={() => setFocusId(service.id)}
            onClick={() => onSelect(service.id)}
            onKeyDown={(event) => onKeyDown(event, service.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              onContextMenu?.(service.id);
            }}
            {...dragHandlers(service.id)}
          >
            <span className="service-icon-wrap">
              <img src={service.iconSource} alt="" className="service-icon" draggable={false} />
              {badge.count ? (
                <span className={`badge-pill ${badge.kind === "alerts" ? "is-alerts" : ""}`} aria-hidden="true">
                  {formatBadgeCount(badge.count)}
                </span>
              ) : null}
              {DOT_CONDITIONS.has(condition) ? (
                <span className={`status-dot dot-${condition}`} aria-hidden="true" />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
