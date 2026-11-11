//! burn-events — burn's D2 export seam (see AGENTS.md in the burn repo).
//!
//! Calls tokscale-core's public unified-message pipeline (the same entry the
//! tokscale TUI uses) and writes one JSON object per line to stdout: the
//! already-normalized, priced `UnifiedMessage` plus burn's timezone evidence
//! (`source_offset_minutes`, `source_timezone`). Everything else is the
//! upstream serde shape on purpose — when the intended upstream
//! `tokscale events --jsonl` export lands, burn's reporter parses it with the
//! same schema and this binary becomes disposable.
//!
//! Stdout is data, stderr is a human summary. Records whose timestamp is not
//! a positive epoch-ms value are skipped and counted on stderr: burn buckets
//! by UTC instant, and a record without one cannot be ordered.
//!
//! Like tokscale itself, the first run may fetch the LiteLLM pricing snapshot
//! (cached in the tokscale config dir); later runs are offline.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::{Instant, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tokscale_core::pricing::PricingService;
use tokscale_core::scanner::{scan_all_clients_with_scanner_settings, ScanResult, ScannerSettings};
use tokscale_core::{paths, LocalParseOptions, UnifiedMessage, WorkspaceLabeler};

const USAGE: &str = "burn-events — emit tokscale UnifiedMessage records as JSONL (burn D2 seam)

Usage: burn-events [--since-ms <epoch-ms>]
       burn-events --fingerprint
       burn-events --capabilities
       burn-events --version

stdout: one JSON object per line. stderr: scan summary.";

#[derive(Serialize)]
struct ExportRow<'a> {
    #[serde(flatten)]
    msg: &'a UnifiedMessage,
    source_offset_minutes: i32,
    source_timezone: Option<String>,
}

#[derive(Serialize)]
struct Capabilities<'a> {
    protocol: u8,
    tokscale_version: &'a str,
    capabilities: [&'a str; 1],
}

fn capabilities() -> Capabilities<'static> {
    Capabilities {
        protocol: 2,
        tokscale_version: env!("CARGO_PKG_VERSION"),
        capabilities: ["fingerprint-v1"],
    }
}

/// AGENTS.md (D2): for sources tokscale leaves without a dedup_key, derive
/// `v1:<client>:<session_id>:<source_ts_ms>:<ordinal>` deterministically.
/// Ordinals are content-sorted positions within the session, so the key set
/// is stable no matter what order the parallel parser returned. Late-arriving
/// older messages can shift later ordinals — acceptable for the (currently
/// empty) set of parsers that emit no dedup_key, and identical duplicate rows
/// only trade their ordinals between themselves.
fn derive_missing_dedup_keys(messages: &mut [UnifiedMessage]) {
    let mut missing: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
    for (i, msg) in messages.iter().enumerate() {
        if msg.dedup_key.as_deref().is_none_or(str::is_empty) {
            missing
                .entry((msg.client.clone(), msg.session_id.clone()))
                .or_default()
                .push(i);
        }
    }
    for indices in missing.values() {
        let mut sorted = indices.clone();
        sorted.sort_by(|&a, &b| content_cmp(&messages[a], &messages[b]));
        for (ord, i) in sorted.into_iter().enumerate() {
            let key = {
                let m = &messages[i];
                format!(
                    "v1:{}:{}:{}:{}",
                    m.client,
                    m.session_id,
                    m.timestamp,
                    ord + 1
                )
            };
            messages[i].dedup_key = Some(key);
        }
    }
}

fn content_cmp(a: &UnifiedMessage, b: &UnifiedMessage) -> Ordering {
    a.timestamp
        .cmp(&b.timestamp)
        .then_with(|| a.client.cmp(&b.client))
        .then_with(|| a.model_id.cmp(&b.model_id))
        .then_with(|| a.provider_id.cmp(&b.provider_id))
        .then_with(|| a.tokens.input.cmp(&b.tokens.input))
        .then_with(|| a.tokens.output.cmp(&b.tokens.output))
        .then_with(|| a.tokens.cache_read.cmp(&b.tokens.cache_read))
        .then_with(|| a.tokens.cache_write.cmp(&b.tokens.cache_write))
        .then_with(|| a.tokens.reasoning.cmp(&b.tokens.reasoning))
        .then_with(|| a.cost.total_cmp(&b.cost))
        .then_with(|| a.duration_ms.cmp(&b.duration_ms))
        .then_with(|| a.message_count.cmp(&b.message_count))
        .then_with(|| a.is_turn_start.cmp(&b.is_turn_start))
        .then_with(|| a.agent.cmp(&b.agent))
        .then_with(|| a.session_title.cmp(&b.session_title))
        .then_with(|| a.workspace_key.cmp(&b.workspace_key))
}

fn main() {
    let mut since_ms: Option<i64> = None;
    let mut fingerprint = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--version" => {
                println!("burn-events {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--capabilities" => {
                println!(
                    "{}",
                    serde_json::to_string(&capabilities()).expect("serialize capabilities")
                );
                return;
            }
            "-h" | "--help" => {
                eprintln!("{USAGE}");
                return;
            }
            "--fingerprint" => fingerprint = true,
            "--since-ms" => match args.next().and_then(|v| v.parse::<i64>().ok()) {
                Some(value) => since_ms = Some(value),
                None => {
                    eprintln!("--since-ms needs an epoch-ms integer\n{USAGE}");
                    std::process::exit(2);
                }
            },
            other => {
                eprintln!("unknown argument: {other}\n{USAGE}");
                std::process::exit(2);
            }
        }
    }

    if fingerprint {
        match source_fingerprint() {
            Ok(value) => {
                println!("{value}");
                return;
            }
            Err(err) => {
                eprintln!("[burn-events] fingerprint failed: {err}");
                std::process::exit(1);
            }
        }
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    if let Err(err) = rt.block_on(run(since_ms)) {
        eprintln!("[burn-events] fatal: {err}");
        std::process::exit(1);
    }
}

async fn run(since_ms: Option<i64>) -> Result<(), String> {
    let started = Instant::now();
    let pricing = PricingService::get_or_init().await?;

    let options = LocalParseOptions {
        // Same env-root overrides the tokscale CLI honors by default (CLI
        // main.rs: env roots are on whenever no --home is pinned).
        use_env_roots: true,
        scanner_settings: load_scanner_settings(),
        ..LocalParseOptions::default()
    };
    let mut messages =
        tokscale_core::parse_local_unified_messages_with_pricing(options, Some(&pricing)).await?;
    let total = messages.len();
    derive_missing_dedup_keys(&mut messages);

    // The labeler is the same core helper the TUI/report use to resolve a
    // workspace key to a display label (filesystem probes live on this
    // machine — the phone cannot do this).
    let zone = iana_time_zone::get_timezone().ok();
    let mut labeler = WorkspaceLabeler::default();
    for msg in &mut messages {
        if msg.workspace_label.is_none() {
            if let Some(key) = msg.workspace_key.as_deref() {
                msg.workspace_label = Some(labeler.label(key));
            }
        }
    }

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut emitted = 0usize;
    let mut skipped = 0usize;
    for msg in &messages {
        if msg.timestamp <= 0 {
            skipped += 1;
            continue;
        }
        if let Some(since) = since_ms {
            if msg.timestamp < since {
                continue;
            }
        }
        use chrono::TimeZone;
        let source_offset_minutes = chrono::Local
            .timestamp_millis_opt(msg.timestamp)
            .single()
            .map(|t| t.offset().local_minus_utc() / 60)
            .unwrap_or(0);
        let row = ExportRow {
            msg,
            source_offset_minutes,
            source_timezone: zone.clone(),
        };
        serde_json::to_writer(&mut out, &row).map_err(|e| format!("serialize: {e}"))?;
        out.write_all(b"\n").map_err(|e| format!("write: {e}"))?;
        emitted += 1;
    }
    out.flush().map_err(|e| format!("flush: {e}"))?;

    eprintln!(
        "[burn-events] {emitted} record(s) written, {skipped} skipped (no timestamp), {total} scanned in {:?}",
        started.elapsed()
    );
    Ok(())
}

/// Cheap change detector for `--fingerprint`: hashes the metadata (size,
/// mtime) of every source tokscale would scan plus the settings and pricing
/// files, so the reporter can reuse a snapshot without re-parsing.
fn source_fingerprint() -> Result<String, String> {
    let home = tokscale_core::get_home_dir_string(&None)?;
    let settings = load_scanner_settings();
    // Exhaustive on purpose (no `..`): a pin bump that adds a source kind must
    // fail to compile here, or that source's edits would never refresh rows.
    let ScanResult {
        files,
        opencode_dbs,
        copilot_desktop_db,
        copilot_session_store_db,
        synthetic_db,
        kilo_db,
        hermes_db,
        goose_db,
        zed_db,
        kiro_db,
        crush_dbs,
        zcode_db,
        cherrystudio_db,
        openclaw_dbs,
        micode_dbs,
        opencode_json_dir,
        devin_dbs,
        copilot_vscode_sessions,
    } = scan_all_clients_with_scanner_settings(&home, &[], true, &settings);
    let mut sources: Vec<PathBuf> = files.into_iter().flatten().collect();
    sources.extend(opencode_dbs);
    sources.extend(copilot_desktop_db);
    sources.extend(copilot_session_store_db);
    sources.extend(synthetic_db);
    sources.extend(kilo_db);
    sources.extend(hermes_db);
    sources.extend(goose_db);
    sources.extend(zed_db);
    sources.extend(kiro_db);
    sources.extend(crush_dbs.into_iter().map(|source| source.db_path));
    sources.extend(zcode_db);
    sources.extend(cherrystudio_db);
    sources.extend(openclaw_dbs);
    sources.extend(micode_dbs);
    sources.extend(opencode_json_dir);
    sources.extend(devin_dbs);
    sources.extend(copilot_vscode_sessions);

    // Scanner behavior and pricing affect normalized rows even when transcript
    // files are unchanged. Their cache/config files are therefore sources too.
    sources.extend(config_sources(&paths::get_config_dir(), &paths::get_cache_dir()));
    fingerprint_paths(&sources)
}

/// Files outside the transcripts that change priced output: scanner settings,
/// the user's own price overrides, and the three price lists tokscale keeps in
/// its cache directory (not beside the settings, where an earlier version of
/// this probe looked and so never saw a price refresh).
fn config_sources(config_dir: &std::path::Path, cache_dir: &std::path::Path) -> Vec<PathBuf> {
    let mut sources = vec![
        config_dir.join("settings.json"),
        config_dir.join("custom-pricing.json"),
    ];
    for name in [
        "pricing-litellm.json",
        "pricing-openrouter.json",
        "pricing-models-dev.json",
    ] {
        sources.push(cache_dir.join(name));
    }
    sources
}

fn fingerprint_paths(paths: &[PathBuf]) -> Result<String, String> {
    let mut expanded = Vec::with_capacity(paths.len() * 2);
    for path in paths {
        expanded.push(path.clone());
        // Active SQLite changes can live only in the WAL; hashing the main DB
        // metadata alone would incorrectly classify those rows as unchanged.
        let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
        if wal.exists() {
            expanded.push(wal);
        }
    }
    expanded.sort_unstable();
    expanded.dedup();

    let mut hash = Sha256::new();
    // A parser pin or timezone change can alter normalized output with no
    // transcript metadata change. Keep those inputs in the generation so a
    // phone never suppresses the required correction scan.
    hash.update(b"burn-source-fingerprint-v1");
    hash.update(env!("CARGO_PKG_VERSION").as_bytes());
    hash.update(
        iana_time_zone::get_timezone()
            .unwrap_or_default()
            .as_bytes(),
    );
    for path in expanded {
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        hash.update(path.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(metadata.len().to_le_bytes());
        hash.update(modified_ns.to_le_bytes());
        hash.update([u8::from(metadata.is_dir())]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Scanner settings live on the `scanner` key of tokscale's settings.json;
/// unreadable or absent config degrades to defaults, exactly like the CLI.
fn load_scanner_settings() -> ScannerSettings {
    let path = paths::get_config_dir().join("settings.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ScannerSettings::default();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return ScannerSettings::default();
    };
    value
        .get("scanner")
        .cloned()
        .map(serde_json::from_value::<ScannerSettings>)
        .unwrap_or_else(|| Ok(ScannerSettings::default()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{capabilities, config_sources, fingerprint_paths};
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn fingerprint_changes_when_a_source_grows() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("burn-events-fingerprint-{nonce}"));
        std::fs::write(&path, b"one").unwrap();
        let first = fingerprint_paths(std::slice::from_ref(&path)).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"-two").unwrap();
        file.sync_all().unwrap();
        let second = fingerprint_paths(std::slice::from_ref(&path)).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn fingerprint_sees_price_lists_and_custom_pricing() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let config = std::env::temp_dir().join(format!("burn-events-config-{nonce}"));
        let cache = config.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let sources = config_sources(&config, &cache);
        let empty = fingerprint_paths(&sources).unwrap();
        // Each file tokscale prices from must move the fingerprint, where
        // tokscale actually keeps it.
        let mut seen = vec![empty];
        for path in [
            cache.join("pricing-litellm.json"),
            cache.join("pricing-openrouter.json"),
            cache.join("pricing-models-dev.json"),
            config.join("custom-pricing.json"),
            config.join("settings.json"),
        ] {
            std::fs::write(&path, b"{}").unwrap();
            let next = fingerprint_paths(&sources).unwrap();
            assert!(!seen.contains(&next), "{} did not change the fingerprint", path.display());
            seen.push(next);
        }
        std::fs::remove_dir_all(config).unwrap();
    }

    #[test]
    fn advertises_the_fingerprint_fast_path() {
        let value = serde_json::to_value(capabilities()).unwrap();
        assert_eq!(value["protocol"], 2);
        assert_eq!(value["capabilities"][0], "fingerprint-v1");
    }
}
