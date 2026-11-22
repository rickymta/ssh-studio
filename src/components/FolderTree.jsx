import React from "react";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  MoreHorizontal,
  Wand2,
} from "lucide-react";
import { WORKSPACE_COLORS } from "../lib.js";
import * as F from "../folders.js";
import {
  acceptDrop,
  applyDrop,
  folderMenu,
  groupIntoFolders,
  newFolder,
  toggleFolder,
} from "./folderActions.jsx";
import { DROP_ATTR, beginDrag, useFolderDrag } from "./folderDrag.jsx";
import { Dropdown, contextMenu } from "./menu.jsx";

/**
 * The folders of the active workspace in the sidebar: picks which folder the server list
 * shows, and takes servers / folders dropped on it.
 */
export function FolderTree({ ctx, hosts, selected, active, onSelect }) {
  const { ws } = ctx;
  const folders = ws.folders || [];
  const color = WORKSPACE_COLORS[ws.color] || WORKSPACE_COLORS.mint;
  const counts = F.folderCounts(folders, hosts);
  const { over, item: dragging } = useFolderDrag();
  const groups = F.rootGroups(folders, hosts);

  const node = (f, depth) => {
    const kids = F.childrenOf(folders, f.id);
    const open = !f.collapsed;
    const isSel = active && selected === f.id;
    const menu = () => folderMenu(ctx, f, counts[f.id]);
    return (
      <div key={f.id} role="none">
        <div
          role="treeitem"
          aria-selected={isSel}
          aria-expanded={kids.length ? open : undefined}
          tabIndex={0}
          {...{ [DROP_ATTR]: f.id }}
          className={`tree-item ${isSel ? "active" : ""} ${over === f.id ? "drop" : ""}`}
          style={{ paddingLeft: 8 + (depth - 1) * 14 }}
          onClick={() => onSelect(f.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSelect(f.id);
            else if (e.key === "ArrowRight" && kids.length && !open) toggleFolder(ctx, f, false);
            else if (e.key === "ArrowLeft" && kids.length && open) toggleFolder(ctx, f, true);
          }}
          onContextMenu={contextMenu(menu)}
          onPointerDown={(e) =>
            beginDrag(
              e,
              { kind: "folder", id: f.id, label: f.name },
              (it, to) => acceptDrop(ws, it, to),
              (it, to) => applyDrop(ctx, it, to),
            )
          }
        >
          <button
            type="button"
            className={`tree-toggle ${kids.length ? "" : "hidden"}`}
            aria-label={open ? "Thu gọn" : "Mở rộng"}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              toggleFolder(ctx, f);
            }}
          >
            <ChevronRight size={13} className={open ? "turned" : ""} />
          </button>
          {open && kids.length ? (
            <FolderOpen size={15} style={{ color }} />
          ) : (
            <Folder size={15} style={{ color }} />
          )}
          <span className="tree-name">{f.name}</span>
          <span className="tree-count">{counts[f.id] || 0}</span>
          <Dropdown items={menu}>
            <button
              type="button"
              className="tree-more"
              title="Tùy chọn thư mục"
              aria-label={`Tùy chọn thư mục ${f.name}`}
            >
              <MoreHorizontal size={14} />
            </button>
          </Dropdown>
        </div>
        {open && kids.map((k) => node(k, depth + 1))}
      </div>
    );
  };

  return (
    <nav className="folder-tree" role="tree" aria-label="Thư mục">
      <div
        role="treeitem"
        aria-selected={active && selected === F.ROOT}
        tabIndex={0}
        {...{ [DROP_ATTR]: F.ROOT }}
        className={`tree-item root ${active && selected === F.ROOT ? "active" : ""} ${over === F.ROOT ? "drop" : ""}`}
        onClick={() => onSelect(F.ROOT)}
        onKeyDown={(e) => e.key === "Enter" && onSelect(F.ROOT)}
        onContextMenu={contextMenu(() => [
          {
            label: "Thư mục mới…",
            icon: FolderPlus,
            onSelect: () => newFolder(ctx, F.ROOT),
          },
        ])}
      >
        <Layers size={15} style={{ color }} />
        <span className="tree-name">Tất cả server</span>
        <span className="tree-count">{counts[F.ROOT]}</span>
      </div>
      {F.childrenOf(folders, F.ROOT).map((f) => node(f, 1))}
      {folders.length === 0 &&
        (groups.length ? (
          <button
            type="button"
            className="tree-hint"
            onClick={() => groupIntoFolders(ctx, groups)}
          >
            <Wand2 size={14} />
            Tạo {groups.length} thư mục từ nhóm server
          </button>
        ) : (
          <button
            type="button"
            className="tree-hint"
            onClick={() => newFolder(ctx, F.ROOT)}
          >
            <FolderPlus size={14} />
            Gom server liên quan vào thư mục (tối đa {F.MAX_DEPTH} cấp)
          </button>
        ))}
      {dragging && (
        <p className="tree-drag-hint">Thả lên một thư mục để chuyển. Esc để hủy.</p>
      )}
    </nav>
  );
}
