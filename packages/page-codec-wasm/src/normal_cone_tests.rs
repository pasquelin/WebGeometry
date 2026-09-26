use super::*;

#[test]
fn hypot_rounds_as_v8_does_where_a_plain_root_does_not() {
    // `Math.hypot` of these three in Node and Chrome; `sqrt` of the squares is one bit higher.
    let (x, y, z) = (0.4471859335899353, -0.1211518868803978, 0.4516414701938629);
    assert_eq!(hypot3(x, y, z).to_bits(), 0x3fe4b46054c7ac11);
    assert_ne!((x * x + y * y + z * z).sqrt().to_bits(), 0x3fe4b46054c7ac11);
    assert_eq!(hypot3(-3.0, 4.0, 12.0), 13.0);
    assert_eq!(hypot3(0.0, -0.0, 0.0).to_bits(), 0);
    assert_eq!(hypot3(f64::NAN, f64::NEG_INFINITY, 1.0), f64::INFINITY);
    assert!(hypot3(f64::NAN, 2.0, 1.0).is_nan());
}

#[test]
fn a_mesh_takes_the_runtime_axis_and_an_angle_raised_by_the_margin() {
    // Positions, indices and the four words `triangleCone` returns in Node for them; the last
    // triangle is degenerate and left out, as the TypeScript leaves it out. fdlibm's arccosine
    // gives Node's angle here, so the cooked one is that angle, the margin up.
    let pos: [f32; 18] = [
        0.0, 0.0, 0.0, 1.0, 0.0, 0.1, 0.3, 1.0, -0.2, -0.7, 0.4, 0.5, 0.2, -0.9, 0.3, 0.5, 0.5, 0.5,
    ];
    let indices = [0, 1, 2, 0, 2, 3, 0, 4, 1, 1, 5, 2, 0, 0, 1];
    let bits = triangle_cone(&pos, &indices).map(f64::to_bits);
    assert_eq!(
        bits,
        [
            0xbfafcd5945b39c98,
            0x3f9bd3ae78eabf1c,
            0x3fefed269ba2a178,
            0x3ffbff6614ce2016 + ANGLE_MARGIN_ULPS as u64
        ]
    );
}

#[test]
fn one_face_is_a_closed_cone_on_its_normal() {
    let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let [x, y, z, angle] = triangle_cone(&pos, &[0, 1, 2]);
    assert_eq!([x, y, z], [0.0, 0.0, 1.0]);
    assert_eq!(
        angle.to_bits(),
        ANGLE_MARGIN_ULPS as u64,
        "zero, the margin up"
    );
}

#[test]
fn no_face_or_cancelling_faces_leave_the_cone_open() {
    let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    assert_eq!(triangle_cone(&pos, &[]), OPEN_CONE);
    assert_eq!(triangle_cone(&pos, &[0, 0, 1, 2, 2, 2]), OPEN_CONE);
    assert_eq!(triangle_cone(&pos, &[0, 1, 2, 0, 2, 1]), OPEN_CONE);
}

#[test]
fn each_cluster_gets_the_cone_of_its_own_triangles() {
    let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let indices = [0, 1, 2, 0, 3, 1, 0, 2, 3];
    let mut out = [0.0; 8];
    assert_eq!(
        cluster_cones(&pos, &indices, &[0, 3, 3, 9], &mut out),
        Some(())
    );
    assert_eq!(out[..4], triangle_cone(&pos, &indices[..3]));
    assert_eq!(out[4..], triangle_cone(&pos, &indices[3..]));
}

#[test]
fn a_range_or_an_index_outside_the_input_writes_nothing() {
    let pos = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let mut out = [7.0; 4];
    assert_eq!(cluster_cones(&pos, &[0, 1, 3], &[0, 3], &mut out), None);
    assert_eq!(cluster_cones(&pos, &[0, 1, 2], &[0, 6], &mut out), None);
    assert_eq!(cluster_cones(&pos, &[0, 1, 2], &[3, 0], &mut out), None);
    assert_eq!(
        cluster_cones(&pos, &[0, 1, 2], &[0, 3, 0, 3], &mut out),
        None
    );
    assert_eq!(out, [7.0; 4]);
}
