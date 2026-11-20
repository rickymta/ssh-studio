import React, { useEffect, useState } from "react";
import { LockKeyhole, Terminal } from "lucide-react";
import { Button, Modal, Field } from "./ui.jsx";

/**
 * Answers one backend authentication prompt (F4): password, OTP, or any
 * keyboard-interactive question. Answers go straight to `auth_respond` and are cleared
 * from the form; nothing is stored.
 */
export function AuthPromptModal({ prompt, label, respond }) {
  const [answers, setAnswers] = useState(() => prompt.prompts.map(() => ""));
  useEffect(() => setAnswers(prompt.prompts.map(() => "")), [prompt.id]);
  const single = prompt.prompts.length === 1;
  return (
    <Modal title={prompt.title} subtitle={label} close={() => respond(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const values = answers;
          setAnswers(prompt.prompts.map(() => ""));
          respond(values);
        }}
      >
        <div className="form-body">
          {prompt.instructions && (
            <p className="form-note prompt-instructions">
              {prompt.instructions}
            </p>
          )}
          {prompt.prompts.map((p, i) => (
            <Field
              key={`${prompt.id}-${i}`}
              autoFocus={i === 0}
              label={p.label.replace(/:\s*$/, "") || "Trả lời"}
              type={p.echo ? "text" : "password"}
              autoComplete={single && !p.echo ? "current-password" : "off"}
              value={answers[i] ?? ""}
              onChange={(e) =>
                setAnswers((old) =>
                  old.map((v, j) => (j === i ? e.target.value : v)),
                )
              }
            />
          ))}
          <p className="form-note">
            <LockKeyhole size={16} />
            Chỉ dùng cho lần xác thực này, không lưu xuống ổ đĩa.
          </p>
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={() => respond(null)}>
            Hủy
          </Button>
          <Button variant="primary" icon={Terminal}>
            Tiếp tục
          </Button>
        </div>
      </form>
    </Modal>
  );
}
