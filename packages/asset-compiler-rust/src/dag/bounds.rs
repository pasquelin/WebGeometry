use crate::shared_math::{extend_aabb, length, point};

/// AABB centre plus the farthest vertex. Conservative and deterministic.
pub fn bounding_sphere(positions: &[f32], indices: &[u32]) -> [f64; 4] {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for &id in indices {
        extend_aabb(&mut min, &mut max, point(positions, id));
    }
    if !min[0].is_finite() {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let centre = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    let mut radius = 0.0_f64;
    for &id in indices {
        let p = point(positions, id);
        let d =
            ((p[0] - centre[0]).powi(2) + (p[1] - centre[1]).powi(2) + (p[2] - centre[2]).powi(2))
                .sqrt();
        if d > radius {
            radius = d;
        }
    }
    [centre[0], centre[1], centre[2], radius]
}

/// Merging two bounding spheres. Engine side mirror is `growSphere` in
/// `packages/sdk-browser/src/page/cut/bounds.ts`: same formula, two languages, no code
/// shared. Fallback is sequential and non-commutative — sphere order decides result,
/// so `enclosing_sphere` neither reorders nor parallelizes its list.
pub(super) fn merge_spheres(left: [f64; 4], right: [f64; 4]) -> [f64; 4] {
    if right[3] < 0.0 {
        return left;
    }
    if left[3] < 0.0 {
        return right;
    }
    let delta = [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
    let distance = length(delta);
    if distance + right[3] <= left[3] {
        return left;
    }
    if distance + left[3] <= right[3] {
        return right;
    }
    let radius = (distance + left[3] + right[3]) * 0.5;
    let t = if distance > 0.0 {
        (radius - left[3]) / distance
    } else {
        0.0
    };
    [
        left[0] + delta[0] * t,
        left[1] + delta[1] * t,
        left[2] + delta[2] * t,
        radius,
    ]
}

/// Monotone parent bounds: the result encloses every input sphere.
pub fn enclosing_sphere(spheres: &[[f64; 4]]) -> [f64; 4] {
    let mut result = [0.0, 0.0, 0.0, -1.0];
    for &sphere in spheres {
        result = merge_spheres(result, sphere);
    }
    if result[3] < 0.0 {
        result[3] = 0.0;
    }
    result
}

/// Local vertex buffer for a triangle region. Dense inputs use a direct table, sparse ones a map.
/// Spatial clusters of at most `max_triangles` triangles, built with meshopt's meshlet builder.
/// meshopt 0.4 exposes `build_meshlets`; it does not expose a cluster partitioner, so grouping
/// below uses a local recursive bisection instead.
pub(super) fn cluster_bounds(positions: &[f32], indices: &[u32]) -> ([f64; 3], [f64; 3]) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for &id in indices {
        extend_aabb(&mut min, &mut max, point(positions, id));
    }
    if !min[0].is_finite() {
        return ([0.0; 3], [0.0; 3]);
    }
    (min, max)
}
