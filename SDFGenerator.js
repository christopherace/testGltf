// SDFGenerator.js
import * as THREE from "https://esm.sh/three@0.128";

export class SDFGenerator {
  constructor({ maxDistance = 1.0 } = {}) {
    this.maxDistance = maxDistance;
    this._cancel = false;
  }

  // Cancel an ongoing run (best-effort)
  cancel() { this._cancel = true; }

  // generate(scene, { n = 64, padding = 0.02, onProgress: fn(progressFloat) })
  // returns Promise<{ texture: DataTexture3D, bbox, n, voxelSize }>
  async generate(scene, { n = 64, padding = 0.02, onProgress = null } = {}) {
    if (!scene) throw new Error("SDFGenerator.generate: scene required");
    this._cancel = false;

    // collect triangles in world-space
    const tris = [];
    scene.traverse((m) => {
      if (!m.isMesh || !m.geometry) return;
      const geom = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      const pos = geom.attributes.position;
      const mat = m.matrixWorld;
      for (let i = 0; i < pos.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat);
        const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(mat);
        const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2).applyMatrix4(mat);
        tris.push({ a, b, c });
      }
    });

    // bounding box
    const bbox = new THREE.Box3().setFromObject(scene);
    bbox.expandByScalar(padding);
    const size = new THREE.Vector3(); bbox.getSize(size);
    const worldSpan = Math.max(size.x, size.y, size.z);
    const voxelSize = worldSpan / n;

    // helpers: point to triangle squared distance (robust)
    const tmpAB = new THREE.Vector3(), tmpAC = new THREE.Vector3(), tmpAP = new THREE.Vector3();
    const tmpBP = new THREE.Vector3(), tmpCP = new THREE.Vector3(), tmpVec = new THREE.Vector3();

    function pointToTriDistanceSquared(p, tri) {
      const a = tri.a, b = tri.b, c = tri.c;
      tmpAB.subVectors(b, a);
      tmpAC.subVectors(c, a);
      tmpAP.subVectors(p, a);

      const d1 = tmpAB.dot(tmpAP), d2 = tmpAC.dot(tmpAP);
      if (d1 <= 0 && d2 <= 0) return p.distanceToSquared(a);

      tmpBP.subVectors(p, b);
      const d3 = tmpAB.dot(tmpBP), d4 = tmpAC.dot(tmpBP);
      if (d3 >= 0 && d4 <= d3) return p.distanceToSquared(b);

      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return p.distanceToSquared(tmpVec.copy(tmpAB).multiplyScalar(v).add(a));
      }

      tmpCP.subVectors(p, c);
      const d5 = tmpAB.dot(tmpCP), d6 = tmpAC.dot(tmpCP);
      if (d6 >= 0 && d5 <= d6) return p.distanceToSquared(c);

      const vb = d5 * d2 - d1 * d6;
      if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return p.distanceToSquared(tmpVec.copy(tmpAC).multiplyScalar(w).add(a));
      }

      const va = d3 * d6 - d5 * d4;
      if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return p.distanceToSquared(tmpVec.subVectors(c, b).multiplyScalar(w).add(b));
      }

      const denom = 1.0 / (va + vb + vc);
      const v = vb * denom;
      const w = vc * denom;
      return p.distanceToSquared(tmpVec.copy(tmpAB).multiplyScalar(v).addScaledVector(tmpAC, w).add(a));
    }

    // point-in-mesh (ray parity) using THREE.Raycaster; uses a fixed direction to avoid degeneracies
    const bvhDummy = null; // keep parity test using raycast on scene
    const rayDir = new THREE.Vector3(1, 0.123, 0.456).normalize();

    function pointIsInside(p) {
      const ray = new THREE.Raycaster(p, rayDir);
      const hits = ray.intersectObject(scene, true);
      return (hits.length % 2) === 1;
    }

    const total = n * n * n;
    const data = new Float32Array(total);
    const p = new THREE.Vector3();
    let ptr = 0;
    let counted = 0;
    const maxD = this.maxDistance;

    for (let z = 0; z < n; z++) {
      if (this._cancel) throw new Error("SDF generation cancelled");
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          // normalized coords [0..1]
          const tx = x / (n - 1), ty = y / (n - 1), tz = z / (n - 1);
          p.set(
            THREE.MathUtils.lerp(bbox.min.x, bbox.max.x, tx),
            THREE.MathUtils.lerp(bbox.min.y, bbox.max.y, ty),
            THREE.MathUtils.lerp(bbox.min.z, bbox.max.z, tz)
          );

          // find nearest triangle distance (brute force)
          let minD2 = Infinity;
          for (let i = 0; i < tris.length; i++) {
            const d2 = pointToTriDistanceSquared(p, tris[i]);
            if (d2 < minD2) minD2 = d2;
          }
          let d = Math.sqrt(minD2);

          // sign using parity
          const inside = pointIsInside(p);
          if (inside) d = -d;

          // clamp
          if (d > maxD) d = maxD;
          if (d < -maxD) d = -maxD;

          data[ptr++] = d;
          counted++;
        }
      }
      // progress advices
      if (onProgress && (z % Math.max(1, Math.floor(n / 20)) === 0)) {
        try { onProgress(counted / total); } catch (e) {}
        // allow UI to breathe
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // create DataTexture3D (signed floats)
    const tex = new THREE.DataTexture3D(data, n, n, n);
    tex.format = THREE.RedFormat;
    tex.type = THREE.FloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;

    return { texture: tex, bbox, n, voxelSize, maxDistance: this.maxDistance };
  }

  dispose() {
    this._cancel = true;
  }
}
