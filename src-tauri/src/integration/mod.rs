//! Real loopback SSH/SFTP integration tests; no external server or credentials required.
mod auth;
mod basic;
mod bugfixes;
mod edits;
pub(crate) mod fixture;
mod forwards;
mod sftp_disk;
mod sync;
mod transfers;
