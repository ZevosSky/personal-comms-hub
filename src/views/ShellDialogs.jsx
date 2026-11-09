import { hasBridgeMethod } from "../lib/bridge.js";
import { ScreenSharePicker } from "../components/ScreenSharePicker.jsx";
import { ServiceFormModal } from "../components/ServiceFormModal.jsx";

export const obscuredCopy = (obscuredBy, shareRequest) =>
  obscuredBy === "share"
    ? {
        obscuredTitle: "Choose what to share",
        obscuredBody: `${shareRequest?.serviceName ?? "This app"} is waiting for you to pick a screen or window.`
      }
    : { obscuredTitle: "App settings are open", obscuredBody: "Your app stays loaded while this dialog is open." };

// Dialogs shown by windows that host a service view (full and bubble).
export function ShellDialogs({ appState, overlays, actions }) {
  const { modal, shareRequest } = overlays;
  const editing = modal?.form?.id ? appState.services.find((service) => service.id === modal.form.id) : null;
  return (
    <>
      {modal ? (
        <ServiceFormModal
          key={modal.key}
          initialForm={modal.form}
          isBuiltIn={Boolean(editing?.isBuiltIn)}
          iconLibrary={appState.iconLibrary ?? []}
          canUploadIcon={hasBridgeMethod("uploadIcon")}
          onClose={overlays.closeModal}
          onSave={overlays.saveForm}
          onDelete={overlays.removeFromModal}
          onUploadIcon={actions.uploadIcon}
        />
      ) : null}
      {shareRequest ? (
        <ScreenSharePicker key={String(shareRequest.requestId)} request={shareRequest} onRespond={overlays.respondToShare} />
      ) : null}
    </>
  );
}
