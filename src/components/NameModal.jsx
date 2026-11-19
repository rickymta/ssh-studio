import React, { useState } from "react";
import { Button, Modal, Field } from "./ui.jsx";

export function NameModal({ title, value: initial, close, save }) {
  const [value, setValue] = useState(initial);
  return (
    <Modal
      title={title}
      subtitle="Nhập tên, không bao gồm đường dẫn."
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(value);
        }}
      >
        <div className="form-body">
          <Field
            label="Tên"
            autoFocus
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button variant="primary">Lưu</Button>
        </div>
      </form>
    </Modal>
  );
}
