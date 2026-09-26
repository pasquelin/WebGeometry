use super::*;
use crate::dag::{DagCluster, DagGroup};

/// Packs ranks greedily into bundles of at most `STREAM_BUNDLE_BYTES`, a bundle never empty. Each
/// rank comes with the bundles holding its parents, ascending: a bundle is closed early rather than
/// need more than `bound` of them, and a rank that alone needs more is refused with its page named.
fn pack(
    ranks: &[(usize, Vec<usize>)],
    size: impl Fn(usize) -> usize,
    bound: usize,
    bundles: &mut Vec<Vec<usize>>,
) -> Result<()> {
    let mut current = Vec::new();
    let mut held = 0usize;
    let mut needed: Vec<usize> = Vec::new();
    for (rank, holders) in ranks {
        if holders.len() > bound {
            return Err(CompilerError::new(
                "PAGE_DEPENDENCY_BOUND",
                format!(
                    "Page {rank} has its parents in {} streaming bundles, over the bound of {bound}",
                    holders.len()
                ),
            ));
        }
        let bytes = size(*rank);
        let fresh = holders
            .iter()
            .filter(|holder| needed.binary_search(holder).is_err())
            .count();
        if !current.is_empty()
            && (held + bytes > STREAM_BUNDLE_BYTES || needed.len() + fresh > bound)
        {
            bundles.push(std::mem::take(&mut current));
            held = 0;
            needed.clear();
        }
        for &holder in holders {
            if let Err(at) = needed.binary_search(&holder) {
                needed.insert(at, holder);
            }
        }
        current.push(*rank);
        held += bytes;
    }
    if !current.is_empty() {
        bundles.push(current);
    }
    Ok(())
}

/// Bundles of culling ranks, the number of pinned ones, and the bundle of every DAG slot.
///
/// Roots come first and form their own bundles, level by level: the coarsest complete cover of the
/// primitive is a handful of pinned requests. The other levels follow from the coarsest to the
/// finest, a bundle holding one level only. Within a level, clusters are sorted by the first
/// bundle holding one of their parents, then by culling rank: siblings, which share parents, land
/// in the same bundle, and a bundle depends on as few others as the spatial order allows — never
/// more than `bound` directly, the bound [`dependency_bound`] fixes before packing.
pub(super) fn pack_bundles(
    dag: &[DagCluster],
    groups: &[DagGroup],
    order: &[usize],
    bound: usize,
) -> Result<(Vec<Vec<usize>>, usize, Vec<usize>)> {
    let size = |rank: usize| dag[order[rank]].indices.len() * 4;
    let mut bundles: Vec<Vec<usize>> = Vec::new();
    let mut bundle_of = vec![usize::MAX; dag.len()];
    let top = dag.iter().map(|cluster| cluster.level).max().unwrap_or(0);
    let mut place = |root: bool, level: usize, bundles: &mut Vec<Vec<usize>>| -> Result<()> {
        let mut ranks: Vec<(usize, Vec<usize>)> = (0..order.len())
            .filter(|&rank| {
                let cluster = &dag[order[rank]];
                cluster.is_root() == root && cluster.level == level
            })
            .map(|rank| {
                let mut holders: Vec<usize> = parents_of(&dag[order[rank]], groups)
                    .iter()
                    .map(|&slot| bundle_of[slot])
                    .collect();
                holders.sort_unstable();
                holders.dedup();
                (rank, holders)
            })
            .collect();
        ranks
            .sort_by_key(|(rank, holders)| (holders.first().copied().unwrap_or(usize::MAX), *rank));
        let first = bundles.len();
        pack(&ranks, size, bound, bundles)?;
        for (index, bundle) in bundles.iter().enumerate().skip(first) {
            for &rank in bundle {
                bundle_of[order[rank]] = index;
            }
        }
        Ok(())
    };
    for level in 0..=top {
        place(true, level, &mut bundles)?;
    }
    let pinned = bundles.len();
    for level in (0..=top).rev() {
        place(false, level, &mut bundles)?;
    }
    Ok((bundles, pinned, bundle_of))
}

pub(super) fn bundle_dag_pages(
    o: &Options,
    dag: &[DagCluster],
    groups: &[DagGroup],
    order: &[usize],
    base_id: usize,
    pos: &[f32],
    store_packed: &(impl Fn(&[u32]) -> Result<(Value, bool)> + Sync),
) -> Result<(Vec<Value>, i32, Value)> {
    let mut pages = Vec::new();
    let mut reused = 0i32;
    let bound = dependency_bound(dag, groups);
    let (bundles, pinned_bundles, bundle_of) = pack_bundles(dag, groups, order, bound)?;
    let direct = direct_dependencies(dag, groups, &bundle_of, bundles.len());
    let dependencies = close_dependencies(&direct)?;
    verify_dependencies(
        dag,
        groups,
        order,
        &bundle_of,
        &dependencies,
        pinned_bundles,
    )?;
    let max_dependencies = dependencies.iter().map(Vec::len).max().unwrap_or(0);
    struct Bundle {
        url: String,
        digest: String,
        bytes: usize,
        count: usize,
        pages: Vec<(usize, Value)>,
        reused: i32,
    }
    let built:Vec<Bundle>=bundles.par_iter().enumerate().map(|(bundle_index,members)|->Result<Bundle>{
     check(o)?;
     let mut payload=Vec::new();
     let mut emitted=Vec::with_capacity(members.len());
     let mut reused=0i32;
     for &rank in members{
      let cluster=&dag[order[rank]];
      let offset=payload.len();
      let mut min=[f64::INFINITY;3];let mut max=[f64::NEG_INFINITY;3];
      {let _t=perf::Timer::new(perf::Phase::PageBytes);
       for &id in &cluster.indices{let index=id as usize;if index*3+2>=pos.len(){return Err(invalid("Invalid cluster index"));}payload.extend_from_slice(&id.to_le_bytes());crate::shared_math::extend_aabb(&mut min,&mut max,[pos[index*3] as f64,pos[index*3+1] as f64,pos[index*3+2] as f64]);}}
      let bytes=&payload[offset..];
      let digest={let _t=perf::Timer::new(perf::Phase::PageHash);hash(bytes)};
      let name=format!("../../objects/{}.bin",digest);let target=object_path(o,&digest);
      {let _t=perf::Timer::new(perf::Phase::PageWrite);if object_intact(&target,&digest)?.is_some(){reused+=1;}else{store_object(&target,bytes)?;}}
      let (geometry,packed_reused)={let _t=perf::Timer::new(perf::Phase::PagePacked);store_packed(&cluster.indices)?};if packed_reused{reused+=1;}
      let finite_parent=cluster.parent_error.is_finite();
      emitted.push((base_id+rank,json!({"id":base_id+rank,"url":name,"sha256":digest,"bytes":bytes.len(),"count":cluster.indices.len(),"start":cluster.source_rank as usize*3,"min":min,"max":max,
       "cone":({let [x,y,z,a]=trillion3d_page_codec::normal_cone::triangle_cone(pos,&cluster.indices);json!({"axis":[x,y,z],"angle":a})}),"role":if cluster.level==0{"exact"}else{"coarse"},"geometry":geometry,"level":cluster.level,
       "lodError":cluster.lod_error,"sphere":cluster.sphere,
       "parentError":if finite_parent{json!(cluster.parent_error)}else{Value::Null},
       "parentSphere":if finite_parent{json!(cluster.parent_sphere)}else{Value::Null},
       "group":match cluster.group{Some(index)=>json!(index),None=>Value::Null},
       "source":match cluster.source{Some(index)=>json!(index),None=>Value::Null},
       "stream":bundle_index,"streamOffset":offset})));
     }
     let digest={let _t=perf::Timer::new(perf::Phase::PageHash);hash(&payload)};
     let target=object_path(o,&digest);
     {let _t=perf::Timer::new(perf::Phase::PageWrite);if object_intact(&target,&digest)?.is_none(){store_object(&target,&payload)?;}}
     Ok(Bundle{url:format!("../../objects/{}.bin",digest),digest,bytes:payload.len(),count:members.len(),pages:emitted,reused})
    }).collect::<Result<Vec<_>>>()?;
    let mut ordered: Vec<Option<Value>> = vec![None; order.len()];
    let mut streams = Vec::with_capacity(built.len());
    for (bundle, dependencies) in built.into_iter().zip(dependencies) {
        reused += bundle.reused;
        streams.push(json!({"url":bundle.url,"sha256":bundle.digest,"bytes":bundle.bytes,"count":bundle.count,"dependencies":dependencies}));
        for (id, page) in bundle.pages {
            ordered[id - base_id] = Some(page);
        }
    }
    pages.reserve(ordered.len());
    for page in ordered {
        pages.push(page.ok_or_else(|| {
            CompilerError::new("INVALID_CLUSTER_PARTITION", "A cluster was not bundled")
        })?);
    }
    let stream_report = json!({"version":STRUCTURE_VERSION,"pinned":pinned_bundles,"bundleBytes":STREAM_BUNDLE_BYTES,"dependencyBound":bound,"maxDependencies":max_dependencies,"pages":streams});
    Ok((pages, reused, stream_report))
}
