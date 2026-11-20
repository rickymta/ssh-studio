#!/usr/bin/env node
// Version and release tag for SSH Studio. Node only, no dependencies.
//
//   npm run release -- <patch|minor|major|x.y.z[-pre]> [--dry-run]
//       bump the version files, add a CHANGELOG section from the commits since the last tag,
//       commit "chore(release): vX.Y.Z" and create the annotated tag vX.Y.Z (on main only).
//   npm run check:version [-- x.y.z]
//       the version files agree (and equal x.y.z when given). Used by CI and the release
//       workflow.
//
// Never pushes: prints the push command instead.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(ROOT, p);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const CHANGELOG = path("CHANGELOG.md");

const die = (message) => {
  console.error(`Lỗi: ${message}`);
  process.exit(1);
};
const git = (...args) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) die(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

// The first "version" of a JSON file is the top-level one.
const JSON_VERSION = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
// package-lock.json repeats the version under packages[""].
const LOCK_ROOT = /("packages"\s*:\s*\{\s*""\s*:\s*\{[^}]*?"version"\s*:\s*")([^"]*)(")/;
// [package] version of the app crate, and its entry in Cargo.lock.
const CARGO_VERSION = /^(\[package\][^[]*?^version\s*=\s*")([^"]*)(")/m;
const LOCK_CRATE = /(name = "ssh-studio"\r?\nversion = ")([^"]*)(")/;

const FILES = [
  ["package.json", [JSON_VERSION]],
  ["package-lock.json", [JSON_VERSION, LOCK_ROOT]],
  ["src-tauri/tauri.conf.json", [JSON_VERSION]],
  ["src-tauri/Cargo.toml", [CARGO_VERSION]],
  ["src-tauri/Cargo.lock", [LOCK_CRATE]],
];

function readVersions() {
  const found = {};
  for (const [file, patterns] of FILES) {
    const text = readFileSync(path(file), "utf8");
    patterns.forEach((re, i) => {
      const m = text.match(re);
      found[i ? `${file} (packages[""])` : file] = m ? m[2] : null;
    });
  }
  return found;
}

function check(expected) {
  const versions = readVersions();
  const values = new Set(Object.values(versions));
  for (const [file, v] of Object.entries(versions))
    console.log(`  ${file.padEnd(36)} ${v ?? "(không thấy)"}`);
  if (values.has(null)) die("Không đọc được version ở một file.");
  if (values.size !== 1) die("Các file version không khớp nhau.");
  const [version] = values;
  if (!SEMVER.test(version)) die(`Version "${version}" không phải semver.`);
  if (expected && version !== expected)
    die(`Version trong file là ${version}, tag yêu cầu ${expected}.`);
  console.log(`OK: ${version}`);
  return version;
}

function next(current, bump) {
  if (SEMVER.test(bump)) return bump;
  const [, major, minor, patch, pre] = current.match(SEMVER).map((x, i) =>
    i && i < 4 ? Number(x) : x,
  );
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  // 1.2.3-beta.1 → patch releases 1.2.3.
  if (bump === "patch") return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
  die(`Không hiểu "${bump}": dùng patch, minor, major hoặc x.y.z.`);
}

/** Changelog lines from the commit subjects since the previous tag (merges skipped). */
function changes() {
  const last = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const range = last.status === 0 ? [`${last.stdout.trim()}..HEAD`] : [];
  const log = git("log", "--no-merges", "--format=%s", ...range);
  const groups = { feat: "Tính năng", fix: "Sửa lỗi", perf: "Hiệu năng", other: "Khác" };
  const lines = Object.fromEntries(Object.keys(groups).map((k) => [k, []]));
  for (const subject of log.split("\n").filter(Boolean)) {
    if (subject.startsWith("chore(release)")) continue;
    const m = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/);
    const kind = m && groups[m[1]] ? m[1] : "other";
    lines[kind].push(`- ${m ? m[2] : subject}`);
  }
  return Object.entries(groups)
    .filter(([k]) => lines[k].length)
    .map(([k, title]) => `### ${title}\n\n${lines[k].join("\n")}`)
    .join("\n\n");
}

function release(bump, dryRun) {
  const current = check();
  const version = next(current, bump);
  if (version === current && !SEMVER.test(bump))
    die(`Version mới trùng version hiện tại (${current}).`);
  const tag = `v${version}`;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") die(`Chỉ phát hành từ main (đang ở ${branch}).`);
  if (git("status", "--porcelain", "--untracked-files=no"))
    die("Còn thay đổi chưa commit.");
  if (git("tag", "--list", tag)) die(`Tag ${tag} đã có.`);

  const writes = {};
  if (version !== current)
    for (const [file, patterns] of FILES) {
      let text = readFileSync(path(file), "utf8");
      for (const re of patterns) text = text.replace(re, `$1${version}$3`);
      writes[file] = text;
    }
  const date = new Date().toISOString().slice(0, 10);
  const body = changes() || "- Bảo trì.";
  const existing = existsSync(CHANGELOG)
    ? readFileSync(CHANGELOG, "utf8")
    : "# Changelog\n";
  if (!new RegExp(`^## \\[?${version.replace(/\./g, "\\.")}\\]?`, "m").test(existing)) {
    const at = existing.search(/^## /m);
    const section = `## [${version}] - ${date}\n\n${body}\n\n`;
    writes["CHANGELOG.md"] =
      at < 0 ? `${existing.trimEnd()}\n\n${section}` : existing.slice(0, at) + section + existing.slice(at);
  }
  console.log(`\n${current} → ${version} (${tag})`);
  for (const file of Object.keys(writes)) console.log(`  ghi ${file}`);
  if (dryRun) {
    console.log("\n--dry-run: không ghi file, không commit.");
    return;
  }
  for (const [file, text] of Object.entries(writes)) writeFileSync(path(file), text);
  check(version);
  // First release of an already-set version with a hand-written CHANGELOG: tag only.
  if (Object.keys(writes).length) {
    git("add", ...Object.keys(writes));
    git("commit", "-m", `chore(release): ${tag}`);
  }
  git("tag", "-a", tag, "-m", `SSH Studio ${tag}`);
  console.log(`\nĐã tạo commit và tag ${tag}. Phát hành bằng:\n  git push origin main ${tag}`);
}

const args = process.argv.slice(2);
if (args[0] === "--check") check(args[1]);
else if (args[0] && !args[0].startsWith("--")) release(args[0], args.includes("--dry-run"));
else
  die(
    "Cách dùng: npm run release -- <patch|minor|major|x.y.z> [--dry-run]\n" +
      "          npm run check:version [-- x.y.z]",
  );
