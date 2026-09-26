//! A05 — Linked glTF images are read after the key is computed: their pixels
//! enter the product — sidecar texture previews — without entering the identity
//! that names it. A red PNG replaced by a blue PNG therefore left the key intact
//! while `clusters.bin` changed, and a consumer that reuses by the key kept the
//! previous previews.
use super::*;

/// A solid 8×8 PNG, whose colour distinguishes two files of the same name.
fn png(couleur: [u8; 4]) -> Vec<u8> {
    png_sized(8, couleur)
}

/// A solid square PNG of the given side: above 64 texels its levels are baked as files.
pub(in crate::tests) fn png_sized(side: u32, colour: [u8; 4]) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(side, side, image::Rgba(colour));
    let mut bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("png");
    bytes
}

/// The fixture, whose only material carries a base colour linked to `color.png`.
pub(in crate::tests) fn source_texturee() -> (PathBuf, Options, PathBuf) {
    let (root, options) = fixture();
    let mut gltf = read_gltf(&options);
    gltf["images"] = json!([{"uri":"color.png"}]);
    gltf["textures"] = json!([{"source":0}]);
    gltf["materials"] = json!([{"pbrMetallicRoughness":{"baseColorTexture":{"index":0}}}]);
    gltf["meshes"][0]["primitives"][0]["material"] = json!(0);
    write_gltf(&options, &gltf, None);
    let image = options.source.join("color.png");
    (root, options, image)
}

/// Compiles and returns the key exposed to the consumer with the fingerprint of
/// the binary sidecar written under that key: this pair must move together, or not at all.
fn key_and_sidecar(options: &Options) -> (String, String) {
    let result = compile(options, |_| {}).expect("compile");
    let key = result["key"].as_str().expect("key").to_string();
    let directory = options.cache.join("native").join(&options.scope).join(&key);
    (key, hash(&paged(&directory).sidecars.concat()))
}

// Behaviour: a linked image that changes changes the exposed key; the same image
// yields the same key,
// and two identical compilations do as well.
#[test]
fn a_modified_linked_image_changes_the_exposed_key() {
    let (root, options, image) = source_texturee();
    fs::write(&image, png([255, 0, 0, 255])).expect("red image");
    let (cle_rouge, sidecar_rouge) = key_and_sidecar(&options);
    let (cle_repetee, sidecar_repete) = key_and_sidecar(&options);
    assert_eq!(
        (&cle_rouge, &sidecar_rouge),
        (&cle_repetee, &sidecar_repete),
        "two identical compilations yield the same key and the same sidecar"
    );

    fs::write(&image, png([0, 0, 255, 255])).expect("blue image");
    let (cle_bleue, sidecar_bleu) = key_and_sidecar(&options);
    assert_ne!(
        sidecar_rouge, sidecar_bleu,
        "changed pixels do change the product"
    );
    assert_ne!(
        cle_rouge, cle_bleue,
        "a changed image must change the key exposed to the consumer"
    );

    fs::write(&image, png([255, 0, 0, 255])).expect("restored red image");
    let (cle_revenue, sidecar_revenu) = key_and_sidecar(&options);
    assert_eq!(
        (cle_rouge, sidecar_rouge),
        (cle_revenue, sidecar_revenu),
        "back to the previous image, the source finds its key again"
    );
    fs::remove_dir_all(root).expect("cleanup");
}

// Behaviour: an image that appears or disappears next to an unchanged scene
// changes the key as much as an image whose bytes change — absence is a state,
// not silence.
#[test]
fn a_linked_image_absent_then_present_changes_the_exposed_key() {
    let (root, options, image) = source_texturee();
    let (absente, _) = key_and_sidecar(&options);
    fs::write(&image, png([0, 255, 0, 255])).expect("green image");
    let (presente, _) = key_and_sidecar(&options);
    assert_ne!(
        absente, presente,
        "an image that appeared must change the exposed key"
    );
    fs::remove_file(&image).expect("remove");
    let (retiree, _) = key_and_sidecar(&options);
    assert_eq!(
        absente, retiree,
        "the removed image yields the previous key"
    );
    fs::remove_dir_all(root).expect("cleanup");
}
