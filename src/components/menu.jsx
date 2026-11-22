// Action menus: the "⋯" / split-button dropdowns and the right-click menu of servers and
// folders. Same look as the text field menu of ContextMenuHost (dialogs.jsx).
//
// Items: { label, icon, onSelect, disabled, danger, checked, hint, items: [...] } or "sep".
import React, { cloneElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";

let show = null;

/** Opens a menu at (x, y). `align: "end"` puts its right edge at x instead. */
export function openMenu(x, y, items, align = "start") {
  const list = (typeof items === "function" ? items() : items).filter(Boolean);
  show?.({ x, y, items: list, align, key: Date.now() });
}
export const closeMenu = () => show?.(null);

/** onContextMenu handler opening `items` (an array or a function returning one). */
export const contextMenu = (items) => (e) => {
  e.preventDefault();
  e.stopPropagation();
  openMenu(e.clientX, e.clientY, items);
};

/** Wraps one trigger element (a button); clicking it opens `items` under it. */
export function Dropdown({ items, align = "start", children }) {
  return cloneElement(children, {
    "aria-haspopup": "menu",
    onClick: (e) => {
      e.stopPropagation();
      const box = e.currentTarget.getBoundingClientRect();
      openMenu(align === "end" ? box.right : box.left, box.bottom + 4, items, align);
    },
  });
}

/** Places a fixed menu at (x, y), kept inside the window. */
function place(el, x, y, align) {
  const box = el.getBoundingClientRect();
  const left = align === "end" ? x - box.width : x;
  el.style.left = `${Math.max(6, Math.min(left, window.innerWidth - box.width - 6))}px`;
  el.style.top = `${Math.max(6, Math.min(y, window.innerHeight - box.height - 6))}px`;
}

/** One menu panel. `anchor` (submenus): the rect of the item that opened it. */
function MenuList({ items, close, x, y, align = "start", anchor = null, autoFocus = true }) {
  const ref = useRef();
  const [open, setOpen] = useState(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!anchor) return place(el, x, y, align);
    const width = el.getBoundingClientRect().width;
    const right = anchor.right + 2;
    const fitsRight = right + width <= window.innerWidth - 6;
    place(el, fitsRight ? right : anchor.left - 2, anchor.top - 5, fitsRight ? "start" : "end");
  }, []);
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector("button:not(:disabled)")?.focus();
  }, []);
  const onKey = (e) => {
    const list = [...ref.current.querySelectorAll(":scope > button:not(:disabled)")];
    const index = list.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    } else if (e.key === "ArrowLeft" && anchor) {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    }
  };
  const openSub = (index, el, focus = false) =>
    setOpen({ index, rect: el.getBoundingClientRect(), focus });
  return (
    <>
      <div
        ref={ref}
        className="context-menu action-menu"
        role="menu"
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          if (item === "sep")
            return <div key={`sep${index}`} className="context-divider" role="separator" />;
          const Icon = item.checked ? Check : item.icon;
          const hasSub = !!item.items?.length;
          return (
            <button
              key={`${index}${item.label}`}
              type="button"
              role="menuitem"
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? open?.index === index : undefined}
              disabled={item.disabled}
              className={`${item.danger ? "danger" : ""} ${open?.index === index ? "open" : ""}`}
              onMouseEnter={(e) =>
                hasSub ? openSub(index, e.currentTarget) : setOpen(null)
              }
              onKeyDown={(e) => {
                if (hasSub && (e.key === "ArrowRight" || e.key === "Enter")) {
                  e.preventDefault();
                  e.stopPropagation();
                  openSub(index, e.currentTarget, true);
                }
              }}
              onClick={(e) => {
                if (hasSub) return openSub(index, e.currentTarget);
                close(true);
                item.onSelect?.();
              }}
            >
              {Icon ? <Icon size={15} /> : <i className="menu-icon-gap" />}
              <span>{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
              {hasSub && <ChevronRight size={14} />}
            </button>
          );
        })}
      </div>
      {open && (
        <MenuList
          key={open.index}
          items={items[open.index].items}
          anchor={open.rect}
          autoFocus={open.focus}
          close={(all) => {
            if (all) close(true);
            else {
              ref.current
                ?.querySelectorAll(":scope > button")
                [items.slice(0, open.index).filter((i) => i !== "sep").length]?.focus();
              setOpen(null);
            }
          }}
        />
      )}
    </>
  );
}

/** Mount once near the root. */
export function MenuHost() {
  const [menu, setMenu] = useState(null);
  const ref = useRef();
  useEffect(() => {
    show = setMenu;
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const prior = document.activeElement;
    const outside = (e) => !ref.current?.contains(e.target) && setMenu(null);
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        if (prior?.isConnected) prior.focus();
      }
    };
    const away = () => setMenu(null);
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    <div ref={ref} className="menu-layer">
      <MenuList
        key={menu.key}
        items={menu.items}
        x={menu.x}
        y={menu.y}
        align={menu.align}
        close={() => setMenu(null)}
      />
    </div>
  );
}
