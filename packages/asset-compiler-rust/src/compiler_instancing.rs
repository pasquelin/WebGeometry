//! `EXT_mesh_gpu_instancing`: a node that draws its mesh once per instance, each instance placed
//! by the translation, rotation and scale its accessors hold, applied before the node's own
//! transform. The load expands every instance into a child node that carries the mesh and that
//! pose, so the stages after it — selection, tables, proxy, physics, lights — place it by the one
//! world walk (`compiler_world::world_matrices`) and none of them reads the extension.
use super::*;

const EXTENSION: &str = "EXT_mesh_gpu_instancing";
/// The instance attributes, the node field each one fills, and its width.
const POSES: [(&str, &str, usize); 3] = [
    ("TRANSLATION", "translation", 3),
    ("ROTATION", "rotation", 4),
    ("SCALE", "scale", 3),
];
/// What an instance takes from its node: the mesh and what binds to that mesh.
const CARRIED: [&str; 3] = ["mesh", "skin", "weights"];

/// One child node per instance, carrying the node's mesh, skin and morph weights.
fn instances(g: &Value, bin: &[u8], node: &Value, attributes: &Value) -> Result<Vec<Value>> {
    let mut template = serde_json::Map::new();
    for field in CARRIED {
        if let Some(value) = node.get(field) {
            template.insert(field.into(), value.clone());
        }
    }
    let mut out: Option<Vec<Value>> = None;
    for (attribute, field, width) in POSES {
        let Some(index) = attributes.get(attribute) else {
            continue;
        };
        let values = accessor(g, bin, required_index(Some(index), attribute)?, None)?;
        if values.width != width {
            return Err(invalid(format!(
                "{EXTENSION} {attribute} has the wrong type"
            )));
        }
        // Decoded first: `collect_f32` bounds the count by what memory can hold, so a sparse
        // accessor that declares billions of instances is refused, never allocated blindly.
        let poses = values.collect_f32()?;
        let out = match &mut out {
            Some(out) => out,
            None => {
                let mut children = reserve(values.count)?;
                children.resize(values.count, Value::Object(template.clone()));
                out.insert(children)
            }
        };
        if out.len() != values.count {
            return Err(invalid(format!("{EXTENSION} attributes differ in count")));
        }
        for (child, pose) in out.iter_mut().zip(poses.chunks_exact(width)) {
            child[field] = json!(pose);
        }
    }
    let mut out = out.ok_or_else(|| invalid(format!("{EXTENSION} names no attribute")))?;
    if let Some(name) = node.get("name").and_then(Value::as_str) {
        for (at, child) in out.iter_mut().enumerate() {
            child["name"] = json!(format!("{name}#{at}"));
        }
    }
    Ok(out)
}

/// Replaces each instanced mesh of `g` by child nodes, one per instance, appended after every
/// existing node so no index the document already holds moves. The instanced node keeps its own
/// transform, children, light and camera; its mesh leaves it for its instances.
pub(super) fn expand_gpu_instances(g: &mut Value, bin: &[u8]) -> Result<()> {
    let Some(nodes) = g.get("nodes").and_then(Value::as_array) else {
        return Ok(());
    };
    let mut expanded = Vec::new();
    for (id, node) in nodes.iter().enumerate() {
        let attributes = node
            .get("extensions")
            .and_then(|e| e.get(EXTENSION)?.get("attributes"));
        if let (Some(attributes), Some(_)) = (attributes, node.get("mesh")) {
            expanded.push((id, instances(g, bin, node, attributes)?));
        }
    }
    if expanded.is_empty() {
        return Ok(());
    }
    let nodes = g["nodes"].as_array_mut().expect("nodes checked above");
    let mut moved = Vec::with_capacity(expanded.len());
    for (id, children) in expanded {
        let first = nodes.len();
        let node = nodes[id]
            .as_object_mut()
            .expect("an instanced node is an object");
        for field in CARRIED {
            node.remove(field);
        }
        if let Some(extensions) = node.get_mut("extensions").and_then(Value::as_object_mut) {
            extensions.remove(EXTENSION);
        }
        node.entry("children")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| invalid("node.children is not an array"))?
            .extend((first..first + children.len()).map(|child| json!(child)));
        nodes.extend(children);
        moved.push((id, first..nodes.len()));
    }
    retarget_weight_channels(g, &moved);
    for list in ["extensionsUsed", "extensionsRequired"] {
        if let Some(names) = g.get_mut(list).and_then(Value::as_array_mut) {
            names.retain(|name| name != EXTENSION);
        }
    }
    Ok(())
}

/// A morph animation that drove the instanced node's `weights` drives each instance instead: the
/// weights left the node with its mesh, and a channel still aimed at it would move nothing.
fn retarget_weight_channels(g: &mut Value, moved: &[(usize, std::ops::Range<usize>)]) {
    let Some(animations) = g.get_mut("animations").and_then(Value::as_array_mut) else {
        return;
    };
    for animation in animations {
        let Some(channels) = animation.get_mut("channels").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut added = Vec::new();
        channels.retain(|channel| {
            let weights =
                channel.pointer("/target/path").and_then(Value::as_str) == Some("weights");
            let target = channel.pointer("/target/node").and_then(Value::as_u64);
            let Some((_, children)) = moved
                .iter()
                .find(|(id, _)| weights && target == Some(*id as u64))
            else {
                return true;
            };
            for child in children.clone() {
                let mut copy = channel.clone();
                copy["target"]["node"] = json!(child);
                added.push(copy);
            }
            false
        });
        channels.extend(added);
    }
}
