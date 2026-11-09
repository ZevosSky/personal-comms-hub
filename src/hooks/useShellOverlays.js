import { useEffect, useState } from "react";
import { hasBridgeMethod } from "../lib/bridge.js";
import { useBridgeEvent } from "./useBridgeEvent.js";

// Dialogs and the find bar shared by the full and bubble windows (the windows that host a
// service view): Add/Edit modal, screen-share picker, find-in-page.
export function useShellOverlays({ appState, activeServiceId, actions, run }) {
  const [modal, setModal] = useState(null);
  // Screen-share requests in arrival order; the first is shown. Main sends one per window at a
  // time, but a newer one never silently replaces the one the user is looking at.
  const [shareQueue, setShareQueue] = useState([]);
  const shareRequest = shareQueue[0] ?? null;
  const [findOpen, setFindOpen] = useState(false);
  const [findToken, setFindToken] = useState(0);
  const canFind = hasBridgeMethod("findInPage");
  const services = appState?.services ?? [];
  const find = (id) => services.find((service) => service.id === id) ?? null;

  const openCreate = () => {
    const globe = appState?.iconLibrary?.find((icon) => icon.key === "globe")?.iconSource ?? "";
    setModal((current) => ({
      key: (current?.key ?? 0) + 1,
      form: { id: null, name: "", url: "", iconSource: globe, iconKey: "globe", isEnabled: true }
    }));
  };

  const openEdit = (serviceId) => {
    const service = find(serviceId);
    if (!service) return;
    setModal((current) => ({
      key: (current?.key ?? 0) + 1,
      form: {
        id: service.id,
        name: service.name,
        url: service.url,
        iconSource: service.iconSource,
        iconKey: service.iconKey ?? "globe",
        isEnabled: service.isEnabled
      }
    }));
  };

  const closeModal = () => setModal(null);

  const saveForm = async (form) => {
    const existing = find(form.id);
    const hiding = Boolean(existing?.isEnabled && !form.isEnabled);
    const payload = { ...existing, ...form };
    if (hiding) payload.keepAliveInBackground = false;
    const message = !existing
      ? `Added ${form.name}.`
      : hiding
        ? `Hid ${form.name} on this device.`
        : `Saved ${form.name}.`;
    // The dialog shows failures itself; its backdrop covers the status area.
    const result = await actions.saveService(payload, message, { quiet: true });
    if (result.ok) setModal(null);
    return result;
  };

  const removeFromModal = async () => {
    if (!modal?.form?.id) return undefined;
    const result = await actions.removeService(modal.form.id, { quiet: true });
    if (result.ok) setModal(null);
    return result;
  };

  // The service being edited disappeared (removed elsewhere).
  const editingMissing = Boolean(modal?.form?.id && appState && !find(modal.form.id));
  useEffect(() => {
    if (editingMissing) setModal(null);
  }, [editingMissing]);

  useEffect(() => {
    setFindOpen(false);
  }, [activeServiceId]);

  const openFind = () => {
    if (!canFind || !activeServiceId) return;
    setFindOpen(true);
    setFindToken((token) => token + 1);
  };

  useBridgeEvent("onFindRequested", openFind);
  useBridgeEvent("onEditServiceRequested", (payload) => {
    const serviceId = typeof payload === "string" ? payload : payload?.serviceId;
    if (serviceId) openEdit(serviceId);
  });
  useBridgeEvent("onScreenShareRequest", (request) => {
    if (request?.requestId === undefined || request?.requestId === null) return;
    setShareQueue((queue) =>
      queue.some((item) => item.requestId === request.requestId)
        ? queue.map((item) => (item.requestId === request.requestId ? request : item))
        : [...queue, request]
    );
  });
  useBridgeEvent("onScreenShareCancelled", (payload) => {
    setShareQueue((queue) =>
      payload?.requestId === undefined ? [] : queue.filter((item) => item.requestId !== payload.requestId)
    );
  });

  const respondToShare = async ({ sourceId, shareAudio }) => {
    const request = shareRequest;
    if (!request) return;
    setShareQueue((queue) => queue.filter((item) => item.requestId !== request.requestId));
    await run("respondToScreenShare", [{ requestId: request.requestId, sourceId: sourceId ?? null, shareAudio: Boolean(shareAudio) }], {
      applyResult: false,
      quiet: !sourceId,
      failure: "Couldn't start screen sharing"
    });
  };

  return {
    modal,
    openCreate,
    openEdit,
    closeModal,
    saveForm,
    removeFromModal,
    shareRequest,
    respondToShare,
    canFind,
    findOpen,
    findToken,
    openFind,
    closeFind: () => setFindOpen(false),
    obscuredBy: shareRequest ? "share" : modal ? "modal" : null
  };
}
