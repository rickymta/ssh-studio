// Folders inside a workspace: a tree of at most MAX_DEPTH levels grouping related servers.
// A server whose `folderId` is empty (or names a folder that is gone) sits at the root ('').
// Mirrors the rules of `workspace.rs`, which has the final say.

export const MAX_DEPTH = 3;
export const ROOT = "";

const byId = (folders) => new Map(folders.map((f) => [f.id, f]));

/** 1 for a folder at the root, 2 for one inside it…; 0 for the root itself. */
export function depthOf(folders, id) {
  const map = byId(folders);
  let depth = 0;
  for (let f = map.get(id); f && depth <= folders.length; f = map.get(f.parent))
    depth++;
  return depth;
}

/** Levels in the subtree under `id`, the folder itself included (1 for a leaf). */
export function heightOf(folders, id) {
  const kids = folders.filter((f) => f.parent === id && f.id !== id);
  return 1 + Math.max(0, ...kids.map((k) => heightOf(folders, k.id)));
}

/** `id` and every folder under it. */
export function subtree(folders, id) {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders)
      if (out.has(f.parent) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
  }
  return out;
}

/** Whether a new folder can go inside `parent`. */
export const canNest = (folders, parent) => depthOf(folders, parent) < MAX_DEPTH;

/** Whether folder `id` can move into `parent`: not into itself, staying within MAX_DEPTH. */
export function canMove(folders, id, parent) {
  if (id === parent || (parent && subtree(folders, id).has(parent)))
    return false;
  const folder = folders.find((f) => f.id === id);
  if (!folder || folder.parent === parent) return false;
  return depthOf(folders, parent) + heightOf(folders, id) <= MAX_DEPTH;
}

/** Folders under `parent`, sorted by name. */
export const childrenOf = (folders, parent) =>
  folders
    .filter((f) => f.parent === parent)
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );

/** The folders from the root down to `id`. */
export function pathTo(folders, id) {
  const map = byId(folders);
  const out = [];
  for (let f = map.get(id); f && out.length <= folders.length; f = map.get(f.parent))
    out.unshift(f);
  return out;
}

/** Every folder in tree order with its depth (1 = at the root). */
export function flatFolders(folders) {
  const out = [];
  const walk = (parent, depth) => {
    for (const f of childrenOf(folders, parent)) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(ROOT, 1);
  return out;
}

/** The folder a server sits in ('' for the root, also when its folder is gone). */
export function folderOf(folders, host) {
  const id = host.folderId || ROOT;
  return id && folders.some((f) => f.id === id) ? id : ROOT;
}

/** The servers directly in `folder`, or (deep) in it and every folder under it. */
export function hostsIn(folders, hosts, folder, deep = false) {
  if (deep && !folder) return hosts;
  const set = deep ? subtree(folders, folder) : new Set([folder]);
  return hosts.filter((h) => set.has(folderOf(folders, h)));
}

/** Servers in each folder and below it, by folder id ('' = the whole workspace). */
export function folderCounts(folders, hosts) {
  const out = { [ROOT]: hosts.length };
  for (const f of folders) out[f.id] = hostsIn(folders, hosts, f.id, true).length;
  return out;
}

/** Whether something dragged may land in `folder`. */
export function acceptDrop(folders, item, folder) {
  if (item.kind === "folder") return canMove(folders, item.id, folder);
  return item.hosts.some((h) => folderOf(folders, h) !== folder);
}

/** Distinct, non-empty server groups that are still at the root (offered as folders). */
export function rootGroups(folders, hosts) {
  const seen = new Set();
  const out = [];
  for (const h of hosts) {
    const group = (h.group || "").trim();
    if (!group || folderOf(folders, h) !== ROOT) continue;
    const key = group.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(group);
    }
  }
  return out;
}
