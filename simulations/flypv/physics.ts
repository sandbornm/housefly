import RAPIER from '@dimforge/rapier3d-compat';
import { boundedVelocity, CEILING, DRONE_RADIUS, FIXED_DT, SPAWN, WORLD_LIMIT, type Point } from './flight.ts';
import { CLEARANCE_DIRECTIONS, CLEARANCE_RANGE } from './neural.ts';

export type ColliderSpec =
  | { kind: 'box'; x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw?: number }
  | { kind: 'cylinder'; x: number; y: number; z: number; radius: number; halfHeight: number }
  | { kind: 'hull'; vertices: Float32Array }
  | { kind: 'terrain'; vertices: Float32Array; indices: Uint32Array };

export class FlightPhysics {
  readonly world: RAPIER.World;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  contact = false;
  private disposed = false;

  constructor(specs: ColliderSpec[]) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this.world.integrationParameters.maxCcdSubsteps = 4;
    this.world.integrationParameters.numSolverIterations = 8;
    for (const spec of specs) {
      let shape: RAPIER.ColliderDesc | null;
      if (spec.kind === 'box') {
        shape = RAPIER.ColliderDesc.cuboid(spec.hx, spec.hy, spec.hz).setTranslation(spec.x, spec.y, spec.z);
        if (spec.yaw) shape.setRotation({ x: 0, y: Math.sin(spec.yaw / 2), z: 0, w: Math.cos(spec.yaw / 2) });
      } else if (spec.kind === 'cylinder') {
        shape = RAPIER.ColliderDesc.cylinder(spec.halfHeight, spec.radius).setTranslation(spec.x, spec.y, spec.z);
      } else if (spec.kind === 'hull') shape = RAPIER.ColliderDesc.convexHull(spec.vertices);
      else shape = RAPIER.ColliderDesc.trimesh(spec.vertices, spec.indices);
      if (shape) this.world.createCollider(shape.setFriction(.3).setRestitution(.06));
    }
    // Solid bounds remain a backstop when the assisted controller slows at the edge.
    for (const sign of [-1, 1]) {
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(1, 40, WORLD_LIMIT + 2).setTranslation(sign * (WORLD_LIMIT + 1), 20, 0));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(WORLD_LIMIT + 2, 40, 1).setTranslation(0, 20, sign * (WORLD_LIMIT + 1)));
    }
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(WORLD_LIMIT, 1, WORLD_LIMIT).setTranslation(0, CEILING + 1, 0));
    this.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(SPAWN.x, SPAWN.y, SPAWN.z).setGravityScale(0).lockRotations().setCcdEnabled(true).setSoftCcdPrediction(.7).setCanSleep(false));
    this.collider = this.world.createCollider(RAPIER.ColliderDesc.ball(DRONE_RADIUS).setMass(.8).setFriction(.15).setRestitution(.08), this.body);
  }

  step(desired: Point | null, sensitivity: number): void {
    this.body.setGravityScale(desired ? 0 : 1, true);
    if (desired) {
      const target = boundedVelocity(this.position(), desired);
      const current = this.body.linvel();
      const gain = 1 - Math.exp(-4.2 * sensitivity * FIXED_DT);
      const dx = (target.x - current.x) * gain, dy = (target.y - current.y) * gain, dz = (target.z - current.z) * gain;
      const limit = Math.min(1, 18 * FIXED_DT / Math.max(.00001, Math.hypot(dx, dy, dz)));
      this.body.setLinvel({ x: current.x + dx * limit, y: current.y + dy * limit, z: current.z + dz * limit }, true);
    }
    this.world.step();
    this.contact = false;
    this.world.contactPairsWith(this.collider, other => {
      // CCD can leave stale manifolds; query the colliders at their final positions.
      if (!this.contact && this.collider.contactCollider(other, .01)) this.contact = true;
    });
  }

  clearances(heading: number): Float32Array {
    const origin = this.position(), distances = new Float32Array(CLEARANCE_DIRECTIONS.length);
    for (const [index, direction] of CLEARANCE_DIRECTIONS.entries()) {
      const axis = direction === 'up' ? { x: 0, y: 1, z: 0 } : direction === 'down' ? { x: 0, y: -1, z: 0 }
        : { x: -Math.sin(heading + direction), y: 0, z: -Math.cos(heading + direction) };
      const hit = this.world.castRay(new RAPIER.Ray(origin, axis), CLEARANCE_RANGE + DRONE_RADIUS, true, undefined, undefined, this.collider, this.body);
      distances[index] = hit ? Math.max(0, hit.timeOfImpact - DRONE_RADIUS) : CLEARANCE_RANGE;
    }
    return distances;
  }

  position(): Point { const p = this.body.translation(); return { x: p.x, y: p.y, z: p.z }; }
  velocity(): Point { const v = this.body.linvel(); return { x: v.x, y: v.y, z: v.z }; }
  reset(position: Point = SPAWN): void { this.body.setTranslation(position, true); this.body.setLinvel({ x: 0, y: 0, z: 0 }, true); this.contact = false; }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.world.free(); } }
}

export async function initPhysics(): Promise<void> { await RAPIER.init(); }
