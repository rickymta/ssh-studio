import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function Button({ icon: Icon, children, variant = "", ...props }) {
  return (
    <button className={`button ${variant}`} {...props}>
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}
export function IconButton({ icon: Icon, title, ...props }) {
  return (
    <button className="icon-button" title={title} aria-label={title} {...props}>
      <Icon size={17} />
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  close,
  wide = false,
  className = "",
}) {
  const ref = useRef();
  // Escape always calls the latest `close` (editors confirm unsaved changes).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const prior = document.activeElement;
    ref.current?.focus();
    const handler = (e) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const list = ref.current?.querySelectorAll(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        );
        if (!list?.length) return;
        if (e.shiftKey && document.activeElement === list[0]) {
          e.preventDefault();
          list[list.length - 1].focus();
        } else if (
          !e.shiftKey &&
          document.activeElement === list[list.length - 1]
        ) {
          e.preventDefault();
          list[0].focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      prior?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""} ${className}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <IconButton icon={X} title="Đóng" onClick={close} />
        </div>
        {children}
      </section>
    </div>
  );
}
export function Field({ label, children, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children || <input {...props} />}
    </label>
  );
}
