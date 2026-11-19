import React, { useState } from "react";
import { Terminal } from "lucide-react";
import { Button, Modal, Field } from "./ui.jsx";

export function PasswordModal({ host, close, connect }) {
  const [password, setPassword] = useState("");
  return (
    <Modal
      title={`Kết nối ${host.name}`}
      subtitle={`${host.username}@${host.host}:${host.port}`}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          connect(password);
          setPassword("");
        }}
      >
        <div className="form-body">
          <Field
            autoFocus
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
          <p className="form-note">
            Password chỉ được dùng cho phiên kết nối này.
          </p>
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button variant="primary" icon={Terminal}>
            Kết nối
          </Button>
        </div>
      </form>
    </Modal>
  );
}
