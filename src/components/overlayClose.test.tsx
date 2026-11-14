import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmShutdownDialog } from "./ConfirmShutdownDialog";
import { render } from "../testing/render";

const fire = (el: Element, type: "mousedown" | "click") => act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true })));

describe("dialog overlay close", () => {
  function setup() {
    const onClose = vi.fn();
    render(<ConfirmShutdownDialog open onClose={onClose} onConfirm={() => {}} title="Shut down" description="d" />);
    const overlay = document.querySelector(".modal-overlay")!;
    const sheet = overlay.querySelector(".modal-sheet")!;
    return { onClose, overlay, sheet };
  }

  it("closes when the press and release are both on the overlay", () => {
    const { onClose, overlay } = setup();
    fire(overlay, "mousedown");
    fire(overlay, "click");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when a text selection starts in the dialog and is released on the overlay", () => {
    const { onClose, overlay, sheet } = setup();
    fire(sheet, "mousedown");
    fire(overlay, "click");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("confirms without a typed phrase or acknowledgement checkbox", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmShutdownDialog
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        title="Shut down"
        description="d"
      />
    );
    const confirm = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Shut down")
    ) as HTMLButtonElement | undefined;
    expect(confirm).toBeTruthy();
    expect(confirm!.disabled).toBe(false);
    await act(async () => {
      fire(confirm!, "click");
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
