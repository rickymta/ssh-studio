import React, { useEffect, useRef, useState } from "react";
import { confirm } from "./dialogs.jsx";
import { LoaderCircle, RotateCcw, Save, TriangleAlert } from "lucide-react";
import { call, cleanError, lineEnding, size, withLineEnding } from "../lib.js";
import { Button, Modal } from "./ui.jsx";

/**
 * Edits a remote text file (F2). Saving sends back the size/mtime seen when the file was
 * opened; if the server copy changed meanwhile the backend refuses and we ask whether to
 * overwrite it or reload.
 */
export function EditorModal({ session, path, notify, close }) {
  const [doc, setDoc] = useState(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const area = useRef(null);
  const gutter = useRef(null);
  const dirty = !!doc && text !== doc.text;

  const load = async () => {
    setError("");
    setConflict(null);
    try {
      const result = await call("read_text", { sessionId: session.id, path });
      const normalised = result.content.replace(/\r\n/g, "\n");
      setDoc({ ...result, text: normalised, eol: lineEnding(result.content) });
      setText(normalised);
      setTimeout(() => area.current?.focus(), 0);
    } catch (e) {
      setError(cleanError(e));
    }
  };
  useEffect(() => {
    load();
  }, [path]);

  const save = async (force = false) => {
    if (!doc || saving) return;
    setSaving(true);
    try {
      const result = await call("write_text", {
        sessionId: session.id,
        path,
        content: withLineEnding(text, doc.eol),
        expectedSize: doc.size,
        expectedMtime: doc.mtime,
        force,
      });
      if (result.conflict) setConflict(result);
      else {
        setConflict(null);
        setDoc((old) => ({ ...old, ...result, text }));
        notify(`Đã lưu ${path}`);
      }
    } catch (e) {
      notify(e, true);
    } finally {
      setSaving(false);
    }
  };
  const tryClose = async () => {
    if (
      dirty &&
      !(await confirm("Đóng trình sửa và bỏ các thay đổi chưa lưu?", {
        title: "Chưa lưu",
        kind: "warning",
        okLabel: "Bỏ thay đổi",
      }))
    )
      return;
    close();
  };
  const reload = async () => {
    if (
      dirty &&
      !(await confirm("Tải lại từ server và bỏ các thay đổi của bạn?", {
        title: "Tải lại",
        kind: "warning",
        okLabel: "Tải lại",
      }))
    )
      return;
    load();
  };

  const lines = text.split("\n").length;
  return (
    <Modal
      title={path.split("/").pop() + (dirty ? " •" : "")}
      subtitle={`${session.host.username}@${session.host.host}:${path}`}
      close={tryClose}
      className="editor-modal"
    >
      {conflict && (
        <div className="editor-conflict" role="alert">
          <TriangleAlert size={16} />
          <span>
            {conflict.exists
              ? "File trên server đã bị thay đổi kể từ lúc bạn mở."
              : "File trên server đã bị xóa kể từ lúc bạn mở."}
          </span>
          <Button type="button" onClick={reload}>
            Tải lại
          </Button>
          <Button type="button" variant="primary" onClick={() => save(true)}>
            {conflict.exists ? "Ghi đè" : "Tạo lại"}
          </Button>
        </div>
      )}
      <div className="editor-body">
        {error ? (
          <div className="file-error">{error}</div>
        ) : !doc ? (
          <div className="empty-inline">
            <LoaderCircle size={20} className="spin" />
            Đang mở file…
          </div>
        ) : (
          <>
            <pre className="editor-gutter" ref={gutter} aria-hidden="true">
              {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
            </pre>
            <textarea
              ref={area}
              className="editor-text"
              aria-label={`Nội dung ${path}`}
              spellCheck={false}
              wrap="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onScroll={(e) => {
                if (gutter.current)
                  gutter.current.scrollTop = e.target.scrollTop;
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  save();
                } else if (
                  e.key === "Tab" &&
                  !e.ctrlKey &&
                  !e.altKey &&
                  !e.metaKey &&
                  !e.shiftKey
                ) {
                  // Insert a tab (keeps undo history) instead of leaving the editor.
                  e.preventDefault();
                  e.stopPropagation();
                  document.execCommand("insertText", false, "\t");
                }
              }}
            />
          </>
        )}
      </div>
      <div className="modal-footer editor-footer">
        <span>
          {doc
            ? `${lines} dòng · ${size(new TextEncoder().encode(text).length)} · ${doc.eol === "\r\n" ? "CRLF" : "LF"} · UTF-8`
            : ""}
        </span>
        <Button type="button" icon={RotateCcw} disabled={!doc} onClick={reload}>
          Tải lại
        </Button>
        <Button type="button" onClick={tryClose}>
          Đóng
        </Button>
        <Button
          type="button"
          variant="primary"
          icon={Save}
          disabled={!dirty || saving}
          onClick={() => save()}
        >
          {saving ? "Đang lưu…" : "Lưu (Ctrl+S)"}
        </Button>
      </div>
    </Modal>
  );
}
