//! Fast path (#47), what the proof refuses: a corrupted product, a bake the
//! compile could not finish, a missing answer sheet — and what it counts when
//! several textures share one image.
use super::reuse::{compile_with_events, textured};
use super::*;
use crate::compiler_manifest_pages::{sidecar_file, MANIFEST_PAGES};
use crate::compiler_tables::partition::pages::{read_slot, write_page};

// Behaviour: a folder whose compile could not write a level file — the report
// notes it, the entry carries no baked level — is not proven: the reuse would
// never bake what the compile path bakes again.
#[test]
fn an_unfinished_bake_is_not_reused() {
    let (root, options) = textured();
    let (first, _) = compile_with_events(&options);
    let directory = options.key_directory(first["key"].as_str().unwrap());
    let (manifest_path, pages) = (directory.join(MANIFEST_FILE), &MANIFEST_PAGES);
    let mut manifest = read_json(&manifest_path);
    let head = read_slot(pages, &directory, &manifest["head"], "root");
    let (_, mut head) = head.unwrap().unwrap();
    head["texturePreviews"]["notes"][texture_preview::LEVEL_WRITE_FAILED] = json!(1);
    let tampered = json!(write_page(pages, &directory, &head, &[]).expect("head"));
    manifest["head"] = tampered.clone();
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).expect("tamper");
    let (second, events) = compile_with_events(&options);
    assert!(second["reused"].is_null(), "not reused");
    let swept = read_slot(pages, &directory, &tampered, "").is_err();
    assert!(
        swept,
        "the rebuild removes the refused head, which prune would keep"
    );
    assert_eq!(
        events[0]["reason"],
        "a texture level failed to write when the folder was compiled"
    );
    let notes = &paged(&directory).manifest["texturePreviews"]["notes"];
    assert!(
        notes[texture_preview::LEVEL_WRITE_FAILED].is_null(),
        "rebuilt whole"
    );
    // The same state read from the sidecar words: fewer levels baked than the tail starts at.
    let unfinished = manifest_binary::BakedLevels {
        sha256: "a".repeat(64),
        kind: 0,
        first: 1,
        baked: 0,
        layouts: [0; 2],
    };
    let refused = compiler_reuse_proof::check_textures(
        &options.cache.join("native"),
        &json!({}),
        &[unfinished],
    );
    assert_eq!(
        refused,
        Err(format!("texture {} was not fully baked", "a".repeat(64)))
    );
    fs::remove_dir_all(root).expect("cleanup");
}

// Behaviour: the answer sheet is a product of every compilation; a cache that
// lost it is not whole, and the compile that follows writes it again.
#[test]
fn a_missing_answer_sheet_is_not_reused() {
    let (root, options) = textured();
    let (first, _) = compile_with_events(&options);
    let sheet = options.cache.join(cutout::DECISIONS_FILE);
    fs::remove_file(&sheet).expect("remove sheet");
    let (second, events) = compile_with_events(&options);
    assert_eq!(second["key"], first["key"]);
    assert!(second["reused"].is_null(), "not reused");
    assert_eq!(events[0]["reason"], "cutout answer sheet is missing");
    assert!(sheet.is_file(), "the sheet is written again");
    let (_, events) = compile_with_events(&options);
    assert_eq!(events[0]["completed"], 1, "whole again: {events:?}");
    fs::remove_dir_all(root).expect("cleanup");
}

// Behaviour: two textures reading one image share its level files, counted once.
#[test]
fn shared_image_levels_are_counted_once() {
    let (root, options) = textured();
    let mut gltf = read_gltf(&options);
    gltf["textures"] = json!([{"source":0},{"source":0}]);
    gltf["materials"] = json!([
        {"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}},
        {"pbrMetallicRoughness":{"baseColorTexture":{"index":1}}}
    ]);
    let mut second = gltf["meshes"][0]["primitives"][0].clone();
    second["material"] = json!(1);
    gltf["meshes"][0]["primitives"]
        .as_array_mut()
        .expect("primitives")
        .push(second);
    write_gltf(&options, &gltf, None);
    let (first, _) = compile_with_events(&options);
    let sidecar = paged(&options.key_directory(first["key"].as_str().unwrap())).sidecars;
    let entries = manifest_binary::texture_levels(&sidecar[0]).expect("levels");
    assert_eq!(entries.len(), 2, "two textures read the image");
    assert!(entries.iter().all(|e| e.baked == 1), "one level file each");
    assert!(
        entries.iter().all(|e| e.layouts == [1, 0]),
        "kept in the BC family"
    );
    let (second, _) = compile_with_events(&options);
    // The lossless level and its BC7 twin, each once for both textures.
    assert_eq!(second["reused"]["textureLevels"], 2, "{}", second["reused"]);
    fs::remove_dir_all(root).expect("cleanup");
}

// Behaviour: a folder that fails one check — a corrupted object, sidecar or
// recorded file, a missing level — is refused with the reason, and rebuilt whole.
#[test]
fn corrupted_entry_is_rejected_and_rebuilt() {
    let (root, options) = textured();
    let (first, _) = compile_with_events(&options);
    let directory = options.key_directory(first["key"].as_str().unwrap());
    let native = options.cache.join("native");
    let sidecars = paged(&directory).sidecars;
    let object = manifest_binary::digests(&sidecars[1])
        .expect("digests")
        .remove(0);
    let manifest_binary::BakedLevels {
        sha256: level_sha,
        kind,
        ..
    } = manifest_binary::texture_levels(&sidecars[0])
        .expect("levels")
        .remove(0);
    let level = native.join(texture_preview::level_path(
        &level_sha,
        texture_preview::AtlasKind::from_word(kind).unwrap(),
        0,
        texture_preview::LOSSLESS,
    ));
    let corruptions: [(&str, PathBuf, Option<&[u8]>); 4] = [
        (
            "does not match its fingerprint",
            object_path(&options, &object),
            Some(b"corrupt"),
        ),
        (
            "is not the sidecar its page names",
            directory.join(sidecar_file(&hash(&sidecars[1]))),
            Some(b"corrupt"),
        ),
        (
            "source.bin is",
            directory.join("source.bin"),
            Some(b"corrupt"),
        ),
        ("texture level", level.clone(), None),
    ];
    for (reason, path, bytes) in corruptions {
        let intact = fs::read(&path).expect("product");
        match bytes {
            Some(bytes) => fs::write(&path, bytes).expect("corrupt"),
            None => fs::remove_file(&path).expect("remove"),
        }
        let (second, events) = compile_with_events(&options);
        assert!(second["reused"].is_null(), "{reason}: not reused");
        let announced = events[0]["reason"].as_str().unwrap();
        assert!(announced.contains(reason), "{reason}: {announced}");
        assert_eq!(
            fs::read(&path).expect("rebuilt"),
            intact,
            "{reason}: rebuilt whole"
        );
    }
    let (third, events) = compile_with_events(&options);
    assert_eq!(events[0]["completed"], 1, "whole again, reused: {events:?}");
    assert_eq!(third["key"], first["key"]);
    fs::remove_dir_all(root).expect("cleanup");
}
