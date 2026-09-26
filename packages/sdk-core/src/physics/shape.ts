import { EngineError } from '../contracts/cache.ts';
import type { Geometry } from '../world/geometry/geometry.ts';
import { readPoints } from '../world/geometry/bounds.ts';
import type { CompoundPart } from './commands.ts';
import { SHAPE } from './layout.ts';
import type { PhysicsPart, PhysicsPrimitive, PhysicsShape, PhysicsType } from './options.ts';

/** A shape ready for the ADD command: a primitive's sizes, or scaled vertices and indices. */
export interface ResolvedShape {
  shape: (typeof SHAPE)[keyof typeof SHAPE];
  size: [number, number, number];
  vertices?: Float32Array;
  indices?: Uint32Array;
  parts?: CompoundPart[];
  /** Triangles, counted `TRIANGLE_BYTES` each against the static collision (`collisionBytesOf`). */
  triangles: number;
}

type Scale = { x: number; y: number; z: number };

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));

/** The geometry's positions scaled into the body's frame. */
function scaledVertices(geometry: Geometry, scale: Scale) {
  const source = readPoints(geometry.getAttribute('position'));
  const vertices = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    vertices[i] = source[i] * scale.x;
    vertices[i + 1] = source[i + 1] * scale.y;
    vertices[i + 2] = source[i + 2] * scale.z;
  }
  return vertices;
}

/** The geometry's triangles, as indices into its vertices. */
function triangleIndices(geometry: Geometry, vertexCount: number) {
  return geometry.index
    ? Uint32Array.from(geometry.index.array)
    : Uint32Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i);
}

/** A primitive the declared or inferred shape names exactly, or `null` when the scale bends it. */
export function primitive(declared: PhysicsPrimitive, s: Scale): ResolvedShape | null {
  const x = Math.abs(s.x),
    y = Math.abs(s.y),
    z = Math.abs(s.z);
  const round = same(x, z);
  if (declared.type === 'box') {
    const [a, b, c] = declared.halfExtents;
    return { shape: SHAPE.box, size: [a * x, b * y, c * z], triangles: 0 };
  }
  if (declared.type === 'sphere' && round && same(x, y))
    return { shape: SHAPE.sphere, size: [declared.radius * x, 0, 0], triangles: 0 };
  if (declared.type === 'capsule' && round && same(x, y))
    return {
      shape: SHAPE.capsule,
      size: [declared.halfHeight * y, declared.radius * x, 0],
      triangles: 0,
    };
  // A bottom radius only when it differs from the top's: the module tapers a cylinder given one.
  if (declared.type === 'cylinder' && round) {
    const bottom = declared.radiusBottom ?? declared.radius;
    const tapered = same(bottom, declared.radius) ? 0 : bottom * x;
    return {
      shape: SHAPE.cylinder,
      size: [declared.halfHeight * y, declared.radius * x, tapered],
      triangles: 0,
    };
  }
  return null;
}

/**
 * A compound's parts scaled into the body's frame. A scale that differs between axes would shear
 * a turned part, and a mirrored one (a negative determinant) would move each part to its mirror
 * image with its turn unchanged: both are refused rather than approximated, the mesh `name`d.
 */
function compound(parts: readonly PhysicsPart[], s: Scale, name: string): ResolvedShape {
  if (!(s.x > 0 && s.y > 0 && s.z > 0) || !same(s.x, s.y) || !same(s.x, s.z)) {
    const mirror = s.x * s.y * s.z < 0 ? ', a mirror' : '';
    throw new EngineError(
      'PHYSICS_FAILED',
      `A compound shape needs the same positive scale on all axes: "${name}" has ${s.x}, ${s.y}, ${s.z}${mirror}.`,
      { name },
    );
  }
  const resolved = parts.map((part): CompoundPart => {
    const { shape, size } = primitive(part, s)!;
    const [x, y, z] = part.position ?? [0, 0, 0];
    const position = [x * s.x, y * s.y, z * s.z];
    return {
      shape: shape as CompoundPart['shape'],
      size,
      position,
      quaternion: part.quaternion ?? [0, 0, 0, 1],
    };
  });
  return { shape: SHAPE.compound, size: [0, 0, 0], parts: resolved, triangles: 0 };
}

/** The exact primitive a geometry was built as (`Geometry.recipe`), or `null`. */
function recipeShape(geometry: Geometry): PhysicsShape | null {
  const recipe = geometry.recipe;
  if (!recipe) return null;
  const a = recipe.args as number[];
  if (recipe.type === 'box')
    return { type: 'box', halfExtents: [(a[0] ?? 1) / 2, (a[1] ?? 1) / 2, (a[2] ?? 1) / 2] };
  if (recipe.type === 'sphere') return { type: 'sphere', radius: a[0] ?? 1 };
  if (recipe.type === 'capsule')
    return { type: 'capsule', halfHeight: (a[1] ?? 1) / 2, radius: a[0] ?? 1 };
  if (recipe.type === 'cylinder' && (a[0] ?? 1) === (a[1] ?? 1))
    return { type: 'cylinder', halfHeight: (a[2] ?? 1) / 2, radius: a[0] ?? 1 };
  return null;
}

/**
 * The collision shape of a body: the declared one, else the primitive its geometry was built as
 * (box, sphere, capsule, cylinder — exact), else its triangles when static, else the convex hull of
 * its vertices, computed in the worker. Triangles have no volume, hence no mass: a dynamic body
 * declared as triangles is refused (`PHYSICS_FAILED`); its shape is a hull.
 */
export function resolveShape(
  geometry: Geometry,
  scale: Scale,
  type: PhysicsType,
  declared?: PhysicsShape,
  /** The mesh's name, in a refusal. */
  name = '',
): ResolvedShape {
  const wanted = declared ?? recipeShape(geometry);
  if (wanted?.type === 'compound') return compound(wanted.parts, scale, name);
  const exact = wanted && wanted.type !== 'triangles' && wanted.type !== 'hull';
  const found = exact ? primitive(wanted, scale) : null;
  if (found) return found;
  if (wanted?.type === 'triangles' && type === 'dynamic')
    throw new EngineError(
      'PHYSICS_FAILED',
      `The dynamic body "${name}" cannot be triangles (no volume, no mass): use shape { type: 'hull' }.`,
      { name },
    );
  const triangles = wanted?.type === 'triangles' || (wanted?.type !== 'hull' && type === 'static');
  const vertices = scaledVertices(geometry, scale);
  if (!triangles) return { shape: SHAPE.hull, size: [0, 0, 0], vertices, triangles: 0 };
  const indices = triangleIndices(geometry, vertices.length / 3);
  return {
    shape: SHAPE.triangles,
    size: [0, 0, 0],
    vertices,
    indices,
    triangles: indices.length / 3,
  };
}
