import * as THREE from 'three';

// Maps real-world elastic moduli (Pa) into the mass-spring solver's stable working
// range while preserving material ratios. Tuned so 55D memory foam (mu=600 Pa) gives
// the well-behaved interactive response the engine was validated at.
const MOD_SCALE = 0.075;

export interface Particle {
  id: number;
  position: THREE.Vector3;
  prevPosition: THREE.Vector3;
  restPosition: THREE.Vector3;
  velocity: THREE.Vector3;
  force: THREE.Vector3;
  mass: number;
  invMass: number;
  isFixed: boolean;
  active: boolean; // False when this lattice node lies outside the imported model volume
  strain: number; // For visualization
}

export interface Spring {
  id: number;
  pA: number; // Particle A index
  pB: number; // Particle B index
  restLength: number;
  type: 'structural' | 'shear' | 'bending';
  // Prony series viscoelasticity history variables (3 Maxwell terms)
  h1: number; // History term 1 (Fast relaxation)
  h2: number; // History term 2 (Medium relaxation)
  h3: number; // History term 3 (Slow relaxation)
  prevElasticForceMag: number; // f^e at previous step
}

export interface SimParameters {
  // Neo-Hookean parameters (Pa)
  shearModulus: number; // mu
  bulkModulus: number; // K = lambda + 2*mu/3
  lambda: number;       // Neo-Hookean first Lamé parameter (Pa)

  // Linear-elastic descriptors (Pa / unitless), informational + node-mass model
  youngModulus: number; // E (Pa)
  poissonRatio: number; // nu
  density: number;      // kg/m^3 (e.g. 55 for 55D memory foam)

  // Prony series parameters (3 Maxwell terms)
  g1: number; tau1: number; // Fast
  g2: number; tau2: number; // Medium
  g3: number; tau3: number; // Slow
  // Note: g_infinity is automatically computed as 1 - g1 - g2 - g3

  // Rayleigh damping C = alpha*M + beta*K
  rayleighAlpha: number; // mass-proportional
  rayleighBeta: number;  // stiffness-proportional

  // Damping (legacy / derived)
  damping: number; // Dashpot damping along springs (driven by rayleighBeta)
  airResistance: number; // Global velocity damping (driven by rayleighAlpha)
  
  // Simulation config
  gravity: number;
  timeStep: number;
  subSteps: number;
  gridX: number;
  gridY: number;
  gridZ: number;
  
  // Contact parameters
  contactStiffness: number;
  groundStiffness: number;
  friction: number;
}

export class RigidPresser {
  public position: THREE.Vector3 = new THREE.Vector3(0, 15, 0);
  public prevPosition: THREE.Vector3 = new THREE.Vector3(0, 15, 0);
  public velocity: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  public radius: number = 4.5;
  public mass: number = 5.0; // kg for drop tests
  public shapeType: 'sphere' | 'custom' = 'sphere';
  public customMesh: THREE.Mesh | null = null;
  public boundingBox: THREE.Box3 = new THREE.Box3();
  // Head orientation (radians), full X/Y/Z. The custom collider transforms query
  // points by the inverse rotation (cached 3x3) into head-local space.
  public rotX: number = 0;
  public rotY: number = 0;
  public rotZ: number = 0;
  private ir00 = 1; private ir01 = 0; private ir02 = 0;
  private ir10 = 0; private ir11 = 1; private ir12 = 0;
  private ir20 = 0; private ir21 = 0; private ir22 = 1;

  public setRotation(rx: number, ry: number, rz: number) {
    this.rotX = rx; this.rotY = ry; this.rotZ = rz;
    // World-from-local = Euler(rx, ry, rz, 'XYZ'); inverse = transpose.
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
    const e = m.transpose().elements; // now local-from-world, column-major
    this.ir00 = e[0]; this.ir01 = e[4]; this.ir02 = e[8];
    this.ir10 = e[1]; this.ir11 = e[5]; this.ir12 = e[9];
    this.ir20 = e[2]; this.ir21 = e[6]; this.ir22 = e[10];
  }

  // Height-field collider for imported rigid bodies (in LOCAL, centered coords).
  // For each (x,z) column we store the mesh's lowest/highest surface so contact
  // conforms to the real underside shape instead of a coarse bounding box.
  private customLocalPos: ArrayLike<number> | null = null;
  private customBuckets: {
    minA: number; minB: number; cellA: number; cellB: number;
    res: number; buckets: Int32Array[];
  } | null = null;
  
  // Automatic testing modes
  public isControlled: boolean = true; // Slider control or free physics
  public autoCycleActive: boolean = false;
  public autoCycleAmplitude: number = 4.0;
  public autoCycleFrequency: number = 0.5; // Hz
  public autoCycleCenterY: number = 8.0;

  constructor() {}

  // Assign an imported mesh and precompute its (X,Z) height-field buckets so the
  // collider matches the real shape. The geometry is assumed centered at origin.
  public setCustomMesh(mesh: THREE.Mesh) {
    this.customMesh = mesh;
    this.shapeType = 'custom';
    const attr = mesh.geometry.getAttribute('position');
    this.customLocalPos = attr ? (attr.array as ArrayLike<number>) : null;
    this.buildCustomBuckets();
  }

  private buildCustomBuckets() {
    this.customBuckets = null;
    const pos = this.customLocalPos;
    if (!pos) return;
    const triCount = Math.floor(pos.length / 9);
    if (triCount === 0) return;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], z = pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const res = Math.max(8, Math.min(96, Math.round(Math.sqrt(triCount / 2))));
    const sizeX = Math.max(1e-6, maxX - minX);
    const sizeZ = Math.max(1e-6, maxZ - minZ);
    const cellA = sizeX / res, cellB = sizeZ / res;
    const clamp = (v: number) => (v < 0 ? 0 : v >= res ? res - 1 : v);

    const triRange = (t: number) => {
      const o = t * 9;
      const x0 = pos[o], x1 = pos[o + 3], x2 = pos[o + 6];
      const z0 = pos[o + 2], z1 = pos[o + 5], z2 = pos[o + 8];
      const ga0 = clamp(Math.floor((Math.min(x0, x1, x2) - minX) / cellA));
      const ga1 = clamp(Math.floor((Math.max(x0, x1, x2) - minX) / cellA));
      const gb0 = clamp(Math.floor((Math.min(z0, z1, z2) - minZ) / cellB));
      const gb1 = clamp(Math.floor((Math.max(z0, z1, z2) - minZ) / cellB));
      return { ga0, ga1, gb0, gb1 };
    };

    const counts = new Int32Array(res * res);
    for (let t = 0; t < triCount; t++) {
      const { ga0, ga1, gb0, gb1 } = triRange(t);
      for (let ga = ga0; ga <= ga1; ga++)
        for (let gb = gb0; gb <= gb1; gb++) counts[ga * res + gb]++;
    }
    const buckets: Int32Array[] = new Array(res * res);
    for (let b = 0; b < res * res; b++) buckets[b] = new Int32Array(counts[b]);
    const fillIdx = new Int32Array(res * res);
    for (let t = 0; t < triCount; t++) {
      const { ga0, ga1, gb0, gb1 } = triRange(t);
      for (let ga = ga0; ga <= ga1; ga++)
        for (let gb = gb0; gb <= gb1; gb++) {
          const b = ga * res + gb;
          buckets[b][fillIdx[b]++] = t;
        }
    }
    this.customBuckets = { minA: minX, minB: minZ, cellA, cellB, res, buckets };
  }

  // Local vertical span (min/max surface Y) of the imported mesh at column (lx,lz).
  // Returns [minY, maxY, hits]; hits < 2 means the column misses the mesh.
  private customColumnSpan(lx: number, lz: number): [number, number, number] {
    const pos = this.customLocalPos;
    const bk = this.customBuckets;
    if (!pos || !bk) return [0, 0, 0];
    const ga = Math.floor((lx - bk.minA) / bk.cellA);
    const gb = Math.floor((lz - bk.minB) / bk.cellB);
    if (ga < 0 || ga >= bk.res || gb < 0 || gb >= bk.res) return [0, 0, 0];
    const list = bk.buckets[ga * bk.res + gb];

    let minY = Infinity, maxY = -Infinity, hits = 0;
    const eps = 1e-6;
    for (let li = 0; li < list.length; li++) {
      const o = list[li] * 9;
      const ax = pos[o],     ay = pos[o + 1], az = pos[o + 2];
      const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
      const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (d > -eps && d < eps) continue;
      const inv = 1 / d;
      const l1 = ((bz - cz) * (lx - cx) + (cx - bx) * (lz - cz)) * inv;
      const l2 = ((cz - az) * (lx - cx) + (ax - cx) * (lz - cz)) * inv;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      const y = l1 * ay + l2 * by + l3 * cy;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      hits++;
    }
    return [minY, maxY, hits];
  }

  public update(time: number, dt: number) {
    if (this.autoCycleActive) {
      // Sinusoidal cyclic pressing test
      const targetY = this.autoCycleCenterY + this.autoCycleAmplitude * Math.sin(2 * Math.PI * this.autoCycleFrequency * time);
      this.prevPosition.copy(this.position);
      this.position.y = targetY; // preserve chosen X/Z horizontal position
      this.velocity.set(0, (this.position.y - this.prevPosition.y) / dt, 0);
    } else if (this.isControlled) {
      // Velocity is computed from manual slider changes
      this.velocity.set(0, (this.position.y - this.prevPosition.y) / dt, 0);
      this.prevPosition.copy(this.position);
    } else {
      // Free drop physics will be integrated in the main simulation loop
    }
  }

  // Check contact against a point
  // Returns penetration depth and contact normal pointing from presser to point
  public checkContact(point: THREE.Vector3, outNormal: THREE.Vector3): number {
    if (this.shapeType === 'sphere') {
      const dir = new THREE.Vector3().subVectors(point, this.position);
      const dist = dir.length();
      if (dist < this.radius) {
        if (dist > 0.0001) {
          outNormal.copy(dir).multiplyScalar(1 / dist);
        } else {
          outNormal.set(0, 1, 0);
        }
        return this.radius - dist;
      }
    } else if (this.shapeType === 'custom' && this.customBuckets) {
      // Height-field collider conforming to the imported mesh's real shape. Transform
      // the pillow point into the head's local (centered, un-rotated) frame so any
      // X/Y head orientation (e.g. side-sleep) collides with the correct profile.
      const dx = point.x - this.position.x;
      const dy = point.y - this.position.y;
      const dz = point.z - this.position.z;
      const lx = this.ir00 * dx + this.ir01 * dy + this.ir02 * dz;
      const ly = this.ir10 * dx + this.ir11 * dy + this.ir12 * dz;
      const lz = this.ir20 * dx + this.ir21 * dy + this.ir22 * dz;
      const [minYl, maxYl, hits] = this.customColumnSpan(lx, lz);
      if (hits >= 2 && ly > minYl && ly < maxYl) {
        // Inside the head volume: push the foam point down; depth from the local
        // underside drives the penalty force.
        outNormal.set(0, -1, 0);
        return ly - minYl;
      }
    }
    return 0;
  }
}

export class PillowSimulation {
  public particles: Particle[] = [];
  public springs: Spring[] = [];
  public parameters: SimParameters;
  public presser: RigidPresser;
  
  // Skinning binding for custom loaded STL mesh
  public rawStlVertices: THREE.BufferAttribute | null = null;
  public stlSkinningData: { indices: number[], weights: number[] }[] = [];
  // Original (undeformed) STL vertex positions, so the imported model keeps its
  // full detail: deformation is applied as a displacement, not an absolute skin.
  public stlRestPositions: Float32Array | null = null;
  
  // Real-time plotting statistics
  public timeElapsed: number = 0;
  public forceHistory: { time: number; displacement: number; force: number; energy: number }[] = [];
  public totalReactionForce: number = 0;
  public totalKineticEnergy: number = 0;
  
  // Anchoring style: 'bottom' | 'corners' | 'none'
  public anchorStyle: 'bottom' | 'corners' | 'none' = 'bottom';
  
  // Solver diagnostics
  public cgIterations: number = 0;

  // When an STL model is imported, its axis-aligned bounds are stored here so the
  // physical lattice (particles + springs) is regenerated to fit the real model.
  public modelBounds: { min: THREE.Vector3; size: THREE.Vector3 } | null = null;

  // Flat triangle-soup (non-indexed position array, 9 floats per triangle) of the
  // imported model, used for a point-in-mesh test so the lattice conforms to
  // irregular (non-box) pillow shapes.
  public modelPositions: ArrayLike<number> | null = null;

  // Regular-lattice layout info, enables O(1) analytic skinning lookups.
  private latticeInfo: {
    originX: number; originY: number; originZ: number;
    dx: number; dy: number; dz: number;
    gridX: number; gridY: number; gridZ: number;
  } | null = null;

  // Per-axis spatial buckets over the model triangles so a ray along that axis only
  // tests triangles overlapping the query point's cell (near-linear inside test).
  // Index 0 -> ray along +X (buckets over Y,Z); 1 -> +Y (X,Z); 2 -> +Z (X,Y).
  private axisBuckets: ({
    minA: number; minB: number; cellA: number; cellB: number;
    aIdx: number; bIdx: number; res: number; buckets: Int32Array[];
  } | null)[] = [null, null, null];

  constructor(parameters: SimParameters) {
    this.parameters = parameters;
    this.presser = new RigidPresser();
    this.resetPillow();
  }

  private buildTriangleBuckets() {
    this.axisBuckets = [null, null, null];
    const pos = this.modelPositions;
    if (!pos || !this.modelBounds) return;

    const triCount = Math.floor(pos.length / 9);
    if (triCount === 0) return;

    const res = Math.max(8, Math.min(96, Math.round(Math.sqrt(triCount / 2))));
    const bmin = [this.modelBounds.min.x, this.modelBounds.min.y, this.modelBounds.min.z];
    const bsize = [
      Math.max(1e-6, this.modelBounds.size.x),
      Math.max(1e-6, this.modelBounds.size.y),
      Math.max(1e-6, this.modelBounds.size.z),
    ];
    const clamp = (v: number) => (v < 0 ? 0 : v >= res ? res - 1 : v);

    // Only the vertical (Y) column buckets over (X,Z) are needed for the
    // height-field inside test.
    for (let rayAxis = 1; rayAxis < 2; rayAxis++) {
      const aIdx = rayAxis === 0 ? 1 : 0;
      const bIdx = rayAxis === 2 ? 1 : 2;
      const minA = bmin[aIdx], minB = bmin[bIdx];
      const cellA = bsize[aIdx] / res, cellB = bsize[bIdx] / res;

      const triRange = (t: number) => {
        const o = t * 9;
        const a0 = pos[o + aIdx], a1 = pos[o + 3 + aIdx], a2 = pos[o + 6 + aIdx];
        const b0 = pos[o + bIdx], b1 = pos[o + 3 + bIdx], b2 = pos[o + 6 + bIdx];
        const ga0 = clamp(Math.floor((Math.min(a0, a1, a2) - minA) / cellA));
        const ga1 = clamp(Math.floor((Math.max(a0, a1, a2) - minA) / cellA));
        const gb0 = clamp(Math.floor((Math.min(b0, b1, b2) - minB) / cellB));
        const gb1 = clamp(Math.floor((Math.max(b0, b1, b2) - minB) / cellB));
        return { ga0, ga1, gb0, gb1 };
      };

      const counts = new Int32Array(res * res);
      for (let t = 0; t < triCount; t++) {
        const { ga0, ga1, gb0, gb1 } = triRange(t);
        for (let ga = ga0; ga <= ga1; ga++)
          for (let gb = gb0; gb <= gb1; gb++) counts[ga * res + gb]++;
      }

      const buckets: Int32Array[] = new Array(res * res);
      for (let b = 0; b < res * res; b++) buckets[b] = new Int32Array(counts[b]);
      const fillIdx = new Int32Array(res * res);
      for (let t = 0; t < triCount; t++) {
        const { ga0, ga1, gb0, gb1 } = triRange(t);
        for (let ga = ga0; ga <= ga1; ga++)
          for (let gb = gb0; gb <= gb1; gb++) {
            const b = ga * res + gb;
            buckets[b][fillIdx[b]++] = t;
          }
      }

      this.axisBuckets[rayAxis] = { minA, minB, cellA, cellB, aIdx, bIdx, res, buckets };
    }
  }

  // Vertical-span (height-field) inside test — robust for pillow-like slabs.
  // At the query (x,z) column we intersect the vertical line with every triangle
  // covering that cell, take the lowest and highest surface hits, and treat the
  // node as inside when its y lies within that span. Unlike ray parity this does
  // not require a watertight mesh, so the lattice conforms to the real top surface.
  private isPointInsideModel(px: number, py: number, pz: number): boolean {
    const pos = this.modelPositions;
    if (!pos) return true;
    const bk = this.axisBuckets[1]; // buckets over (X,Z) for the vertical (Y) column
    if (!bk) return true;

    const ga = Math.floor((px - bk.minA) / bk.cellA); // aIdx = 0 (x)
    const gb = Math.floor((pz - bk.minB) / bk.cellB); // bIdx = 2 (z)
    if (ga < 0 || ga >= bk.res || gb < 0 || gb >= bk.res) return false;
    const list = bk.buckets[ga * bk.res + gb];

    let minY = Infinity;
    let maxY = -Infinity;
    let hits = 0;
    const eps = 1e-6;

    for (let li = 0; li < list.length; li++) {
      const o = list[li] * 9;
      const ax = pos[o],     ay = pos[o + 1], az = pos[o + 2];
      const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
      const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];

      // Barycentric coords of (px,pz) within the triangle projected to the XZ plane.
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (d > -eps && d < eps) continue; // triangle is edge-on to the column
      const inv = 1 / d;
      const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) * inv;
      const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) * inv;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue; // outside triangle

      const y = l1 * ay + l2 * by + l3 * cy; // surface height at this column
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      hits++;
    }

    if (hits < 2) return false; // need both a lower and an upper surface
    const pad = 1e-4;
    return py >= minY - pad && py <= maxY + pad;
  }

  public resetPillow(type: 'standard' | 'contour' = 'contour') {
    this.particles = [];
    this.springs = [];
    this.timeElapsed = 0;
    this.forceHistory = [];
    this.totalReactionForce = 0;
    this.totalKineticEnergy = 0;

    const { gridX, gridY, gridZ } = this.parameters;

    // Fit the lattice to the imported model bounds when available, otherwise
    // fall back to the default nominal pillow dimensions.
    const fitToModel = this.modelBounds !== null;
    const width = fitToModel ? this.modelBounds!.size.x : 24.0;  // cm-scale
    const height = fitToModel ? this.modelBounds!.size.y : 6.0;
    const depth = fitToModel ? this.modelBounds!.size.z : 16.0;
    const originX = fitToModel ? this.modelBounds!.min.x : -width / 2;
    const originY = fitToModel ? this.modelBounds!.min.y : 0;
    const originZ = fitToModel ? this.modelBounds!.min.z : -depth / 2;

    // Record the regular-lattice layout for O(1) analytic skinning.
    this.latticeInfo = {
      originX, originY, originZ,
      dx: gridX > 1 ? width / (gridX - 1) : width,
      dy: gridY > 1 ? height / (gridY - 1) : height,
      dz: gridZ > 1 ? depth / (gridZ - 1) : depth,
      gridX, gridY, gridZ
    };

    // Build the triangle acceleration structure so the inside test scales.
    if (fitToModel) this.buildTriangleBuckets();
    else this.axisBuckets = [null, null, null];

    // 1. Generate Particles
    let id = 0;
    for (let x = 0; x < gridX; x++) {
      for (let y = 0; y < gridY; y++) {
        for (let z = 0; z < gridZ; z++) {
          const u = gridX > 1 ? x / (gridX - 1) : 0.5;
          const v = gridY > 1 ? y / (gridY - 1) : 0.5;
          const w = gridZ > 1 ? z / (gridZ - 1) : 0.5;

          let px: number;
          let py: number;
          let pz: number;

          if (fitToModel) {
            // Uniformly sample the imported model's real bounding volume.
            px = originX + u * width;
            py = originY + v * height;
            pz = originZ + w * depth;
          } else {
            px = (u - 0.5) * width;
            pz = (w - 0.5) * depth;

            // Generate realistic pillow shaping
            py = v * height;
            if (type === 'contour') {
              // Contour pillow: cervical support curve (high at front/back edge, lower neck groove)
              // A ridge near front (z = depth/2) and back (z = -depth/2)
              const edgeRidge = 1.0 + 0.35 * Math.sin(w * Math.PI) + 0.15 * Math.cos(2 * u * Math.PI - Math.PI);
              py *= edgeRidge;
            } else {
              // Standard domed pillow shape
              const dome = Math.sin(u * Math.PI) * Math.sin(w * Math.PI) * 0.4 + 0.6;
              py *= dome;
            }
          }

          const pos = new THREE.Vector3(px, py, pz);
          const restPos = pos.clone();

          // For irregular imported models, discard lattice nodes outside the mesh
          // volume so the structural grid conforms to the real pillow shape.
          const active = fitToModel ? this.isPointInsideModel(px, py, pz) : true;

          // Node mass scales with foam density (55D memory foam is the reference,
          // kept at the solver's validated node mass for stability).
          const mass = 0.015 * (this.parameters.density / 55);

          this.particles.push({
            id,
            position: pos,
            prevPosition: pos.clone(),
            restPosition: restPos,
            velocity: new THREE.Vector3(0, 0, 0),
            force: new THREE.Vector3(0, 0, 0),
            mass,
            invMass: active ? 1 / mass : 0,
            isFixed: !active,
            active,
            strain: 0
          });
          id++;
        }
      }
    }

    // Safety fallback: if the point-in-mesh test classified (almost) no nodes as
    // interior — e.g. the STL is not watertight or has flipped normals — fill the
    // whole bounding box so the model still simulates and stays visible.
    if (fitToModel) {
      let activeCount = 0;
      for (let i = 0; i < this.particles.length; i++) {
        if (this.particles[i].active) activeCount++;
      }
      const minNeeded = Math.max(8, Math.floor(this.particles.length * 0.02));
      if (activeCount < minNeeded) {
        for (let i = 0; i < this.particles.length; i++) {
          const p = this.particles[i];
          p.active = true;
          p.isFixed = false;
          p.invMass = 1 / p.mass;
        }
      }
    }

    // Helper to get index
    const getIndex = (x: number, y: number, z: number) => {
      if (x < 0 || x >= gridX || y < 0 || y >= gridY || z < 0 || z >= gridZ) return -1;
      return x * (gridY * gridZ) + y * gridZ + z;
    };

    // 2. Generate Springs (Structural, Shear, Bending)
    let springId = 0;
    const addSpring = (iA: number, iB: number, springType: 'structural' | 'shear' | 'bending') => {
      if (iA === -1 || iB === -1 || iA === iB) return;

      // Only connect nodes inside the (possibly irregular) model volume.
      if (!this.particles[iA].active || !this.particles[iB].active) return;
      
      // Prevent duplicates
      const exists = this.springs.some(s => (s.pA === iA && s.pB === iB) || (s.pA === iB && s.pB === iA));
      if (exists) return;

      const pA = this.particles[iA];
      const pB = this.particles[iB];
      const restLength = pA.restPosition.distanceTo(pB.restPosition);

      this.springs.push({
        id: springId++,
        pA: iA,
        pB: iB,
        restLength,
        type: springType,
        h1: 0,
        h2: 0,
        h3: 0,
        prevElasticForceMag: 0
      });
    };

    for (let x = 0; x < gridX; x++) {
      for (let y = 0; y < gridY; y++) {
        for (let z = 0; z < gridZ; z++) {
          const idx = getIndex(x, y, z);

          // Structural springs (immediate 6-neighbors)
          addSpring(idx, getIndex(x + 1, y, z), 'structural');
          addSpring(idx, getIndex(x, y + 1, z), 'structural');
          addSpring(idx, getIndex(x, y, z + 1), 'structural');

          // Shear/Diagonal springs (2D and 3D diagonals)
          addSpring(idx, getIndex(x + 1, y + 1, z), 'shear');
          addSpring(idx, getIndex(x + 1, y - 1, z), 'shear');
          addSpring(idx, getIndex(x + 1, y, z + 1), 'shear');
          addSpring(idx, getIndex(x + 1, y, z - 1), 'shear');
          addSpring(idx, getIndex(x, y + 1, z + 1), 'shear');
          addSpring(idx, getIndex(x, y + 1, z - 1), 'shear');
          
          addSpring(idx, getIndex(x + 1, y + 1, z + 1), 'shear');
          addSpring(idx, getIndex(x + 1, y + 1, z - 1), 'shear');
          addSpring(idx, getIndex(x + 1, y - 1, z + 1), 'shear');
          addSpring(idx, getIndex(x + 1, y - 1, z - 1), 'shear');

          // Bending springs (2-neighbors along axes to maintain bulk structure)
          addSpring(idx, getIndex(x + 2, y, z), 'bending');
          addSpring(idx, getIndex(x, y + 2, z), 'bending');
          addSpring(idx, getIndex(x, y, z + 2), 'bending');
        }
      }
    }

    // Establish anchoring on the (possibly irregular) active lattice.
    this.applyAnchors(this.anchorStyle);

    // Re-bind STL skinning if available
    if (this.rawStlVertices) {
      this.bindStlMesh(this.rawStlVertices);
    }
  }

  // Update anchoring styles dynamically
  public updateAnchors(style: 'bottom' | 'corners' | 'none') {
    this.applyAnchors(style);
  }

  // Fixes boundary nodes on the bed. For irregular imported models the lowest
  // active node in each (x,z) column is anchored (there may be no node at y===0),
  // otherwise the flat bottom layer is anchored.
  private applyAnchors(style: 'bottom' | 'corners' | 'none') {
    this.anchorStyle = style;
    const { gridX, gridY, gridZ } = this.parameters;
    const getIndex = (x: number, y: number, z: number) => x * (gridY * gridZ) + y * gridZ + z;

    // Reset: active nodes are free, inactive nodes stay frozen.
    this.particles.forEach(p => {
      p.isFixed = !p.active;
      p.invMass = p.active ? 1 / p.mass : 0;
    });

    if (style === 'none') return;

    const anchorColumn = (x: number, z: number) => {
      let bestIdx = -1;
      let bestY = Infinity;
      for (let y = 0; y < gridY; y++) {
        const idx = getIndex(x, y, z);
        const p = this.particles[idx];
        if (!p.active) continue;
        if (p.restPosition.y < bestY) {
          bestY = p.restPosition.y;
          bestIdx = idx;
        }
      }
      if (bestIdx !== -1) {
        this.particles[bestIdx].isFixed = true;
        this.particles[bestIdx].invMass = 0;
      }
    };

    if (style === 'bottom') {
      for (let x = 0; x < gridX; x++) {
        for (let z = 0; z < gridZ; z++) anchorColumn(x, z);
      }
    } else if (style === 'corners') {
      anchorColumn(0, 0);
      anchorColumn(gridX - 1, 0);
      anchorColumn(0, gridZ - 1);
      anchorColumn(gridX - 1, gridZ - 1);
    }
  }

  // Bind an imported high-resolution STL mesh to the physical low-resolution lattice.
  // The lattice is a regular grid, so the nearest active nodes for each vertex are
  // found analytically (O(1) per vertex) instead of scanning every particle.
  public bindStlMesh(positionAttribute: THREE.BufferAttribute) {
    this.rawStlVertices = positionAttribute;
    this.stlSkinningData = [];

    const vertexCount = positionAttribute.count;
    const posArray = positionAttribute.array as ArrayLike<number>;

    // Snapshot the original vertices ONCE so the model detail is preserved; the
    // lattice only supplies a displacement field on top of these rest positions.
    // (Re-binds after a reset must not capture an already-deformed buffer.)
    if (!this.stlRestPositions || this.stlRestPositions.length !== posArray.length) {
      this.stlRestPositions = Float32Array.from(posArray as ArrayLike<number>);
    }

    const li = this.latticeInfo;
    if (!li) return;

    const { originX, originY, originZ, dx, dy, dz, gridX, gridY, gridZ } = li;
    const idxOf = (x: number, y: number, z: number) => x * (gridY * gridZ) + y * gridZ + z;

    const K = 4;
    const bestIdx = new Int32Array(K);
    const bestDist = new Float64Array(K);

    for (let i = 0; i < vertexCount; i++) {
      const vx = posArray[i * 3];
      const vy = posArray[i * 3 + 1];
      const vz = posArray[i * 3 + 2];

      const fx = dx > 0 ? (vx - originX) / dx : 0;
      const fy = dy > 0 ? (vy - originY) / dy : 0;
      const fz = dz > 0 ? (vz - originZ) / dz : 0;

      const baseX = Math.floor(fx);
      const baseY = Math.floor(fy);
      const baseZ = Math.floor(fz);

      let filled = 0;
      let worstSlot = 0;
      let worstDist = -Infinity;

      // Expand the search neighborhood until at least K active nodes are found.
      for (let radius = 1; radius <= 4 && filled < K; radius++) {
        filled = 0;
        worstDist = -Infinity;

        const x0 = Math.max(0, baseX - radius + 1);
        const x1 = Math.min(gridX - 1, baseX + radius);
        const y0 = Math.max(0, baseY - radius + 1);
        const y1 = Math.min(gridY - 1, baseY + radius);
        const z0 = Math.max(0, baseZ - radius + 1);
        const z1 = Math.min(gridZ - 1, baseZ + radius);

        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            for (let z = z0; z <= z1; z++) {
              const idx = idxOf(x, y, z);
              const p = this.particles[idx];
              if (!p.active) continue;

              const ddx = vx - p.restPosition.x;
              const ddy = vy - p.restPosition.y;
              const ddz = vz - p.restPosition.z;
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;

              if (filled < K) {
                bestIdx[filled] = idx;
                bestDist[filled] = d2;
                filled++;
                if (filled === K) {
                  worstDist = -Infinity;
                  for (let j = 0; j < K; j++) {
                    if (bestDist[j] > worstDist) { worstDist = bestDist[j]; worstSlot = j; }
                  }
                }
              } else if (d2 < worstDist) {
                bestIdx[worstSlot] = idx;
                bestDist[worstSlot] = d2;
                worstDist = -Infinity;
                for (let j = 0; j < K; j++) {
                  if (bestDist[j] > worstDist) { worstDist = bestDist[j]; worstSlot = j; }
                }
              }
            }
          }
        }
      }

      const weights: number[] = new Array(filled);
      const indices: number[] = new Array(filled);
      let totalWeight = 0;
      for (let j = 0; j < filled; j++) {
        const w = 1.0 / (Math.sqrt(bestDist[j]) + 0.05); // EPSILON to prevent division by zero
        weights[j] = w;
        indices[j] = bestIdx[j];
        totalWeight += w;
      }
      if (totalWeight > 0) {
        for (let j = 0; j < filled; j++) weights[j] /= totalWeight;
      }

      this.stlSkinningData.push({ indices, weights });
    }
  }

  // Update custom mesh vertex positions by adding the lattice displacement field to
  // the original vertices. At rest the displacement is zero, so the imported model
  // keeps its full detail (it is never coarsened) — only real deformation moves it.
  public updateStlMeshDeformation(positionAttribute: THREE.BufferAttribute) {
    if (!this.rawStlVertices || this.stlSkinningData.length === 0 || !this.stlRestPositions) return;

    const vertexCount = positionAttribute.count;
    const rest = this.stlRestPositions;

    for (let i = 0; i < vertexCount; i++) {
      const skin = this.stlSkinningData[i];
      // No bound nodes: leave the vertex at its original position.
      if (!skin || skin.indices.length === 0) continue;

      let dispX = 0, dispY = 0, dispZ = 0;
      for (let j = 0; j < skin.indices.length; j++) {
        const p = this.particles[skin.indices[j]];
        const weight = skin.weights[j];
        dispX += weight * (p.position.x - p.restPosition.x);
        dispY += weight * (p.position.y - p.restPosition.y);
        dispZ += weight * (p.position.z - p.restPosition.z);
      }

      positionAttribute.setXYZ(i, rest[i * 3] + dispX, rest[i * 3 + 1] + dispY, rest[i * 3 + 2] + dispZ);
    }
    positionAttribute.needsUpdate = true;
  }

  // The complete physical timestep solver!
  public step(dt: number) {
    const subSteps = this.parameters.subSteps;
    const h = dt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      this.timeElapsed += h;
      this.singleSubStep(h);
    }
  }

  private singleSubStep(dt: number) {
    const N = this.particles.length;
    
    // 1. Update interactive or cyclic presser coordinates
    this.presser.update(this.timeElapsed, dt);

    // If presser is a free physical falling sphere (Drop Test)
    if (!this.presser.isControlled && !this.presser.autoCycleActive) {
      // Accelerate presser by gravity
      this.presser.velocity.y -= this.parameters.gravity * dt;
      this.presser.prevPosition.copy(this.presser.position);
      this.presser.position.addScaledVector(this.presser.velocity, dt);

      // Floor check for presser
      if (this.presser.position.y < this.presser.radius) {
        this.presser.position.y = this.presser.radius;
        this.presser.velocity.y = -this.presser.velocity.y * 0.2; // slight elastic bounce
      }
    }

    // 2. Precompute viscoelastic offset forces and total elastic forces for this step
    const elasticForces: number[] = new Array(this.springs.length);
    const viscoelasticForces: number[] = new Array(this.springs.length);

    // Calculate forces & update memory foam relaxation history
    this.springs.forEach((spring, idx) => {
      const pA = this.particles[spring.pA];
      const pB = this.particles[spring.pB];

      const len = pA.position.distanceTo(pB.position);
      const r = len / spring.restLength;

      // --- Hyperelastic Neo-Hookean Force Formulation ---
      // Force mag: f^e(l) = -1/l_0 * [ mu * (r - 1/r) + K * (r - 1) ]
      // Moduli are stored in real Pa; MOD_SCALE maps them into the solver's stable
      // working range while preserving the mu:K ratio (i.e. Poisson / incompressibility).
      const mu = this.parameters.shearModulus * MOD_SCALE;
      const K = this.parameters.bulkModulus * MOD_SCALE;
      
      const rClamped = Math.max(0.01, r);
      const f_elastic = -(1 / spring.restLength) * (mu * (rClamped - 1 / rClamped) + K * (rClamped - 1));

      elasticForces[idx] = f_elastic;

      // --- Prony Series Viscoelastic Memory Force (3 Maxwell terms) ---
      const g1 = this.parameters.g1;
      const g2 = this.parameters.g2;
      const g3 = this.parameters.g3;
      const g_inf = 1.0 - g1 - g2 - g3;

      // Update Prony memory history state
      const delta_fe = f_elastic - spring.prevElasticForceMag;

      const factor1 = Math.exp(-dt / this.parameters.tau1);
      const factor2 = Math.exp(-dt / this.parameters.tau2);
      const factor3 = Math.exp(-dt / this.parameters.tau3);

      spring.h1 = spring.h1 * factor1 + g1 * delta_fe;
      spring.h2 = spring.h2 * factor2 + g2 * delta_fe;
      spring.h3 = spring.h3 * factor3 + g3 * delta_fe;

      // Total viscoelastic scalar force
      const h_offset = spring.h1 * factor1 + spring.h2 * factor2 + spring.h3 * factor3
        - (1.0 - g_inf) * spring.prevElasticForceMag;
      viscoelasticForces[idx] = f_elastic + h_offset;

      // Save elastic force for next sub-step delta calculation
      spring.prevElasticForceMag = f_elastic;
    });

    // 3. Set up the RHS of the Implicit Conjugate Gradient solver
    // b = dt * ( F_viscoelastic + F_damping + F_contact + F_gravity )
    const b: THREE.Vector3[] = [];
    const f_visco_vec: THREE.Vector3[] = [];
    const f_damping_vec: THREE.Vector3[] = [];
    const f_contact_vec: THREE.Vector3[] = [];

    for (let i = 0; i < N; i++) {
      b.push(new THREE.Vector3(0, 0, 0));
      f_visco_vec.push(new THREE.Vector3(0, 0, 0));
      f_damping_vec.push(new THREE.Vector3(0, 0, 0));
      f_contact_vec.push(new THREE.Vector3(0, 0, 0));
    }

    // Accumulate viscoelastic forces
    this.springs.forEach((spring, idx) => {
      const pA = this.particles[spring.pA];
      const pB = this.particles[spring.pB];

      const dir = new THREE.Vector3().subVectors(pB.position, pA.position);
      const len = dir.length();
      if (len > 0.0001) {
        dir.multiplyScalar(1 / len);
      } else {
        dir.set(0, 1, 0);
      }

      const f_visco_mag = viscoelasticForces[idx];
      
      // Force vector on B
      const fb = dir.clone().multiplyScalar(f_visco_mag);
      f_visco_vec[spring.pB].add(fb);
      f_visco_vec[spring.pA].sub(fb);

      // --- Spring Local Damping ---
      // F_damping = -c * (relative_velocity dot dir) * dir
      const rel_vel = new THREE.Vector3().subVectors(pB.velocity, pA.velocity);
      const dot = rel_vel.dot(dir);
      const fd_mag = -this.parameters.damping * dot;
      const fd = dir.clone().multiplyScalar(fd_mag);

      f_damping_vec[spring.pB].add(fd);
      f_damping_vec[spring.pA].sub(fd);
    });

    // Accumulate external contact forces and boundary conditions
    this.totalReactionForce = 0;
    const tempNormal = new THREE.Vector3();
    const PEN_CAP = 3.0; // max penetration used for penalty force (stability guard)

    this.particles.forEach((p, i) => {
      if (p.isFixed) return;

      // --- Ground / Bed Contact (y >= 0) ---
      if (p.position.y < 0) {
        // Clamp penetration so a deeply-buried node can't generate an explosive force.
        const penetration = Math.min(-p.position.y, PEN_CAP);
        // Pushing upward
        f_contact_vec[i].y += this.parameters.groundStiffness * penetration;
        // Simple friction
        f_contact_vec[i].x -= p.velocity.x * this.parameters.friction;
        f_contact_vec[i].z -= p.velocity.z * this.parameters.friction;
      }

      // --- Rigid Head / Presser Contact ---
      const penetration = Math.min(this.presser.checkContact(p.position, tempNormal), PEN_CAP);
      if (penetration > 0) {
        // Penalty contact force
        const forceMag = this.parameters.contactStiffness * penetration;
        const fc = tempNormal.clone().multiplyScalar(forceMag);
        f_contact_vec[i].add(fc);

        // Track total reaction force acting back on the rigid head
        this.totalReactionForce += forceMag;

        // Friction against rigid head
        const rel_v = new THREE.Vector3().subVectors(p.velocity, this.presser.velocity);
        const tangential_v = rel_v.clone().addScaledVector(tempNormal, -rel_v.dot(tempNormal));
        f_contact_vec[i].addScaledVector(tangential_v, -this.parameters.friction * 0.5);
      }

      // --- Gravity & Air Resistance ---
      const f_ext = new THREE.Vector3(0, -this.parameters.gravity * p.mass, 0);
      f_ext.addScaledVector(p.velocity, -this.parameters.airResistance);

      // Total RHS b = dt * (f_visco + f_damping + f_contact + f_ext)
      b[i].copy(f_visco_vec[i])
          .add(f_damping_vec[i])
          .add(f_contact_vec[i])
          .add(f_ext)
          .multiplyScalar(dt);
    });

    // 4. Solve the linear system (M - dt*D - dt^2*K) * dy = b using Conjugate Gradient
    const dy: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) dy.push(new THREE.Vector3(0, 0, 0));

    this.solveImplicitCG(dy, b, dt);

    // 5. Update velocities and positions
    this.particles.forEach((p, i) => {
      if (p.isFixed) return;

      const d = dy[i];
      // Reject non-finite solver output so a single bad value can't poison the mesh.
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)) {
        p.velocity.set(0, 0, 0);
        return;
      }

      p.velocity.add(d);
      p.velocity.clampLength(0, 60); // guard against solver blow-ups

      // If a particle ever becomes non-finite, snap it back to rest (never break).
      if (!Number.isFinite(p.velocity.x) || !Number.isFinite(p.velocity.y) || !Number.isFinite(p.velocity.z)) {
        p.velocity.set(0, 0, 0);
        p.position.copy(p.restPosition);
        p.prevPosition.copy(p.restPosition);
        return;
      }

      p.prevPosition.copy(p.position);
      p.position.addScaledVector(p.velocity, dt);

      // Safety bounds to prevent extreme floating or falling
      if (p.position.y < -2.0) {
        p.position.y = -2.0;
        p.velocity.y = 0;
      }
    });

    // 5b. Strain limiting: keep the pillow intact. Deformation is allowed, but
    // springs may not over-stretch or over-collapse, so the mesh never tears or
    // explodes ("破损") under hard impacts / strong compression.
    this.applyStrainLimiting();

    // 5c. Recompute visual strain and kinetic energy on the corrected positions.
    this.totalKineticEnergy = 0;
    this.particles.forEach((p) => {
      if (p.isFixed) return;
      const d = p.position.distanceTo(p.restPosition);
      p.strain = Math.min(1.0, d / 1.2); // more sensitive: small deformations already colour
      this.totalKineticEnergy += 0.5 * p.mass * p.velocity.lengthSq();
    });

    // 6. If presser is a free physical dropping ball, integrate its physical reaction forces!
    if (!this.presser.isControlled && !this.presser.autoCycleActive) {
      // Add reaction force from pillow contact (directed upward)
      // We know totalReactionForce represents the scalar force pushing upward
      this.presser.velocity.y += (this.totalReactionForce / this.presser.mass) * dt;

      // Contact damping: memory foam dissipates impact energy, so while the head is
      // in contact with the pillow we damp its velocity. Without this the elastic
      // penalty contact acts as an undamped spring and the head bounces forever.
      if (this.totalReactionForce > 1e-4) {
        const contactDamping = 14.0; // per-second viscous damping during contact
        const factor = Math.max(0, 1 - contactDamping * dt);
        this.presser.velocity.y *= factor;
      }

      // Limit speed
      this.presser.velocity.clampLength(0, 150);
    }

    // Sanitize the presser and telemetry so a bad value can never reach the UI /
    // charts (a NaN in React props crashes rendering and freezes all controls).
    if (!Number.isFinite(this.presser.position.x)) this.presser.position.x = 0;
    if (!Number.isFinite(this.presser.position.y)) { this.presser.position.y = 10; this.presser.velocity.set(0, 0, 0); }
    if (!Number.isFinite(this.presser.position.z)) this.presser.position.z = 0;
    if (!Number.isFinite(this.presser.velocity.x) || !Number.isFinite(this.presser.velocity.y) || !Number.isFinite(this.presser.velocity.z)) {
      this.presser.velocity.set(0, 0, 0);
    }
    if (!Number.isFinite(this.totalReactionForce)) this.totalReactionForce = 0;
    if (!Number.isFinite(this.totalKineticEnergy)) this.totalKineticEnergy = 0;

    // 7. Store time history for hysteresis plotting (downsample for performance)
    if (Math.random() < 0.25 || this.presser.autoCycleActive) {
      const displacement = Math.max(0, 15.0 - this.presser.position.y); // displacement of the head
      this.forceHistory.push({
        time: Number(this.timeElapsed.toFixed(2)),
        displacement: Number(displacement.toFixed(2)),
        force: Number(this.totalReactionForce.toFixed(1)),
        energy: Number(this.totalKineticEnergy.toFixed(3))
      });
      // Keep only last 200 items to avoid lagging charts
      if (this.forceHistory.length > 200) {
        this.forceHistory.shift();
      }
    }
  }

  // Position-based strain limiting (Provot). Projects over-stretched / over-collapsed
  // structural & shear springs back within bounds so the pillow deforms but never
  // tears apart or inverts. Fixed nodes act as immovable anchors.
  private applyStrainLimiting() {
    const maxRatio = 1.8;  // max stretch before clamping (tearing guard)
    const minRatio = 0.25; // max compression before clamping (collapse guard)
    const iterations = 3;

    for (let iter = 0; iter < iterations; iter++) {
      for (let s = 0; s < this.springs.length; s++) {
        const spring = this.springs[s];
        if (spring.type === 'bending') continue; // limit only structural + shear

        const pA = this.particles[spring.pA];
        const pB = this.particles[spring.pB];
        const wA = pA.invMass;
        const wB = pB.invMass;
        const wSum = wA + wB;
        if (wSum === 0) continue;

        const dx = pB.position.x - pA.position.x;
        const dy = pB.position.y - pA.position.y;
        const dz = pB.position.z - pA.position.z;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) continue;

        const maxLen = spring.restLength * maxRatio;
        const minLen = spring.restLength * minRatio;
        let target = len;
        if (len > maxLen) target = maxLen;
        else if (len < minLen) target = minLen;
        else continue;

        const diff = (len - target) / len; // signed correction fraction
        const cx = dx * diff, cy = dy * diff, cz = dz * diff;

        // Distribute correction by inverse mass; fixed nodes (w=0) stay put.
        pA.position.x += cx * (wA / wSum);
        pA.position.y += cy * (wA / wSum);
        pA.position.z += cz * (wA / wSum);
        pB.position.x -= cx * (wB / wSum);
        pB.position.y -= cy * (wB / wSum);
        pB.position.z -= cz * (wB / wSum);
      }
    }
  }

  // Matrix-free Conjugate Gradient solver
  // Solves (M - dt*D - dt^2*K) * x = b
  private solveImplicitCG(x: THREE.Vector3[], b: THREE.Vector3[], dt: number) {
    const N = this.particles.length;
    const r: THREE.Vector3[] = [];
    const p: THREE.Vector3[] = [];
    const Ap: THREE.Vector3[] = [];

    for (let i = 0; i < N; i++) {
      r.push(new THREE.Vector3().copy(b[i]));
      p.push(new THREE.Vector3().copy(b[i]));
      Ap.push(new THREE.Vector3(0, 0, 0));
    }

    // Calculate initial residual dot product
    let r_dot_r = 0;
    for (let i = 0; i < N; i++) {
      if (this.particles[i].isFixed) continue;
      r_dot_r += r[i].dot(r[i]);
    }

    const threshold = 1e-6;
    if (r_dot_r < threshold) {
      this.cgIterations = 0;
      return;
    }

    const maxIters = 25;
    let iter = 0;

    for (iter = 0; iter < maxIters; iter++) {
      // Compute Matrix-Vector product Ap = A * p
      this.multiplyA(Ap, p, dt);

      // Compute step length alpha = r_dot_r / (p dot Ap)
      let p_dot_Ap = 0;
      for (let i = 0; i < N; i++) {
        if (this.particles[i].isFixed) continue;
        p_dot_Ap += p[i].dot(Ap[i]);
      }

      if (Math.abs(p_dot_Ap) < 1e-10) break;
      const alpha = r_dot_r / p_dot_Ap;

      // Update solution x and residual r
      let next_r_dot_r = 0;
      for (let i = 0; i < N; i++) {
        if (this.particles[i].isFixed) continue;
        x[i].addScaledVector(p[i], alpha);
        r[i].addScaledVector(Ap[i], -alpha);
        next_r_dot_r += r[i].dot(r[i]);
      }

      // Check convergence
      if (next_r_dot_r < threshold) {
        break;
      }

      // Compute beta = next_r_dot_r / r_dot_r
      const beta = next_r_dot_r / r_dot_r;

      // Update search direction p
      for (let i = 0; i < N; i++) {
        if (this.particles[i].isFixed) continue;
        p[i].multiplyScalar(beta).add(r[i]);
      }

      r_dot_r = next_r_dot_r;
    }

    this.cgIterations = iter;
  }

  // Calculates Ap = (M - dt*D - dt^2*K) * p
  private multiplyA(Ap: THREE.Vector3[], p: THREE.Vector3[], dt: number) {
    const N = this.particles.length;

    // 1. Ap = M * p
    for (let i = 0; i < N; i++) {
      const particle = this.particles[i];
      if (particle.isFixed) {
        Ap[i].set(0, 0, 0);
      } else {
        Ap[i].copy(p[i]).multiplyScalar(particle.mass);
      }
    }

    // 2. Ap += -dt * D * p - dt^2 * K * p
    const mu = this.parameters.shearModulus * MOD_SCALE;
    const K = this.parameters.bulkModulus * MOD_SCALE;
    const c = this.parameters.damping;

    const dt2 = dt * dt;

    this.springs.forEach((spring) => {
      const pA = this.particles[spring.pA];
      const pB = this.particles[spring.pB];

      const dir = new THREE.Vector3().subVectors(pB.position, pA.position);
      const len = dir.length();
      if (len < 0.0001) return;
      
      const u = dir.clone().multiplyScalar(1 / len);
      const restLen = spring.restLength;
      const r = len / restLen;

      // Compute non-linear Neo-Hookean stiffness analytical derivative:
      // k(l) = 1/(l_0^2) * [ mu * (1 + (l_0/l)^2) + K ]
      const rClamped = Math.max(0.01, r);
      const k_stiffness = (1 / (restLen * restLen)) * (mu * (1 + 1 / (rClamped * rClamped)) + K);

      // f_total = f_elastic + f_history
      // We estimate the current total force magnitude to account for direction updates (geometric stiffness)
      // Note: we can use the spring's prev elastic force as an approximation
      const f_total = spring.prevElasticForceMag;

      // Relative input search direction vector
      const dp = new THREE.Vector3().subVectors(p[spring.pB], p[spring.pA]);

      // --- Spring Local Stiffness Matrix Multiplication (K * dp) ---
      // K_elem = -k_stiffness * u*u^T + (f_total / len) * (I - u*u^T)
      const u_dot_dp = u.dot(dp);
      const term_stiff = u.clone().multiplyScalar(-k_stiffness * u_dot_dp);
      const term_geo = dp.clone().addScaledVector(u, -u_dot_dp).multiplyScalar(f_total / len);
      
      const K_dp = new THREE.Vector3().addVectors(term_stiff, term_geo);

      // --- Spring Local Damping Matrix Multiplication (D * dp) ---
      // D_elem = -c * u*u^T
      const D_dp = u.clone().multiplyScalar(-c * u_dot_dp);

      // Combined coefficient: -dt * D_elem - dt^2 * K_elem
      // Which means for particle B: add (-dt * -D_dp - dt^2 * K_dp) = (dt * D_dp - dt^2 * K_dp)
      // Actually, since A = M - dt*D - dt^2*K:
      // A_contribution = -dt * (-D_elem * dp) - dt^2 * (-K_elem * dp) = dt * D_dp + dt^2 * K_dp... Wait, let's watch signs!
      // If we write out standard forces:
      // f_spring = f(l)*u + damping_force
      // K is derivative of spring force w.r.t position. Since spring force pulls back:
      // K_dp is the change in spring force. It is opposing movement, so multiplying with -dt^2 * K_dp adds damping/stiffness.
      // Let's formulate directly:
      // Contribution to Ap[B] += ( - dt * (- c * (dp.u) * u) - dt^2 * ( - K_dp ) )
      // Let's simplify:
      // Force change on B is dF = D_dp + K_dp (where both are opposing dp)
      // So Ap[B] -= dt * D_dp + dt^2 * K_dp
      // Ap[A] += dt * D_dp + dt^2 * K_dp
      const contrib = new THREE.Vector3()
        .addScaledVector(D_dp, -dt)
        .addScaledVector(K_dp, -dt2);

      if (!pB.isFixed) Ap[spring.pB].add(contrib);
      if (!pA.isFixed) Ap[spring.pA].sub(contrib);
    });
  }

  // Export visual deformed pillow mesh (or the core grid mapped to STL format)
  // Standard ASCII STL format export
  public exportToStlString(type: 'lattice' | 'imported'): string {
    let out = 'solid deformed_pillow\n';

    if (type === 'imported' && this.rawStlVertices) {
      // Export custom imported STL mesh with current deformations!
      const count = this.rawStlVertices.count;
      for (let i = 0; i < count; i += 3) {
        const v1 = new THREE.Vector3().fromBufferAttribute(this.rawStlVertices, i);
        const v2 = new THREE.Vector3().fromBufferAttribute(this.rawStlVertices, i + 1);
        const v3 = new THREE.Vector3().fromBufferAttribute(this.rawStlVertices, i + 2);

        // Calculate normal
        const edge1 = new THREE.Vector3().subVectors(v2, v1);
        const edge2 = new THREE.Vector3().subVectors(v3, v1);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

        out += `  facet normal ${normal.x} ${normal.y} ${normal.z}\n`;
        out += '    outer loop\n';
        out += `      vertex ${v1.x} ${v1.y} ${v1.z}\n`;
        out += `      vertex ${v2.x} ${v2.y} ${v2.z}\n`;
        out += `      vertex ${v3.x} ${v3.y} ${v3.z}\n`;
        out += '    endloop\n';
        out += '  endfacet\n';
      }
    } else {
      // Export lattice grid as a voxel-mesh surface
      const { gridX, gridY, gridZ } = this.parameters;
      const getIndex = (x: number, y: number, z: number) => {
        return x * (gridY * gridZ) + y * gridZ + z;
      };

      // Add quad faces for all 6 exterior faces of the grid cells
      const addQuad = (i1: number, i2: number, i3: number, i4: number) => {
        const p1 = this.particles[i1].position;
        const p2 = this.particles[i2].position;
        const p3 = this.particles[i3].position;
        const p4 = this.particles[i4].position;

        // Triangle 1: p1 -> p2 -> p3
        let e1 = new THREE.Vector3().subVectors(p2, p1);
        let e2 = new THREE.Vector3().subVectors(p3, p1);
        let n1 = new THREE.Vector3().crossVectors(e1, e2).normalize();

        out += `  facet normal ${n1.x} ${n1.y} ${n1.z}\n`;
        out += '    outer loop\n';
        out += `      vertex ${p1.x} ${p1.y} ${p1.z}\n`;
        out += `      vertex ${p2.x} ${p2.y} ${p2.z}\n`;
        out += `      vertex ${p3.x} ${p3.y} ${p3.z}\n`;
        out += '    endloop\n';
        out += '  endfacet\n';

        // Triangle 2: p1 -> p3 -> p4
        e1 = new THREE.Vector3().subVectors(p3, p1);
        e2 = new THREE.Vector3().subVectors(p4, p1);
        n1 = new THREE.Vector3().crossVectors(e1, e2).normalize();

        out += `  facet normal ${n1.x} ${n1.y} ${n1.z}\n`;
        out += '    outer loop\n';
        out += `      vertex ${p1.x} ${p1.y} ${p1.z}\n`;
        out += `      vertex ${p3.x} ${p3.y} ${p3.z}\n`;
        out += `      vertex ${p4.x} ${p4.y} ${p4.z}\n`;
        out += '    endloop\n';
        out += '  endfacet\n';
      };

      // Exterior faces extraction
      // Bottom face (y = 0)
      for (let x = 0; x < gridX - 1; x++) {
        for (let z = 0; z < gridZ - 1; z++) {
          addQuad(
            getIndex(x, 0, z),
            getIndex(x, 0, z + 1),
            getIndex(x + 1, 0, z + 1),
            getIndex(x + 1, 0, z)
          );
        }
      }
      // Top face (y = gridY - 1)
      for (let x = 0; x < gridX - 1; x++) {
        for (let z = 0; z < gridZ - 1; z++) {
          addQuad(
            getIndex(x, gridY - 1, z),
            getIndex(x + 1, gridY - 1, z),
            getIndex(x + 1, gridY - 1, z + 1),
            getIndex(x, gridY - 1, z + 1)
          );
        }
      }
      // Front face (z = gridZ - 1)
      for (let x = 0; x < gridX - 1; x++) {
        for (let y = 0; y < gridY - 1; y++) {
          addQuad(
            getIndex(x, y, gridZ - 1),
            getIndex(x + 1, y, gridZ - 1),
            getIndex(x + 1, y + 1, gridZ - 1),
            getIndex(x, y + 1, gridZ - 1)
          );
        }
      }
      // Back face (z = 0)
      for (let x = 0; x < gridX - 1; x++) {
        for (let y = 0; y < gridY - 1; y++) {
          addQuad(
            getIndex(x, y, 0),
            getIndex(x, y + 1, 0),
            getIndex(x + 1, y + 1, 0),
            getIndex(x + 1, y, 0)
          );
        }
      }
      // Left face (x = 0)
      for (let y = 0; y < gridY - 1; y++) {
        for (let z = 0; z < gridZ - 1; z++) {
          addQuad(
            getIndex(0, y, z),
            getIndex(0, y + 1, z),
            getIndex(0, y + 1, z + 1),
            getIndex(0, y, z + 1)
          );
        }
      }
      // Right face (x = gridX - 1)
      for (let y = 0; y < gridY - 1; y++) {
        for (let z = 0; z < gridZ - 1; z++) {
          addQuad(
            getIndex(gridX - 1, y, z),
            getIndex(gridX - 1, y, z + 1),
            getIndex(gridX - 1, y + 1, z + 1),
            getIndex(gridX - 1, y + 1, z)
          );
        }
      }
    }

    out += 'endsolid deformed_pillow\n';
    return out;
  }
}
