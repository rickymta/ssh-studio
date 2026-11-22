// In-app replacements for the WebView / OS popups: confirmation dialogs (instead of the
// native `confirm` of tauri-plugin-dialog) and the right-click menu (instead of the WebView
// context menu with Back / Reload / Print…). Native file pickers stay native.
import React, { useEffect, useRef, useState } from "react";
import {
  CircleAlert,
  ClipboardPaste,
  Copy,
  Info,
  Scissors,
  TextSelect,
  TriangleAlert,
} from "lucide-react";
import { readClipboard, writeClipboard } from "../lib.js";

let enqueue = null;
const waiting = [];
let nextId = 0;

/**
 * Asks a yes/no question in an in-app dialog. Resolves `true` only when the user confirms;
 * Escape, the Cancel button and clicking outside resolve `false`.
 *
 * kind: "info" | "warning" | "danger" (danger = destructive, red confirm button).
 */
export function confirm(
  message,
  { title = "Xác nhận", kind = "warning", okLabel, cancelLabel = "Hủy" } = {},
) {
  return new Promise((resolve) => {
    const item = {
      id: ++nextId,
      message,
      title,
      kind,
      okLabel: okLabel || (kind === "danger" ? "Xóa" : "Đồng ý"),
      cancelLabel,
      resolve,
    };
    if (enqueue) enqueue(item);
    else waiting.push(item);
  });
}

/**
 * Asks for one line of text (a folder name…). Resolves the trimmed text, or `null` when
 * cancelled. `validate(text)` may return an error message that keeps the dialog open.
 */
export function ask({
  title,
  message = "",
  label = "Tên",
  value = "",
  placeholder = "",
  okLabel = "Lưu",
  maxLength = 60,
  validate,
}) {
  return new Promise((resolve) => {
    const item = {
      id: ++nextId,
      prompt: true,
      title,
      message,
      label,
      value,
      placeholder,
      okLabel,
      maxLength,
      validate,
      resolve,
    };
    if (enqueue) enqueue(item);
    else waiting.push(item);
  });
}

function PromptDialog({ item, answer }) {
  const [text, setText] = useState(item.value);
  const [error, setError] = useState("");
  const input = useRef();
  useEffect(() => {
    const prior = document.activeElement;
    input.current?.select();
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        answer(null);
      } else if (!e.target.closest?.(".confirm-dialog")) e.stopPropagation();
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      if (prior?.isConnected) prior.focus();
    };
  }, [item.id]);
  const submit = (e) => {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    const problem = item.validate?.(value);
    if (problem) return setError(problem);
    answer(value);
  };
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(null);
      }}
    >
      <form
        className="confirm-dialog prompt-dialog info"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`prompt-title-${item.id}`}
        onSubmit={submit}
      >
        <div className="prompt-body">
          <h2 id={`prompt-title-${item.id}`}>{item.title}</h2>
          {item.message && <p>{item.message}</p>}
          <label className="field">
            <span>{item.label}</span>
            <input
              ref={input}
              value={text}
              maxLength={item.maxLength}
              placeholder={item.placeholder}
              onChange={(e) => {
                setText(e.target.value);
                setError("");
              }}
            />
          </label>
          {error && <div className="inline-error">{error}</div>}
        </div>
        <div className="confirm-actions">
          <button className="button" type="button" onClick={() => answer(null)}>
            Hủy
          </button>
          <button className="button primary" type="submit" disabled={!text.trim()}>
            {item.okLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

const icons = { info: Info, warning: TriangleAlert, danger: CircleAlert };

function ConfirmDialog({ item, answer }) {
  const ref = useRef();
  const cancel = useRef();
  const ok = useRef();
  useEffect(() => {
    const prior = document.activeElement;
    // Destructive questions start on Cancel so a stray Enter never deletes anything.
    (item.kind === "info" ? ok : cancel).current?.focus();
    // Capture phase on document: runs before the bubbling handlers of the modal underneath
    // (an editor asking "discard changes?" must not also receive this Escape).
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        answer(false);
      } else if (e.key === "Tab") {
        e.stopPropagation();
        const list = [cancel.current, ok.current];
        const index = list.indexOf(document.activeElement);
        e.preventDefault();
        // Two buttons: Tab and Shift+Tab both move to the other one.
        list[(index + 1) % 2]?.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.stopPropagation();
        e.preventDefault();
        (document.activeElement === ok.current ? cancel : ok).current?.focus();
      } else if (!ref.current?.contains(e.target)) {
        // Keys meant for the app behind (terminal, shortcuts) are ignored while asking.
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      if (prior?.isConnected) prior.focus();
    };
  }, [item.id]);
  const Icon = icons[item.kind] || Info;
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(false);
      }}
    >
      <section
        ref={ref}
        className={`confirm-dialog ${item.kind}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`confirm-title-${item.id}`}
        aria-describedby={`confirm-message-${item.id}`}
      >
        <div className="confirm-body">
          <span className="confirm-icon">
            <Icon size={22} />
          </span>
          <div>
            <h2 id={`confirm-title-${item.id}`}>{item.title}</h2>
            <p id={`confirm-message-${item.id}`}>{item.message}</p>
          </div>
        </div>
        <div className="confirm-actions">
          <button
            ref={cancel}
            className="button"
            type="button"
            onClick={() => answer(false)}
          >
            {item.cancelLabel}
          </button>
          <button
            ref={ok}
            className={`button ${item.kind === "danger" ? "danger-solid" : "primary"}`}
            type="button"
            onClick={() => answer(true)}
          >
            {item.okLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Mount once near the root; shows queued `confirm()` questions one at a time. */
export function DialogHost() {
  const [queue, setQueue] = useState([]);
  useEffect(() => {
    enqueue = (item) => setQueue((old) => [...old, item]);
    waiting.splice(0).forEach(enqueue);
    return () => {
      enqueue = null;
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const Dialog = current.prompt ? PromptDialog : ConfirmDialog;
  return (
    <Dialog
      key={current.id}
      item={current}
      answer={(value) => {
        setQueue((old) => old.filter((q) => q.id !== current.id));
        current.resolve(value);
      }}
    />
  );
}

const editable = (el) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement &&
    ![
      "checkbox",
      "radio",
      "button",
      "submit",
      "range",
      "color",
      "file",
    ].includes(el.type));

// React tracks input values itself; setting `.value` directly is ignored unless the native
// setter is used and an input event is fired.
function insertText(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const value = el.value.slice(0, start) + text + el.value.slice(end);
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + text.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {}
}

/**
 * Replaces the WebView context menu everywhere. Text fields get Cut / Copy / Paste / Select
 * all, selected page text gets Copy, everything else gets no menu. Elements that handle
 * `contextmenu` themselves (the terminal) call preventDefault and are left alone.
 */
export function ContextMenuHost() {
  const [menu, setMenu] = useState(null);
  const ref = useRef();
  useEffect(() => {
    const open = (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const target = e.target;
      const field = editable(target) && !target.disabled ? target : null;
      const selection = field
        ? ""
        : String(window.getSelection?.() || "").trim();
      if (!field && !selection) return setMenu(null);
      if (field) field.focus();
      setMenu({ x: e.clientX, y: e.clientY, field, selection });
    };
    const close = () => setMenu(null);
    const key = (e) => {
      if (e.key === "Escape") close();
    };
    // Bubble phase: components that own their menu (terminal) prevent the default first.
    document.addEventListener("contextmenu", open);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("contextmenu", open);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const outside = (e) => {
      if (!ref.current?.contains(e.target)) setMenu(null);
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("scroll", outside, true);
    // Keep the menu inside the window.
    const box = ref.current?.getBoundingClientRect();
    if (box) {
      const x = Math.min(menu.x, window.innerWidth - box.width - 6);
      const y = Math.min(menu.y, window.innerHeight - box.height - 6);
      ref.current.style.left = `${Math.max(6, x)}px`;
      ref.current.style.top = `${Math.max(6, y)}px`;
    }
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("scroll", outside, true);
    };
  }, [menu]);
  if (!menu) return null;
  const { field } = menu;
  const selected = field
    ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
    : menu.selection;
  // Password fields never hand their content to the clipboard.
  const secret = field?.type === "password";
  const run = (fn) => async () => {
    setMenu(null);
    try {
      await fn();
    } catch {}
  };
  const items = field
    ? [
        {
          label: "Cắt",
          icon: Scissors,
          hint: "Ctrl+X",
          disabled: !selected || secret || field.readOnly,
          action: async () => {
            await writeClipboard(selected);
            insertText(field, "");
          },
        },
        {
          label: "Sao chép",
          icon: Copy,
          hint: "Ctrl+C",
          disabled: !selected || secret,
          action: () => writeClipboard(selected),
        },
        {
          label: "Dán",
          icon: ClipboardPaste,
          hint: "Ctrl+V",
          disabled: field.readOnly,
          action: async () => insertText(field, await readClipboard()),
        },
        { divider: true },
        {
          label: "Chọn tất cả",
          icon: TextSelect,
          hint: "Ctrl+A",
          disabled: !field.value,
          action: () => field.select(),
        },
      ]
    : [
        {
          label: "Sao chép",
          icon: Copy,
          hint: "Ctrl+C",
          action: () => writeClipboard(menu.selection),
        },
      ];
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) =>
        item.divider ? (
          <div key={index} className="context-divider" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            // Keep focus (and the selection) in the text field.
            onMouseDown={(e) => e.preventDefault()}
            onClick={run(item.action)}
          >
            <item.icon size={15} />
            <span>{item.label}</span>
            <kbd>{item.hint}</kbd>
          </button>
        ),
      )}
    </div>
  );
}
