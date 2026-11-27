import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Select, Slot } from "radix-ui";

// Exercise the actual dependency in a browser. Replacing an unchanged ref on
// every commit can make Select's trigger-node state enter a render loop.
export function measureSlotRefs() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let attachments = 0;
    let detachments = 0;
    const forwardedRef = (node: HTMLElement | null) => {
        if (node) attachments++;
        else detachments++;
    };
    try {
        for (let index = 0; index < 100; index++) {
            flushSync(() => root.render(createElement(Slot.Root, { ref: forwardedRef },
                createElement("button", null, `Render ${index}`))));
        }
        return { attachments, detachments };
    } finally {
        flushSync(() => root.unmount());
        host.remove();
    }
}

export function measureSelectRefs() {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let attachments = 0;
    let detachments = 0;
    const itemTextRef = (node: HTMLSpanElement | null) => {
        if (node) attachments++;
        else detachments++;
    };
    try {
        for (let index = 0; index < 100; index++) {
            flushSync(() => root.render(createElement(Select.Root, { value: "all" },
                createElement(Select.Trigger, null, createElement(Select.Value)),
                createElement(Select.Content, null,
                    createElement(Select.Viewport, null,
                        createElement(Select.Item, { value: "all" },
                            createElement(Select.ItemText, { ref: itemTextRef }, "All dates")))))));
        }
        return { attachments, detachments };
    } finally {
        flushSync(() => root.unmount());
        host.remove();
    }
}
