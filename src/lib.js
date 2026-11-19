import { invoke } from "@tauri-apps/api/core";

export const desktop = !!window.__TAURI_INTERNALS__;
export const call = (name, args = {}) =>
  desktop
    ? invoke(name, args)
    : Promise.reject("Chạy bằng npm start để sử dụng backend Tauri.");
export const uid = () => crypto.randomUUID();
export const cleanError = (e) => String(e).replace(/^Error: /, "");
export const size = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
export const statuses = {
  connecting: "Đang kết nối",
  connected: "Đã kết nối",
  closed: "Đã ngắt",
  error: "Lỗi kết nối",
  queued: "Đang chờ",
  running: "Đang truyền",
  completed: "Hoàn tất",
  failed: "Thất bại",
  cancelled: "Đã hủy",
};
