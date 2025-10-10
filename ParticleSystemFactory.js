// ParticleSystemFactory.js (patched)
// - Adds defensive shader lookups with warnings
// - Adds console progress logs prefixed with [PSF]
// - Ensures renderer.setRenderTarget(null) after offscreen passes (initial renderTexture and compute)
// - Keeps original API and behavior otherwise

import * as THREE from "https://esm.sh/three@0.128";
import { GPUComputationRenderer } from "https://esm.sh/three@0.128/examples/jsm/misc/GPUComputationRenderer.js";
import { BufferGeometryUtils } from "https://esm.sh/three@0.128/examples/jsm/utils/BufferGeometryUtils.js";

function _shaderText(id) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[PSF] missing shader element: ${id}`);
    return ""; // return empty string so ShaderMaterial creation fails loudly later if needed
  }
  return el.textContent;
}

export class ParticleSystemFactory {
  constructor(renderer, { defaultWidth = 600, defaultDensity = 256 } = {}) {
    if (!renderer) throw new Error("ParticleSystemFactory requires a THREE.WebGLRenderer instance");
    this.renderer = renderer;
    this.defaultWidth = defaultWidth;
    this.defaultDensity = defaultDensity;
    this._instances = new Set();
  }

  // Public API unchanged: createFromPlane
  async createFromPlane(planeMesh, { particlesWidth = this.defaultWidth, densitySize = this.defaultDensity, sdfData = null, spawnScale = 0.5 } = {}) {
    if (!planeMesh || !planeMesh.geometry) throw new Error("createFromPlane: planeMesh with geometry required");
    const inst = await this._buildSystem(planeMesh, { particlesWidth, densitySize, sdfData, spawnScale });
    this._instances.add(inst);
    return inst;
  }

  // Interactive picker: returns Promise<THREE.Mesh>
  pickPlaneFromScene({ camera, scene, pickableMeshes = null, maxPicks = 3, markerMaterial = null } = {}) {
    if (!this.renderer) throw new Error("ParticleSystemFactory.pickPlaneFromScene needs a valid renderer (this.renderer).");
    if (!camera || !scene) throw new Error("pickPlaneFromScene requires camera and scene.");

    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const picks = [];
    const markers = [];
    const pickMeshes = pickableMeshes || [];
    const dom = this.renderer.domElement;
    const markerMat = markerMaterial || new THREE.MeshBasicMaterial({ color: 0x00ff00 });

    return new Promise((resolve) => {
      function onClick(e) {
        const rect = dom.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        ray.setFromCamera(mouse, camera);
        const intersects = ray.intersectObjects(pickMeshes, true);
        if (!intersects.length) return;
        const hit = intersects[0];
        const geom = hit.object.geometry;
        if (!geom || !geom.attributes || !geom.attributes.position) return;

        // find nearest vertex in world-space to hit.point
        const posAttr = geom.attributes.position;
        const tmp = new THREE.Vector3();
        let nearest = new THREE.Vector3();
        let minD2 = Infinity;
        for (let i = 0; i < posAttr.count; i++) {
          tmp.fromBufferAttribute(posAttr, i).applyMatrix4(hit.object.matrixWorld);
          const d2 = tmp.distanceToSquared(hit.point);
          if (d2 < minD2) {
            minD2 = d2;
            nearest.copy(tmp);
          }
        }

        // record pick and show marker
        picks.push(nearest.clone());
        const marker = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.01, hit.distance * 0.002), 8, 8), markerMat.clone());
        marker.position.copy(nearest);
        marker.material.depthTest = false;
        marker.material.depthWrite = false;
        scene.add(marker);
        markers.push(marker);

        if (picks.length >= maxPicks) {
          // Build rectangle from 3 points: a, b, c
          const a = picks[0], b = picks[1], c = picks[2];
          const ab = new THREE.Vector3().subVectors(b, a);
          const ac = new THREE.Vector3().subVectors(c, a);
          const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();
          const u = ab.clone();
          const v = new THREE.Vector3().crossVectors(normal, u).normalize().multiplyScalar(ac.length());

          const aCorner = a.clone();
          const bCorner = a.clone().add(u);
          const cCorner = a.clone().add(v);
          const dCorner = a.clone().add(u).add(v);

          const verts = new Float32Array([
            aCorner.x, aCorner.y, aCorner.z,
            bCorner.x, bCorner.y, bCorner.z,
            dCorner.x, dCorner.y, dCorner.z,
            aCorner.x, aCorner.y, aCorner.z,
            dCorner.x, dCorner.y, dCorner.z,
            cCorner.x, cCorner.y, cCorner.z
          ]);

          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
          geom.computeVertexNormals();

          const planeMat = new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
          const planeMesh = new THREE.Mesh(geom, planeMat);
          planeMesh.name = "picked_plane_mesh";
          planeMesh.updateMatrixWorld(true);

          // cleanup markers and listeners
          window.removeEventListener('click', onClick);
          markers.forEach(m => { try { scene.remove(m); m.geometry?.dispose(); m.material?.dispose(); } catch(e){} });

          resolve(planeMesh);
        }
      }

      window.addEventListener('click', onClick);
    });
  }

  // Convenience: pick + create
  async createFromPickedPlane({ camera, scene, pickableMeshes = null, particlesWidth = this.defaultWidth, densitySize = this.defaultDensity, sdfData = null, spawnScale = 0.5 } = {}) {
    const plane = await this.pickPlaneFromScene({ camera, scene, pickableMeshes });
    scene.add(plane);
    plane.updateMatrixWorld(true);
    const system = await this.createFromPlane(plane, { particlesWidth, densitySize, sdfData, spawnScale });
    this._instances.add(system);
    return system;
  }

  // --- internal builder ---
  async _buildSystem(plane, { particlesWidth, densitySize, sdfData, spawnScale }) {
    console.log('[PSF] _buildSystem start', { particlesWidth, densitySize, hasSDF: !!sdfData });

    const WIDTH = particlesWidth;
    const PARTICLES = WIDTH * WIDTH;
    const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, this.renderer);

    const posTexture = gpuCompute.createTexture();
    const velTexture = gpuCompute.createTexture();
    const posArray = posTexture.image.data;
    const velArray = velTexture.image.data;

    // compute plane basis & extents
    plane.geometry.computeBoundingBox();
    plane.updateMatrixWorld(true);
    const posAttr = plane.geometry.attributes.position;
    let vA = new THREE.Vector3().fromBufferAttribute(posAttr, 0).applyMatrix4(plane.matrixWorld);
    let vB = new THREE.Vector3().fromBufferAttribute(posAttr, 1).applyMatrix4(plane.matrixWorld);
    let vC = null;
    for (let i = 2; i < posAttr.count; i++) {
      const tmp = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(plane.matrixWorld);
      if (tmp.distanceTo(vA) > 1e-6 && tmp.distanceTo(vB) > 1e-6) { vC = tmp; break; }
    }
    if (!vC) {
      const box = plane.geometry.boundingBox;
      vC = new THREE.Vector3(box.max.x, box.max.y, box.max.z).applyMatrix4(plane.matrixWorld);
    }

    const planeOffset = new THREE.Vector3();
    plane.geometry.boundingBox.getCenter(planeOffset);
    planeOffset.applyMatrix4(plane.matrixWorld);

    const edgeAB = new THREE.Vector3().subVectors(vB, vA);
    const edgeAC = new THREE.Vector3().subVectors(vC, vA);

    const basisX = edgeAB.clone().normalize();
    const basisY = new THREE.Vector3().crossVectors(edgeAB, edgeAC).normalize();
    const basisZ = new THREE.Vector3().crossVectors(basisY, basisX).normalize();

    // extents along in-plane axes (world)
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const tmpv = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      tmpv.fromBufferAttribute(posAttr, i).applyMatrix4(plane.matrixWorld);
      const px = tmpv.dot(basisX);
      const pz = tmpv.dot(basisZ);
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    const width = Math.max(0.0001, maxX - minX);
    const height = Math.max(0.0001, maxZ - minZ);

    // seed positions
    {
      const halfW = width * 0.5 * spawnScale;
      const halfH = height * 0.5 * spawnScale;
      const baseLift = Math.max(0.01, 0.02 * spawnScale);
      const tmpPos = new THREE.Vector3();
      for (let i = 0; i < posArray.length; i += 4) {
        const rx = (Math.random() * 2.0 - 1.0) * halfW;
        const rz = (Math.random() * 2.0 - 1.0) * halfH;
        tmpPos.copy(planeOffset);
        tmpPos.addScaledVector(basisX, rx);
        tmpPos.addScaledVector(basisZ, rz);
        tmpPos.addScaledVector(basisY, baseLift + (Math.random() - 0.5) * 0.012);
        posArray[i + 0] = tmpPos.x;
        posArray[i + 1] = tmpPos.y;
        posArray[i + 2] = tmpPos.z;
        posArray[i + 3] = 0.6 + Math.random() * 0.2;
      }
    }

    // seed velocities
    {
      const tmpVel = new THREE.Vector3();
      for (let i = 0; i < velArray.length; i += 4) {
        const sx = (Math.random() - 0.5) * 0.02;
        const sy = 0.01 + Math.random() * 0.02;
        const sz = (Math.random() - 0.5) * 0.02;
        tmpVel.set(0,0,0);
        tmpVel.addScaledVector(basisX, sx);
        tmpVel.addScaledVector(basisY, sy);
        tmpVel.addScaledVector(basisZ, sz);
        velArray[i + 0] = tmpVel.x;
        velArray[i + 1] = tmpVel.y;
        velArray[i + 2] = tmpVel.z;
        velArray[i + 3] = 0.02 + Math.random() * 0.12;
      }
      const maxStartSpeed = 0.1;
      for (let i = 0; i < velArray.length; i += 4) {
        const vx = velArray[i + 0], vy = velArray[i + 1], vz = velArray[i + 2];
        const s = Math.sqrt(vx*vx + vy*vy + vz*vz);
        if (s > maxStartSpeed) {
          const scale = maxStartSpeed / s;
          velArray[i + 0] *= scale; velArray[i + 1] *= scale; velArray[i + 2] *= scale;
        }
      }
    }

    // add variables to GPUComputationRenderer (guarded shader lookups)
    const texturePositionShader = _shaderText("texturePositionShader");
    const textureVelocityShader = _shaderText("textureVelocityShader");

    const positionVariable = gpuCompute.addVariable("texturePosition", texturePositionShader, posTexture);
    const velocityVariable = gpuCompute.addVariable("textureVelocity", textureVelocityShader, velTexture);

    gpuCompute.setVariableDependencies(positionVariable, [positionVariable, velocityVariable]);
    gpuCompute.setVariableDependencies(velocityVariable, [positionVariable, velocityVariable]);

    const uTime = { value: 0.0 };
    const uDeltaTime = { value: 0.0 };
    const uResolution = { value: new THREE.Vector2(WIDTH, WIDTH) };
    const uPlaneSize = { value: new THREE.Vector2(width, height) };
    const uSpawnScale = { value: spawnScale };
    const uRiseSpeed = { value: 0.30 };
    const uSpreadStrength = { value: 1.4 };
    const uNoiseScale = { value: 0.10 };
    const uCollisionStrength = { value: 1.20 };
    const uGravityScale = { value: 0.0 };
    const uDrag = { value: 0.0 };
    const uFlipDamp = { value: 0.0 };

    const uSDFTex = { value: sdfData ? sdfData.texture : null };
    const uSDFWorldToUnit = { value: new THREE.Matrix4() };
    const uSDFCollisionThreshold = { value: 0.01 };
    const uSDFEnabled = { value: sdfData ? 1.0 : 0.0 };
    const uMaxHeightAlongNormalHeight = { value: 1.0 };

    if (sdfData) {
      const bboxSize = sdfData.bbox.getSize(new THREE.Vector3());
      const scale = new THREE.Matrix4().makeScale(1 / bboxSize.x, 1 / bboxSize.y, 1 / bboxSize.z);
      const translate = new THREE.Matrix4().makeTranslation(-sdfData.bbox.min.x, -sdfData.bbox.min.y, -sdfData.bbox.min.z);
      uSDFWorldToUnit.value = new THREE.Matrix4().multiplyMatrices(scale, translate);
      const voxelSize = sdfData.voxelSize !== undefined ? sdfData.voxelSize : (bboxSize.x / (sdfData.n || 32));
      uSDFCollisionThreshold.value = voxelSize * 1.0;
    }

    const sharedUniforms = {
      uResolution, uTime, uDeltaTime, planeSize: uPlaneSize,
      uRiseSpeed, uSpreadStrength, uNoiseScale, uCollisionStrength,
      uSpawnScale, uGravityScale, uDrag, uSDF: uSDFTex,
      uSDFWorldToUnit, uSDFCollisionThreshold, uSDFEnabled,
      uMaxHeightAlongNormalHeight, uFlipDamp
    };

    Object.assign(positionVariable.material.uniforms, sharedUniforms);
    Object.assign(velocityVariable.material.uniforms, sharedUniforms);

    positionVariable.material.uniforms.planeOffset = { value: planeOffset.clone() };
    positionVariable.material.uniforms.planeBasisX = { value: basisX.clone() };
    positionVariable.material.uniforms.planeBasisY = { value: basisY.clone() };
    positionVariable.material.uniforms.planeBasisZ = { value: basisZ.clone() };

    velocityVariable.material.uniforms.planeOffset = positionVariable.material.uniforms.planeOffset;
    velocityVariable.material.uniforms.planeBasisX = positionVariable.material.uniforms.planeBasisX;
    velocityVariable.material.uniforms.planeBasisY = positionVariable.material.uniforms.planeBasisY;
    velocityVariable.material.uniforms.planeBasisZ = positionVariable.material.uniforms.planeBasisZ;
    velocityVariable.material.uniforms.uMaxAge = { value: 6.0 };

    const err = gpuCompute.init();
    if (err) console.error("GPUComputationRenderer.init error:", err);
    console.log('[PSF] gpuCompute.init', { err });

    try {
      gpuCompute.renderTexture(posTexture, positionVariable.renderTargets[0]);
      gpuCompute.renderTexture(posTexture, positionVariable.renderTargets[1]);
      gpuCompute.renderTexture(velTexture, velocityVariable.renderTargets[0]);
      gpuCompute.renderTexture(velTexture, velocityVariable.renderTargets[1]);
    } catch (e) {
      console.warn("renderTexture not available; initial textures remain in GPUCompute", e);
    }
    console.log('[PSF] initial renderTexture done, restoring main RT', { currentRT: this.renderer.getRenderTarget() });
    this.renderer.setRenderTarget(null);

    // particle geometry & material (guarded shader lookups)
    const vertexShaderText = _shaderText("vertexShader");
    const fragmentShaderText = _shaderText("fragmentShader");

    const geometry = new THREE.BufferGeometry();
    const particleUVs = new Float32Array(PARTICLES * 2);
    for (let i = 0; i < PARTICLES; i++) {
      const x = i % WIDTH, y = Math.floor(i / WIDTH);
      particleUVs[i * 2] = (x + 0.5) / WIDTH;
      particleUVs[i * 2 + 1] = (y + 0.5) / WIDTH;
    }
    geometry.setAttribute("particleUV", new THREE.BufferAttribute(particleUVs, 2));
    const particleMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTexturePosition: { value: gpuCompute.getCurrentRenderTarget(positionVariable).texture },
      uTextureVelocity: { value: gpuCompute.getCurrentRenderTarget(velocityVariable).texture },
      uTime: { value: 0 },
      uMaxAge: { value: 6.0 },
      uSpeedScale: { value: 1.5 },
      uDensityTex: { value: null },     // add this
      uDensityScale: { value: 1.0 }     // add this
    },
    vertexShader: document.getElementById("vertexShader").textContent,
    fragmentShader: document.getElementById("fragmentShader").textContent,
    transparent: true,
    depthTest: false,   // disable for visibility
    depthWrite: false
  });


    const particles = new THREE.Points(geometry, particleMaterial);

    // density setup (ping-pong RTs + splat + blur)
    const DENSITY_SIZE = densitySize;
    const useFloatRT = this.renderer.capabilities.isWebGL2 || !!this.renderer.getContext().getExtension('EXT_color_buffer_float');
    const rtParams = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      format: THREE.RedFormat,
      type: useFloatRT ? THREE.FloatType : THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false
    };
    const densityRT = new THREE.WebGLRenderTarget(DENSITY_SIZE, DENSITY_SIZE, rtParams);
    const densityRTTemp = new THREE.WebGLRenderTarget(DENSITY_SIZE, DENSITY_SIZE, rtParams);

    const splatVertex = _shaderText("densitySplatVertex");
    const splatFragment = _shaderText("densitySplatFragment");

    const splatMaterial = new THREE.ShaderMaterial({
      vertexShader: splatVertex,
      fragmentShader: splatFragment,
      uniforms: {
        uTexturePosition: { value: gpuCompute.getCurrentRenderTarget(positionVariable).texture },
        planeSize: { value: new THREE.Vector2(width, height) },
        planeOffset: { value: planeOffset.clone() },
        planeBasisX: { value: basisX.clone() },
        planeBasisZ: { value: basisZ.clone() },
        uSplatRadiusPixels: { value: 6.0 },
        uSplatSigma: { value: 0.35 }
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    const splatPoints = new THREE.Points(geometry, splatMaterial);
    const densityScene = new THREE.Scene(); densityScene.add(splatPoints);
    const densityCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const fsGeo = new THREE.BufferGeometry();
    fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0
    ]), 3));
    fsGeo.setIndex([0,1,2, 0,2,3]);

    const fullscreenVertexText = _shaderText("fullscreenVertex");
    const separableBlurFragmentText = _shaderText("separableBlurFragment");

    const blurMaterialH = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertexText,
      fragmentShader: separableBlurFragmentText,
      uniforms: { uTexture: { value: null }, uTexel: { value: new THREE.Vector2(1.0 / DENSITY_SIZE, 0.0) } },
      depthTest: false, depthWrite: false
    });
    const blurMaterialV = blurMaterialH.clone();
    blurMaterialV.uniforms = JSON.parse(JSON.stringify(blurMaterialH.uniforms));
    blurMaterialV.uniforms.uTexel.value = new THREE.Vector2(0.0, 1.0 / DENSITY_SIZE);
    const blurMesh = new THREE.Mesh(fsGeo, blurMaterialH);
    const blurScene = new THREE.Scene(); blurScene.add(blurMesh);

    velocityVariable.material.uniforms.uDensityTex = { value: null };
    velocityVariable.material.uniforms.uDensityScale = { value: 1.0 };
    velocityVariable.material.uniforms.uDensityThreshold = { value: 0.03 };
    velocityVariable.material.uniforms.uDensityTexel = { value: new THREE.Vector2(1.0 / DENSITY_SIZE, 1.0 / DENSITY_SIZE) };

    console.log('[PSF] creating instance', { WIDTH, PARTICLES, DENSITY_SIZE, useFloatRT });

    const instance = {
      gpuCompute,
      positionVariable,
      velocityVariable,
      particleMaterial,
      particles,
      density: {
        size: DENSITY_SIZE, rt: densityRT, rtTemp: densityRTTemp,
        splatMaterial, splatPoints, densityScene, densityCamera,
        blurMaterialH, blurMaterialV, blurScene, blurMesh
      },
      basisX, basisY, basisZ, planeOffset,
      step: null, start: null, stop: null, updateUniforms: null, dispose: null
    };

    instance.step = (elapsed, delta) => {
      positionVariable.material.uniforms.uTime.value = elapsed;
      velocityVariable.material.uniforms.uTime.value = elapsed;
      positionVariable.material.uniforms.uDeltaTime.value = delta;
      velocityVariable.material.uniforms.uDeltaTime.value = delta;

      if (elapsed % 1.0 < 0.016) {
        console.log('[PSF] step heartbeat', { elapsed: Number(elapsed.toFixed(3)), delta: Number(delta.toFixed(5)) });
      }

      if (instance.density) {
        const dens = instance.density;
        dens.splatMaterial.uniforms.uTexturePosition.value = gpuCompute.getCurrentRenderTarget(positionVariable).texture;

        console.log('[PSF] density pass start', { beforeRT: this.renderer.getRenderTarget() });
        this.renderer.setRenderTarget(dens.rt);
        this.renderer.clear();
        this.renderer.render(dens.densityScene, dens.densityCamera);

        dens.blurMaterialH.uniforms.uTexture.value = dens.rt.texture;
        dens.blurMesh.material = dens.blurMaterialH;
        this.renderer.setRenderTarget(dens.rtTemp);
        this.renderer.render(dens.blurScene, dens.densityCamera);

        dens.blurMaterialV.uniforms.uTexture.value = dens.rtTemp.texture;
        dens.blurMesh.material = dens.blurMaterialV;
        this.renderer.setRenderTarget(dens.rt);
        this.renderer.render(dens.blurScene, dens.densityCamera);

        // restore and report state
        this.renderer.setRenderTarget(null);
        console.log('[PSF] density pass end', { afterRT: this.renderer.getRenderTarget(), densRT: dens.rt.texture });
        velocityVariable.material.uniforms.uDensityTex.value = dens.rt.texture;
        if (instance.particleMaterial?.uniforms?.uDensityTex) instance.particleMaterial.uniforms.uDensityTex.value = dens.rt.texture;
      }

      gpuCompute.compute();
      // ensure main framebuffer is restored after compute as a defensive measure
      try { this.renderer.setRenderTarget(null); } catch(e) {}
      console.log('[PSF] gpuCompute.compute done', { currentRT: this.renderer.getRenderTarget() });

      const posTex = gpuCompute.getCurrentRenderTarget(positionVariable).texture;
      const velTex = gpuCompute.getCurrentRenderTarget(velocityVariable).texture;
      if (instance.particleMaterial && instance.particleMaterial.uniforms) {
        instance.particleMaterial.uniforms.uTexturePosition.value = posTex;
        instance.particleMaterial.uniforms.uTextureVelocity.value = velTex;
        instance.particleMaterial.uniforms.uTime.value = elapsed;
      }
    };

    let running = false;
    instance.start = () => { running = true; };
    instance.stop = () => { running = false; };
    instance.updateUniforms = (u) => {
      Object.keys(u || {}).forEach(k => {
        if (k in velocityVariable.material.uniforms) velocityVariable.material.uniforms[k].value = u[k];
        if (k in positionVariable.material.uniforms) positionVariable.material.uniforms[k].value = u[k];
        if (instance.particleMaterial.uniforms && (k in instance.particleMaterial.uniforms)) instance.particleMaterial.uniforms[k].value = u[k];
      });
    };

    instance.dispose = () => {
      try { gpuCompute.dispose(); } catch(e){}
      try { instance.particleMaterial.dispose(); } catch(e){}
      try { geometry.dispose(); } catch(e){}
      try { densityRT.dispose(); densityRTTemp.dispose(); } catch(e){}
      try { splatMaterial.dispose(); } catch(e){}
      try { blurMaterialH.dispose(); blurMaterialV.dispose(); } catch(e){}
      this._instances.delete(instance);
    };

    instance.particleMaterial = particleMaterial;
    instance.particleGeometry = geometry;

    console.log('[PSF] instance created', { particles: PARTICLES, particleMesh: particles, densityRT: instance.density?.rt });

    return instance;
  }

  // dispose everything
  dispose() {
    for (const inst of Array.from(this._instances)) {
      try { inst.dispose(); } catch (e) {}
    }
    this._instances.clear();
  }
}
