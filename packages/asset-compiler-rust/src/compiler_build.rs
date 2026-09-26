use super::*;
use compiler_autonomous::write_autonomous_scene;

pub fn compile(o: &Options, progress: impl Fn(Value) + Sync) -> Result<Value> {
    check(o)?;
    validate_compile_options(o)?;
    let started = Instant::now();
    // Phase counters of this job, and of no other: they follow the thread until return.
    let phases = perf::JobPhases::default();
    let _attached = phases.attach();
    // Held until return: two simultaneous compilations of one cache would erase each
    // other, each pruning what the other just published.
    let _lock = CacheLock::acquire(o)?;
    // The router picks the format driver and has it produce the intermediate scene;
    // everything after reads only a glTF, without knowing which format it came from.
    let progress = with_ratio(progress);
    // Cutout answers, read before any conversion (`cutout.rs`).
    let decisions = cutout::load_decisions(&o.cache, &o.source)?;
    let routed: RoutedSource = plugins::scene::prepare_source(o, &progress)?;
    // Root where relative image URIs resolve, read before any move of `o.source`
    // onto the cache: a converted scene wrote it there, its images stayed where the driver read them.
    let image_root = routed.scene.images(&o.source);
    let imported;
    let o = if let PreparedScene::Converted { directory, .. } = &routed.scene {
        imported = Options {
            source: directory.clone(),
            ..o.clone()
        };
        &imported
    } else {
        o
    };
    let mut loaded = load_runtime(o, &routed.scene)?;
    let bin = loaded.binary.bytes();
    let g_bytes = &loaded.g_bytes;
    let manifest = &loaded.manifest;
    // A hierarchy that closes on itself is refused before any publication: world
    // matrix walk starts from parentless nodes, and would never see a closed cycle.
    compiler_nodes::check_acyclic(&loaded.g)?;
    // Set of nodes of the rendered scene, shared by selection, the proxy and lights.
    let scene_nodes = compiler_nodes::scene_nodes(&loaded.g)?;
    let NodeSelection {
        chosen,
        selected_triangles,
        skinned_meshes,
        meshes,
        mesh_map,
    } = select_nodes(o, &loaded.g, &scene_nodes)?;
    // Decided cutouts go to masked before any material is read (`cutout.rs`).
    let cutouts = cutout::apply_decisions(&mut loaded.g, bin, &image_root, &meshes, &decisions)?;
    let g = &loaded.g;
    // Identity of the product, not the raw bytes of what the source declares:
    // conversion timings leave it, images the scene cites enter it, answers too.
    let key = compiler_identity::cache_key(o, &loaded, &image_root, &cutouts.applied)?;
    // The pool is born and dies with this job: its workers adopt its counters, not a neighbour's.
    let pool = phases.pool(o.threads)?;
    // A folder already holding this product is proven, then kept as is (`compiler_reuse.rs`).
    if let Some(reused) = compiler_reuse::reuse(o, &key, &pool, &progress)? {
        return compiler_reuse::finish(o, &key, reused, started, &progress);
    }
    let mesh_values = values(g, "meshes")?;
    let view_values = values(g, "bufferViews")?;
    let BufferPlan {
        accessors,
        jobs,
        access_map,
        views,
        view_map,
        estimated_working_bytes,
    } = plan_buffers(o, g, bin, g_bytes, &meshes)?;
    let (directory, output_views, source_bin) = copy_source_bin(o, bin, view_values, &views, &key)?;
    let offset = source_bin.bytes as usize;
    let import_ms = shared_math::elapsed_ms(started);
    progress(
        json!({"phase":"import","completed":1,"total":1,"ms":import_ms,"primitives":jobs.len(),"nodes":chosen.len()}),
    );
    let cluster_start = Instant::now();
    // Compact per-page index storage is bounded independently from source size. Metadata is retained.
    // World scale of each mesh is read before the loop: the proxy threshold is in
    // metres, and a primitive placed under a scale cannot know it on its own.
    let mesh_scales = proxy::mesh_scales(g, &chosen)?;
    let primitive_inputs = PrimitiveInputs {
        o,
        g,
        bin,
        mesh_values,
        skinned_meshes: &skinned_meshes,
        mesh_map: &mesh_map,
        mesh_scales: &mesh_scales,
        scene_triangles: selected_triangles,
        validated: &accessors,
        progress: &progress,
    };
    let mut compiled: Vec<CompiledPrimitive> = pool.install(|| {
        jobs.par_iter()
            .map(|(m, p)| compile_primitive(&primitive_inputs, m, p).map_err(|e| e.within(*m, *p)))
            .collect::<Result<Vec<_>>>()
    })?;
    let collisions: Vec<Value> = compiled.iter_mut().map(|c| c.collision.take()).collect();
    let (mut primitives, cluster_planes, proxy_cuts, proxy_thresholds) =
        compiler_coplanar::split_compiled(compiled);
    let bootstrap_bundles = {
        let _t = perf::Timer::new(perf::Phase::PageWrite);
        share_bootstrap_bundles(o, &mut primitives)?
    };
    progress(json!({"phase":"bootstrap","completed":bootstrap_bundles,"total":bootstrap_bundles}));
    let scene = compiler_coplanar::DepthLayerScene {
        o,
        g,
        bin,
        chosen: &chosen,
        mesh_map: &mesh_map,
        cluster_planes: &cluster_planes,
    };
    let coplanar_report =
        compiler_coplanar::stage_depth_layers(&scene, &mut primitives, &progress)?;
    let (source, source_gltf) = write_source_scene(SourceSceneInputs {
        g,
        o,
        meshes: &meshes,
        chosen: &chosen,
        mesh_map: &mesh_map,
        accessors: &accessors,
        access_map: &access_map,
        view_map: &view_map,
        directory: &directory,
        output_views: &output_views,
        offset,
    })?;
    // Mip chain of each atlas texture and the cutout sheet, on the pool.
    let (texture_previews, texture_preview_report, cutout_report) = stage_textures(
        &pool,
        &TextureStage {
            o,
            g,
            bin,
            image_root: &image_root,
            meshes: &meshes,
            view_map: &view_map,
            decisions: &decisions,
            applied: &cutouts,
            primitives: &primitives,
        },
        &progress,
    )?;
    // Resident proxy: coarse cuts and previews in hand, node hierarchy still there.
    let scene_proxy = {
        let _t = perf::Timer::new(perf::Phase::Manifest);
        proxy::stage_proxy(&proxy::ProxyInputs {
            g,
            chosen: &chosen,
            mesh_map: &mesh_map,
            primitives: &primitives,
            cuts: &proxy_cuts,
            thresholds: &proxy_thresholds,
            previews: &texture_previews,
        })?
    };
    progress(
        json!({"phase":"proxy","completed":1,"total":1,"triangles":scene_proxy.triangle_count(),"nodes":scene_proxy.node_count(),"errorMetres":scene_proxy.error_metres}),
    );
    // The proxy is its own cache object: a manifest stays readable without its tens of megabytes.
    let proxy_bytes = scene_proxy.encode();
    let proxy_sha = hash(&proxy_bytes);
    let proxy_descriptor =
        scene_proxy.descriptor(proxy::SCENE_PROXY_FILE, &proxy_sha, proxy_bytes.len());
    // Cache products, each under its own name: lights, node and material tables, physics.
    let lights = stage_scene_lights(g, bin, &scene_nodes, &directory, &progress)?;
    let (autonomous_scene, autonomous_refusal, autonomous, mut products) =
        write_autonomous_scene(&directory, &source, &primitives, &output_views)?;
    let paged = write_mesh_pages(&primitives, &directory)?;
    let tables = stage_scene_tables(
        &source,
        autonomous.as_ref(),
        &paged.by_mesh,
        &directory,
        &progress,
    )?;
    let (physics_file, physics) = stage_physics(&scene, &primitives, &collisions, &directory)?;
    products.extend([tables, source_bin, source_gltf, lights, physics_file]);
    let unsupported = compiler_format::unsupported(&o.simplification, autonomous_refusal);
    let cache_format = compiler_format::cache_format(&primitives);
    let mut result = json!({"schema":cache_format,"formatVersion":cache_format,"compilerVersion":COMPILER_VERSION,"errorModel":DAG_ERROR_MODEL,"geometryPages":compiler_page_object::geometry_page_format(),"status":"ready","key":key,"scenePlugin":routed.plugin.map(plugins::provenance),"scope":o.scope,"clusterStrategy":DAG_CLUSTER_STRATEGY,"coplanar":coplanar_report,"texturePreviews":texture_preview_report,"cutouts":cutout_report,"proxy":proxy_descriptor,"physics":physics,"selectedTriangles":selected_triangles,"sourceTriangles":manifest["runtime"]["trianglesAcrossNodes"],"selectedNodes":chosen.len(),"totalNodes":manifest["runtime"]["meshNodes"],"autonomousScene":autonomous_scene,"primitives":primitives,"simplification":o.simplification!="none","gpuDriven":false,"metrics":{"importMs":import_ms,"clusterHierarchyPagesMs":shared_math::elapsed_ms(cluster_start),"compileMs":shared_math::elapsed_ms(started),"sourceMappedBytes":bin.len(),"outputGeometryBytes":offset,"phaseElapsedMs":phases.report(),"threads":o.threads,"ramBudgetMb":o.ram_budget_mb,"admissionEstimatedBytes":estimated_working_bytes,"peakRssBytes":null,"cpuMs":null,"diskBytesRead":null},"unsupported":unsupported});
    publish(
        &Publication {
            o,
            key: &key,
            directory: &directory,
            cache_format,
            proxy_bytes: &proxy_bytes,
            proxy_sha: &proxy_sha,
            products: &products,
            previews: &texture_previews,
            mesh_pages: &paged,
        },
        &result,
    )?;
    // Prune belongs to the job: the manifest carries `compileMs`, the caller `wallMs` after it.
    let prune_start = Instant::now();
    let keep = Keep::of_result(&result, &texture_previews)?;
    let pruned = prune_cache(o, &key, keep, &progress)?;
    result["metrics"]["pruneMs"] = json!(shared_math::elapsed_ms(prune_start));
    result["metrics"]["wallMs"] = json!(shared_math::elapsed_ms(started));
    progress(json!({"phase":"complete","completed":1,"total":1,"pruned":pruned}));
    Ok(result)
}
