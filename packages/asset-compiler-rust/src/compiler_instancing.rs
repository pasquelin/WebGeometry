//! `EXT_mesh_gpu_instancing`: a node that draws its mesh once per instance, each instance placed
//! by the translation, rotation and scale its accessors hold, applied before the node's own
//! transform. The load expands every instance into a child node that carries the mesh and that
//! pose, so the stages after it — selection, tables, proxy, physics, lights — place it by the one
//! world walk (`compiler_world::world_matrices`) and none of them reads the extension.
use super::*;

const EXTENSION: &str = "EXT_mesh_gpu_instancing";

/// The `width`-wide values of the accessor `attributes[name]`, one per instance, or `None` when
/// the node does not name that attribute.
fn attribute(
    g: &Value,
    bin: &[u8],
    attributes: &Value,
    name: &str,
    width: usize,
) -> Result<Option<Vec<Vec<f64>>>> {
    let Some(index) = attributes.get(name) else {
        return Ok(None);
    };
    let values = accessor(g, bin, required_index(Some(index), name)?, None)?;
    if values.width != width {
        return Err(invalid(format!("{EXTENSION} {name} has the wrong type")));
    }
    (0..values.count)
        .map(|i| (0..width).map(|c| values.value(i, c)).collect())
        .collect::<Result<_>>()
        .map(Some)
}

/// One child node per instance, carrying `mesh` (and the morph `weights` that go with it).
fn instances(g: &Value, bin: &[u8], node: &Value, attributes: &Value) -> Result<Vec<Value>> {
    let poses = [("TRANSLATION", 3), ("ROTATION", 4), ("SCALE", 3)]
        .map(|(name, width)| attribute(g, bin, attributes, name, width).map(|v| (name, v)));
    let mut count = None;
    let mut out: Vec<Value> = Vec::new();
    for pose in poses {
        let (name, Some(values)) = pose? else {
            continue;
        };
        if *count.get_or_insert(values.len()) != values.len() {
            return Err(invalid(format!("{EXTENSION} attributes differ in count")));
        }
        out.resize_with(values.len(), || json!({"mesh": node["mesh"]}));
        let field = name.to_ascii_lowercase();
        for (child, value) in out.iter_mut().zip(values) {
            child[&field] = json!(value);
        }
    }
    if count.is_none() {
        return Err(invalid(format!("{EXTENSION} names no attribute")));
    }
    for (at, child) in out.iter_mut().enumerate() {
        if let Some(weights) = node.get("weights") {
            child["weights"] = weights.clone();
        }
        if let Some(name) = node.get("name").and_then(Value::as_str) {
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
        let path = format!("/extensions/{EXTENSION}/attributes");
        if let (Some(attributes), Some(_)) = (node.pointer(&path), node.get("mesh")) {
            expanded.push((id, instances(g, bin, node, attributes)?));
        }
    }
    if expanded.is_empty() {
        return Ok(());
    }
    let nodes = g["nodes"].as_array_mut().expect("nodes checked above");
    for (id, children) in expanded {
        let node = nodes[id]
            .as_object_mut()
            .ok_or_else(|| invalid("node is an object"))?;
        node.remove("mesh");
        node.remove("weights");
        if let Some(extensions) = node.get_mut("extensions").and_then(Value::as_object_mut) {
            extensions.remove(EXTENSION);
        }
        let first = nodes.len();
        let ids = (first..first + children.len()).map(|child| json!(child));
        match nodes[id].get_mut("children").and_then(Value::as_array_mut) {
            Some(list) => list.extend(ids),
            None => nodes[id]["children"] = json!(ids.collect::<Vec<_>>()),
        }
        nodes.extend(children);
    }
    for list in ["extensionsUsed", "extensionsRequired"] {
        if let Some(names) = g.get_mut(list).and_then(Value::as_array_mut) {
            names.retain(|name| name != EXTENSION);
        }
    }
    Ok(())
}
