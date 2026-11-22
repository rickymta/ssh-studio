// Folder actions shared by the sidebar tree and the workspace overview. `ctx` comes from the
// App: `{ ws, apply(command, args, message?), select(folderId) }`; `apply` calls the backend,
// stores the returned snapshot and reports errors.
import { Folder, FolderInput, FolderPlus, Layers, Pencil, Trash2 } from "lucide-react";
import { uid } from "../lib.js";
import * as F from "../folders.js";
import { ask, confirm } from "./dialogs.jsx";

const siblingsNamed = (folders, parent, name, except = "") =>
  folders.some(
    (f) =>
      f.id !== except &&
      f.parent === parent &&
      f.name.toLowerCase() === name.trim().toLowerCase(),
  );

/** Asks for a name and creates a folder inside `parent`; resolves its id (or null). */
export async function newFolder(ctx, parent) {
  const folders = ctx.ws.folders || [];
  if (!F.canNest(folders, parent)) return null;
  const inside = folders.find((f) => f.id === parent);
  const name = await ask({
    title: inside ? "Thư mục con mới" : "Thư mục mới",
    message: inside
      ? `Trong “${inside.name}”. Thư mục lồng tối đa ${F.MAX_DEPTH} cấp.`
      : `Gom các server liên quan của “${ctx.ws.name}”, lồng tối đa ${F.MAX_DEPTH} cấp.`,
    placeholder: "Ví dụ: Production, Khách hàng A",
    okLabel: "Tạo thư mục",
    validate: (v) =>
      siblingsNamed(folders, parent, v) ? `Đã có thư mục “${v}” ở đây.` : "",
  });
  if (!name) return null;
  const id = uid();
  const result = await ctx.apply("save_folder", {
    workspaceId: ctx.ws.id,
    folder: { id, name, parent, collapsed: false },
  });
  if (!result) return null;
  // The parent opens so the new folder is visible.
  if (inside?.collapsed) await toggleFolder(ctx, inside, false);
  return id;
}

export const toggleFolder = (ctx, folder, collapsed = !folder.collapsed) =>
  ctx.apply("save_folder", {
    workspaceId: ctx.ws.id,
    folder: { ...folder, collapsed },
  });

export async function renameFolder(ctx, folder) {
  const folders = ctx.ws.folders || [];
  const name = await ask({
    title: "Đổi tên thư mục",
    value: folder.name,
    okLabel: "Đổi tên",
    validate: (v) =>
      siblingsNamed(folders, folder.parent, v, folder.id)
        ? `Đã có thư mục “${v}” ở đây.`
        : "",
  });
  if (name && name !== folder.name)
    await ctx.apply("save_folder", {
      workspaceId: ctx.ws.id,
      folder: { ...folder, name },
    });
}

export async function deleteFolder(ctx, folder, hostCount) {
  const parent = (ctx.ws.folders || []).find((f) => f.id === folder.parent);
  const where = parent ? `“${parent.name}”` : "gốc workspace";
  const ok = await confirm(
    `Xóa thư mục “${folder.name}”? ${
      hostCount ? `${hostCount} server và các thư mục con` : "Các thư mục con"
    } được chuyển lên ${where}; không server nào bị xóa.`,
    { title: "Xóa thư mục", kind: "danger" },
  );
  if (!ok) return;
  if (await ctx.apply("delete_folder", { workspaceId: ctx.ws.id, id: folder.id }, "Đã xóa thư mục."))
    ctx.select?.(folder.parent);
}

export const moveFolder = (ctx, folder, parent) =>
  ctx.apply("move_folder", { workspaceId: ctx.ws.id, id: folder.id, parent });

export const placeHosts = (ctx, hosts, folder, workspaceId = ctx.ws.id) =>
  ctx.apply("place_hosts", {
    ids: hosts.map((h) => h.id),
    workspaceId,
    folderId: folder,
  });

const indent = (depth, name) => `${" ".repeat(depth - 1)}${name}`;

/** "Chuyển tới" choices: the root and every folder (where a folder still fits). */
export function moveTargets(ws, current, onPick, folderId = null) {
  const folders = ws.folders || [];
  const ok = (target) =>
    target !== current && (!folderId || F.canMove(folders, folderId, target));
  return [
    {
      label: `${ws.name} (gốc)`,
      icon: Layers,
      disabled: !ok(F.ROOT),
      onSelect: () => onPick(F.ROOT),
    },
    ...F.flatFolders(folders).map(({ folder, depth }) => ({
      label: indent(depth, folder.name),
      icon: Folder,
      disabled: !ok(folder.id),
      onSelect: () => onPick(folder.id),
    })),
  ];
}

/** Menu of a folder (sidebar, list row, breadcrumb). */
export function folderMenu(ctx, folder, hostCount, extra = []) {
  const folders = ctx.ws.folders || [];
  return [
    ...extra,
    ...(extra.length ? ["sep"] : []),
    {
      label: "Thư mục con mới…",
      icon: FolderPlus,
      disabled: !F.canNest(folders, folder.id),
      onSelect: () => newFolder(ctx, folder.id),
    },
    { label: "Đổi tên…", icon: Pencil, onSelect: () => renameFolder(ctx, folder) },
    {
      label: "Chuyển tới",
      icon: FolderInput,
      items: moveTargets(ctx.ws, folder.parent, (to) => moveFolder(ctx, folder, to), folder.id),
    },
    "sep",
    {
      label: "Xóa thư mục",
      icon: Trash2,
      danger: true,
      onSelect: () => deleteFolder(ctx, folder, hostCount),
    },
  ];
}

export const acceptDrop = (ws, item, folder) =>
  F.acceptDrop(ws.folders || [], item, folder);

export function applyDrop(ctx, item, folder) {
  if (item.kind === "folder") {
    const f = (ctx.ws.folders || []).find((x) => x.id === item.id);
    if (f) moveFolder(ctx, f, folder);
  } else placeHosts(ctx, item.hosts, folder);
}

/** One folder per server group still at the root. */
export async function groupIntoFolders(ctx, groups) {
  const ok = await confirm(
    `Tạo ${groups.length} thư mục ở gốc “${ctx.ws.name}” theo nhóm (${groups.join(", ")}) và chuyển các server chưa có thư mục vào đó? Tên nhóm của server được giữ nguyên.`,
    { title: "Tạo thư mục từ nhóm", kind: "info", okLabel: "Tạo thư mục" },
  );
  if (!ok) return;
  const result = await ctx.apply("group_into_folders", { workspaceId: ctx.ws.id });
  return result?.placed;
}
