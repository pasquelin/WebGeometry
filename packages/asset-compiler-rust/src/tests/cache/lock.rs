use super::*;

/// Cache consistency held regardless of outcome: published pointer names key whose
/// folder exists, and each page named by sidecar columns is still on
/// disk. Exactly what concurrent purge destroys.
fn assert_cache_coherent(o: &Options) {
    let pointer = read_json(&o.scope_directory().join("manifest.json"));
    let key = pointer["key"].as_str().expect("pointer key");
    let directory = o.key_directory(key);
    assert!(
        directory.join("clusters.json").exists(),
        "the pointer names {key}, whose directory is gone"
    );
    let sidecars = paged(&directory).sidecars;
    let digests = sidecars
        .iter()
        .map(|s| manifest_binary::digests(s).expect("sidecar columns"));
    for digest in digests.flatten() {
        assert!(
            object_path(o, &digest).exists(),
            "the page {digest} the manifest names is gone"
        );
    }
}

/// A02: two concurrent compilations of same cache. Cache keeps single pointer per scope
/// and purges after each write: without mutual exclusion, one purge erases key and
/// objects other just published. Each compilation must succeed or be refused,
/// cache remaining readable in both cases.
#[test]
fn a02_two_threads_on_one_cache_leave_a_readable_pointer() {
    for _ in 0..4 {
        let (first_root, first) = fixture();
        let (second_root, second) = cube_fixture();
        let first = Options {
            scope: "full".into(),
            triangle_budget: 150000,
            ..first
        };
        let second = Options {
            cache: first.cache.clone(),
            simplification: "none".into(),
            ..second
        };
        let outcomes = std::thread::scope(|scope| {
            let one = scope.spawn(|| compile(&first, |_| {}));
            let two = scope.spawn(|| compile(&second, |_| {}));
            [one.join().expect("fil"), two.join().expect("fil")]
        });
        for outcome in &outcomes {
            if let Err(error) = outcome {
                assert_eq!(error.code, "CACHE_LOCKED", "{error}");
            }
        }
        assert!(
            outcomes.iter().any(Result::is_ok),
            "at least one compilation succeeds"
        );
        assert_cache_coherent(&first);
        fs::remove_dir_all(first_root).expect("cleanup");
        fs::remove_dir_all(second_root).expect("cleanup");
    }
}
