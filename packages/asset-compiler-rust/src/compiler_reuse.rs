//! Fast path of a job whose product is already in the cache.
//!
//! The key names the product entirely (`compiler_identity.rs`): a folder under it
//! holds the bytes this job would write again. Rebuilding the DAG to overwrite
//! them with themselves cost a warm recompile as much as a cold one. The folder is
//! reused instead — after proving it whole, file by file, with the same checks
//! the compile path applies to what it keeps (`compiler_reuse_proof.rs`). A
//! folder that fails one check is not repaired: it is rebuilt, and the reason is
//! announced.
use super::*;

/// What a proven folder gives the job: its manifest and the format it declares,
/// what prune must keep, and the count of what was checked.
pub(super) struct Reused {
    pub manifest: Value,
    pub format: u32,
    pub keep: Keep,
    pub report: Value,
}

/// A failed check names its reason; it is a diagnostic, never an error.
pub(super) type Check<T> = std::result::Result<T, String>;

/// The folder of `key`, proven, or `None` when it is absent or fails a check.
pub(super) fn reuse(
    o: &Options,
    key: &str,
    pool: &rayon::ThreadPool,
    progress: &(impl Fn(Value) + Sync),
) -> Result<Option<Reused>> {
    let directory = o.key_directory(key);
    let Ok(head) = fs::read(directory.join(MANIFEST_FILE)) else {
        return Ok(None);
    };
    let started = Instant::now();
    match compiler_reuse_proof::prove(o, key, &directory, &head, pool) {
        Ok(mut reused) => {
            reused.report["validateMs"] = json!(shared_math::elapsed_ms(started));
            let mut event = reused.report.clone();
            event["phase"] = json!("reuse");
            event["completed"] = json!(1);
            event["total"] = json!(1);
            progress(event);
            Ok(Some(reused))
        }
        Err(reason) => {
            // A cancellation reached inside the proof is a cancellation, not a reason to rebuild.
            check(o)?;
            progress(json!({"phase":"reuse","completed":0,"total":1,"reason":reason}));
            Ok(None)
        }
    }
}

/// Ends a job on a proven folder: pointer, prune, and this job's own numbers —
/// nothing of the compile that wrote the folder is passed off as this run's work.
/// `importMs` runs to the decision: routing, loading, the key and the proof.
pub(super) fn finish(
    o: &Options,
    key: &str,
    reused: Reused,
    started: Instant,
    progress: &(impl Fn(Value) + Sync),
) -> Result<Value> {
    let import_ms = shared_math::elapsed_ms(started);
    let Reused {
        mut manifest,
        format,
        keep,
        report,
    } = reused;
    compiler_publish::write_pointer(o, key, format)?;
    let prune_start = Instant::now();
    let pruned = prune_cache(o, key, keep, progress)?;
    let output_bytes = manifest["metrics"]["outputGeometryBytes"].take();
    manifest["metrics"] = json!({"importMs":import_ms,"clusterHierarchyPagesMs":null,"pruneMs":shared_math::elapsed_ms(prune_start),"wallMs":shared_math::elapsed_ms(started),"outputGeometryBytes":output_bytes,"threads":o.threads,"ramBudgetMb":o.ram_budget_mb});
    manifest["reused"] = report;
    progress(json!({"phase":"complete","completed":1,"total":1,"pruned":pruned}));
    Ok(manifest)
}
