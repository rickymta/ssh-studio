import React, { useState } from "react";
import { Copy, Replace, SkipForward } from "lucide-react";
import { Button, Modal } from "./ui.jsx";

/** Asks what to do with a name that already exists at the destination. */
export function ConflictModal({ name, side, resolve }) {
  const [all, setAll] = useState(false);
  const answer = (choice) => resolve({ choice, all });
  return (
    <Modal
      title="Tên đã tồn tại"
      subtitle={`“${name}” đã có trong ${side === "remote" ? "thư mục remote" : "thư mục local"}.`}
      close={() => answer("cancel")}
    >
      <div className="form-body">
        <p className="form-note">
          Ghi đè thay thế mục đích sau khi truyền xong. Giữ cả hai đặt tên mới
          kiểu “{name.replace(/(\.[^.]+)?$/, " (1)$1")}”.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => setAll(e.target.checked)}
          />
          Áp dụng cho tất cả mục trùng tên còn lại
        </label>
      </div>
      <div className="modal-footer">
        <Button type="button" onClick={() => answer("cancel")}>
          Hủy
        </Button>
        <Button type="button" icon={SkipForward} onClick={() => answer("skip")}>
          Bỏ qua
        </Button>
        <Button type="button" icon={Copy} onClick={() => answer("rename")}>
          Giữ cả hai
        </Button>
        <Button
          type="button"
          variant="primary"
          icon={Replace}
          onClick={() => answer("overwrite")}
        >
          Ghi đè
        </Button>
      </div>
    </Modal>
  );
}
