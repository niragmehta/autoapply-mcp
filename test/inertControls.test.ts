import { describe, expect, it } from "vitest";
import { inertControlIndexes } from "../src/submission/inertControls.js";

type ButtonSpec = {
  text?: string;
  disabled?: boolean;
  inheritedDisabled?: boolean;
  ariaDisabled?: boolean;
  rendered?: boolean;
  display?: string;
};
type ControlSpec = {
  type?: string;
  display?: string;
  visibility?: string;
  disabled?: boolean;
  readOnly?: boolean;
  ariaDisabled?: boolean;
  wrapper?: "old" | "fieldset";
  buttons?: ButtonSpec[];
};

function pageFor(control: ControlSpec) {
  const buttons = (control.buttons ?? []).map((button) => ({
    innerText: button.text ?? "Yes",
    disabled: button.disabled ?? false,
    display: button.display ?? "block",
    visibility: "visible",
    getClientRects: () => button.rendered === false ? [] : [{}],
    matches: (selector: string) => selector === ":disabled" && (button.disabled === true || button.inheritedDisabled === true),
    getAttribute: (key: string) => key === "aria-disabled" && button.ariaDisabled ? "true" : null,
  }));
  const entry = { querySelectorAll: () => buttons };
  const element = {
    type: control.type ?? "checkbox",
    disabled: control.disabled ?? false,
    readOnly: control.readOnly ?? false,
    display: control.display ?? "block",
    visibility: control.visibility ?? "visible",
    getAttribute: (key: string) => key === "aria-disabled" && control.ariaDisabled ? "true" : null,
    closest: (selector: string) => (
      control.wrapper === "old" && selector === ".ashby-application-form-field-entry"
    ) || (
      control.wrapper === "fieldset" && selector === 'fieldset[class*="_fieldEntry_"]'
    ) ? entry : null,
  };
  return {
    async evaluate(script: string): Promise<unknown> {
      return new Function("document", "window", `return ${script}`)(
        { querySelector: () => element },
        { getComputedStyle: (node: { display: string; visibility: string }) => node },
      );
    },
  };
}

describe("inertControlIndexes", () => {
  it.each(["old", "fieldset"] as const)("retains an unanswered Ashby boolean with visible %s buttons", async (wrapper) => {
    const page = pageFor({ display: "none", wrapper, buttons: [{ text: "Yes" }, { text: "No" }] });
    expect([...await inertControlIndexes(page, [0])]).toEqual([]);
  });

  it("uses active buttons rather than the backing input's readonly or disabled flags", async () => {
    const page = pageFor({ display: "none", disabled: true, readOnly: true, wrapper: "old", buttons: [{}] });
    expect([...await inertControlIndexes(page, [0])]).toEqual([]);
  });

  it("ignores a boolean when all visible choice buttons are disabled", async () => {
    const page = pageFor({ display: "none", wrapper: "old", buttons: [{ disabled: true }, { text: "No", ariaDisabled: true }] });
    expect([...await inertControlIndexes(page, [0])]).toEqual([0]);
  });

  it("still ignores a genuinely hidden conditional question", async () => {
    const page = pageFor({ display: "none", wrapper: "old", buttons: [{ rendered: false }] });
    expect([...await inertControlIndexes(page, [0])]).toEqual([0]);
  });

  it("respects disabled state inherited from a fieldset", async () => {
    const page = pageFor({ display: "none", wrapper: "fieldset", buttons: [{ inheritedDisabled: true }] });
    expect([...await inertControlIndexes(page, [0])]).toEqual([0]);
  });

  it("does not count a hidden choice button as interactive", async () => {
    const page = pageFor({ display: "none", wrapper: "old", buttons: [{ display: "none" }] });
    expect([...await inertControlIndexes(page, [0])]).toEqual([0]);
  });

  it("does not mistake an unrelated button for a Yes/No choice", async () => {
    const page = pageFor({ display: "none", wrapper: "old", buttons: [{ text: "Delete" }] });
    expect([...await inertControlIndexes(page, [0])]).toEqual([0]);
  });

  it.each([{ disabled: true }, { readOnly: true }, { ariaDisabled: true }, { display: "none" }])(
    "preserves inactive native controls: %j",
    async (control) => expect([...await inertControlIndexes(pageFor({ ...control, type: "select-one" }), [0])]).toEqual([0]),
  );

  it("retains visible native controls", async () => {
    expect([...await inertControlIndexes(pageFor({}), [0])]).toEqual([]);
  });

  it("fails closed when the DOM cannot be evaluated", async () => {
    const page = { evaluate: async () => { throw new Error("Page closed"); } };
    expect([...await inertControlIndexes(page, [0])]).toEqual([]);
  });

  it("does not inspect the page when no controls need checking", async () => {
    const page = { evaluate: async () => { throw new Error("Must not be called"); } };
    expect([...await inertControlIndexes(page, [])]).toEqual([]);
  });

  it("retains blockers when the page returns an invalid result", async () => {
    expect([...await inertControlIndexes({ evaluate: async () => ({ invalid: true }) }, [0])]).toEqual([]);
  });

  it("ignores nonnumeric indexes in the page result", async () => {
    expect([...await inertControlIndexes({ evaluate: async () => [0, "1"] }, [0, 1])]).toEqual([0]);
  });
});
