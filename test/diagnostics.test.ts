import { afterEach, describe, expect, it, vi } from "vitest";
import { emitDiagnosticEvent, setDiagnosticEmitter } from "../src/diagnostics.js";

describe("diagnostics", () => {
  afterEach(() => {
    setDiagnosticEmitter(() => {});
  });

  it("dispatches events through the registered emitter", () => {
    const emitter = vi.fn();
    setDiagnosticEmitter(emitter);

    emitDiagnosticEvent({ type: "test_event", ok: true });

    expect(emitter).toHaveBeenCalledWith({ type: "test_event", ok: true });
  });
});
