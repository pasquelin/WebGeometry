# Trillion3D Documentation

The one index of the repository's documentation. The learning portal — guides, every public
function, live demos, examples and the measurement reports — is built from `site/` into
`dist/site/` and published on [www.trillion3d.com](https://www.trillion3d.com/); how it is
maintained is [LEARNING_PORTAL.md](LEARNING_PORTAL.md).

Start with [Create a world](SDK.md#create-a-world): `createWorld(canvasOrId)` owns the scene, the
camera, the renderer and the loop.

| Document                                               | Role                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SDK guide](SDK.md)                                    | The public API: principles, entry points, a world, its families, the loop, the renderer option, the maths reference, lights, budgets, integration, current limits |
| [Engine internals](ENGINE.md)                          | How a world draws: backend choice, page raster, surfaces, TAA, lighting, bounce, memory, diagnostics, and the lighting target and its stages                      |
| [Native compiler](COMPILER.md)                         | `trillion3d-compiler`: arguments, events, pointer, batch mode, cancellation, imports, input formats, adding a format, error codes                                 |
| [Cache format](FORMAT.md)                              | Pointer, `clusters.json` and its pages, cluster DAG, pages, textures, prepared scene tables                                                                  |
| [Package architecture](../packages/README.md)          | What each package owns, the native library, release work still required                                                                                           |
| [Tests and benchmarks](TESTS.md)                       | Test layout, GPU proofs, performance benchmarks, quality gates                                                                                                    |
| [Format fixtures](../tests/fixtures/formats/README.md) | The compiler's test inputs, one section per format: content, provenance, licence                                                                                  |
| [Measurement harness](../bench/runner/README.md)       | The bench, its options, the witnesses, the published reports                                                                                                      |
| [The reference in numbers](REFERENCE.md)               | The reference's published constants, bytes per triangle and profile, against ours                                                                                 |
| [Contributing](../CONTRIBUTING.md)                     | Engineering rules, measurement rules, the contribution workflow                                                                                                   |

Anything not described here is not part of the release. Open tasks are the
[GitHub issues](https://github.com/pasquelin/Trillion3D/issues).
