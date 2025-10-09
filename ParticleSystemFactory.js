// ParticleSystemFactory.js
import * as THREE from "https://esm.sh/three@0.128";
import { GPUComputationRenderer } from 'https://esm.sh/three@0.128/examples/jsm/misc/GPUComputationRenderer.js';
import { BufferGeometryUtils } from 'https://esm.sh/three@0.128/examples/jsm/utils/BufferGeometryUtils.js';

export class ParticleSystemFactory {
  constructor(renderer, { defaultWidth = 600, defaultDensity = 256 } = {}) {
    if (!renderer) throw new Error("ParticleSystemFactory requires a THREE.WebGLRenderer instance");
    this.renderer = renderer;
    this.defaultWidth = defaultWidth;
    this.defaultDensity = defaultDensity;
    this._instances = new Set();
  }

  // Create from a plane mesh. Returns Promise<ParticleSystemInstance>
  async createFromPlane(planeMesh, {
    particlesWidth = this.defaultWidth,
    densitySize = this.defaultDensity,
    sdfData = null,
    spawnScale = 0.5
  } = {}) {
    if (!planeMesh || !planeMesh.geometry) throw new Error("createFromPlane: planeMesh with geometry required");
    const inst = await this._buildSystem(planeMesh, { particlesWidth, densitySize, sdfData, spawnScale });
    this._instances.add(inst);
    return inst;
  }

  // Build the system (core implementation adapted from project.txt)
  async _buildSystem(plane, { particlesWidth, densitySize, sdfData, spawnScale }) {
    const WIDTH = particlesWidth;
    const PARTICLES = WIDTH * WIDTH;
    const gpuCompute = new GPUComputationRenderer(WIDTH, WIDTH, this.renderer);

    // Utility: create empty textures
    const posTexture = gpuCompute.createTexture();
    const velTexture = gpuCompute.createTexture();
    const posArray = posTexture.image.data;
    const velArray = velTexture.image.data;

    // compute plane basis and extents (world-space)
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
    const tmp = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      tmp.fromBufferAttribute(posAttr, i).applyMatrix4(plane.matrixWorld);
      const px = tmp.dot(basisX);
      const pz = tmp.dot(basisZ);
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
      let idx = 0;
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
        posArray[i + 3] = 0.6 + Math.random() * 0.2; // freshness flag
        idx++;
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
        velArray[i + 3] = 0.02 + Math.random() * 0.12; // small age
      }
      // safety clamp initial speeds
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

    // add variables to GPUComputationRenderer
    const positionVariable = gpuCompute.addVariable("texturePosition", document.getElementById("texturePositionShader").textContent, posTexture);
    const velocityVariable = gpuCompute.addVariable("textureVelocity", document.getElementById("textureVelocityShader").textContent, velTexture);

    gpuCompute.setVariableDependencies(positionVariable, [positionVariable, velocityVariable]);
    gpuCompute.setVariableDependencies(velocityVariable, [positionVariable, velocityVariable]);

    // shared uniforms
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
      // worldToUnit = scale * translate (maps world -> [0..1] space)
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

    // attach plane transforms
    positionVariable.material.uniforms.planeOffset = { value: planeOffset.clone() };
    positionVariable.material.uniforms.planeBasisX = { value: basisX.clone() };
    positionVariable.material.uniforms.planeBasisY = { value: basisY.clone() };
    positionVariable.material.uniforms.planeBasisZ = { value: basisZ.clone() };

    velocityVariable.material.uniforms.planeOffset = positionVariable.material.uniforms.planeOffset;
    velocityVariable.material.uniforms.planeBasisX = positionVariable.material.uniforms.planeBasisX;
    velocityVariable.material.uniforms.planeBasisY = positionVariable.material.uniforms.planeBasisY;
    velocityVariable.material.uniforms.planeBasisZ = positionVariable.material.uniforms.planeBasisZ;
    velocityVariable.material.uniforms.uMaxAge = { value: 6.0 };

    // init compute
    const err = gpuCompute.init();
    if (err) console.error("GPUComputationRenderer.init error:", err);

    // try to ensure render targets contain seeded data
    try {
      gpuCompute.renderTexture(posTexture, positionVariable.renderTargets[0]);
      gpuCompute.renderTexture(posTexture, positionVariable.renderTargets[1]);
      gpuCompute.renderTexture(velTexture, velocityVariable.renderTargets[0]);
      gpuCompute.renderTexture(velTexture, velocityVariable.renderTargets[1]);
    } catch (e) {
      console.warn("renderTexture not available; initial textures remain in GPUCompute", e);
    }

    // build particle geometry and material
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
        uSpeedScale: { value: 1.5 }
      },
      vertexShader: document.getElementById("vertexShader").textContent,
      fragmentShader: document.getElementById("fragmentShader").textContent,
      transparent: true,
      depthTest: true
    });

    const particles = new THREE.Points(geometry, particleMaterial);

    // DENSITY setup (ping-pong RTs + splat points + blur)
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

    // splat material for density (uses densitySplat shaders present in document)
    const splatMaterial = new THREE.ShaderMaterial({
      vertexShader: document.getElementById("densitySplatVertex").textContent,
      fragmentShader: document.getElementById("densitySplatFragment").textContent,
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
    const densityScene = new THREE.Scene();
    densityScene.add(splatPoints);
    const densityCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // blur materials (fullscreen quad)
    const fsGeo = new THREE.BufferGeometry();
    fsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0
    ]), 3));
    fsGeo.setIndex([0,1,2, 0,2,3]);
    const blurMaterialH = new THREE.ShaderMaterial({
      vertexShader: document.getElementById("fullscreenVertex").textContent,
      fragmentShader: document.getElementById("separableBlurFragment").textContent,
      uniforms: { uTexture: { value: null }, uTexel: { value: new THREE.Vector2(1.0 / DENSITY_SIZE, 0.0) } },
      depthTest: false, depthWrite: false
    });
    const blurMaterialV = blurMaterialH.clone();
    blurMaterialV.uniforms = JSON.parse(JSON.stringify(blurMaterialH.uniforms));
    blurMaterialV.uniforms.uTexel.value = new THREE.Vector2(0.0, 1.0 / DENSITY_SIZE);
    const blurMesh = new THREE.Mesh(fsGeo, blurMaterialH);
    const blurScene = new THREE.Scene(); blurScene.add(blurMesh);

    // attach density uniforms to velocity shader
    velocityVariable.material.uniforms.uDensityTex = { value: null };
    velocityVariable.material.uniforms.uDensityScale = { value: 1.0 };
    velocityVariable.material.uniforms.uDensityThreshold = { value: 0.03 };
    velocityVariable.material.uniforms.uDensityTexel = { value: new THREE.Vector2(1.0 / DENSITY_SIZE, 1.0 / DENSITY_SIZE) };

    // return instance object
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
      basisX, basisY, basisZ, planeOffset, dispose: null,
      start: null, stop: null, updateUniforms: null
    };

    // animate-step helper for this system (to be called from app's animate)
    instance.step = (elapsed, delta) => {
      positionVariable.material.uniforms.uTime.value = elapsed;
      velocityVariable.material.uniforms.uTime.value = elapsed;
      positionVariable.material.uniforms.uDeltaTime.value = delta;
      velocityVariable.material.uniforms.uDeltaTime.value = delta;

      // density pass
      if (instance.density) {
        const dens = instance.density;
        // set splat source
        dens.splatMaterial.uniforms.uTexturePosition.value = gpuCompute.getCurrentRenderTarget(positionVariable).texture;

        // render splats into dens.rt
        this.renderer.setRenderTarget(dens.rt);
        this.renderer.clear();
        this.renderer.render(dens.densityScene, dens.densityCamera);

        // blur horizontal -> temp
        dens.blurMaterialH.uniforms.uTexture.value = dens.rt.texture;
        dens.blurMesh.material = dens.blurMaterialH;
        this.renderer.setRenderTarget(dens.rtTemp);
        this.renderer.render(dens.blurScene, dens.densityCamera);

        // blur vertical -> rt
        dens.blurMaterialV.uniforms.uTexture.value = dens.rtTemp.texture;
        dens.blurMesh.material = dens.blurMaterialV;
        this.renderer.setRenderTarget(dens.rt);
        this.renderer.render(dens.blurScene, dens.densityCamera);

        this.renderer.setRenderTarget(null);

        // bind to velocity shader
        velocityVariable.material.uniforms.uDensityTex.value = dens.rt.texture;
        if (instance.particleMaterial?.uniforms?.uDensityTex) instance.particleMaterial.uniforms.uDensityTex.value = dens.rt.texture;
      }

      // compute step
      gpuCompute.compute();

      // update particle material textures
      const posTex = gpuCompute.getCurrentRenderTarget(positionVariable).texture;
      const velTex = gpuCompute.getCurrentRenderTarget(velocityVariable).texture;
      if (instance.particleMaterial && instance.particleMaterial.uniforms) {
        instance.particleMaterial.uniforms.uTexturePosition.value = posTex;
        instance.particleMaterial.uniforms.uTextureVelocity.value = velTex;
        instance.particleMaterial.uniforms.uTime.value = elapsed;
      }
    };

    // expose control methods
    let running = false;
    instance.start = () => { running = true; };
    instance.stop = () => { running = false; };
    instance.updateUniforms = (u) => {
      Object.keys(u || {}).forEach(k => {
        // try to find in velocity material first, then position, then particle
        if (k in velocityVariable.material.uniforms) velocityVariable.material.uniforms[k].value = u[k];
        if (k in positionVariable.material.uniforms) positionVariable.material.uniforms[k].value = u[k];
        if (instance.particleMaterial.uniforms && (k in instance.particleMaterial.uniforms)) instance.particleMaterial.uniforms[k].value = u[k];
      });
    };

    instance.dispose = () => {
      // remove points from scene handled by caller
      try {
        // dispose GPU resources
        gpuCompute.dispose();
      } catch(e) {}
      // dispose materials and geometries
      try { instance.particleMaterial.dispose(); } catch(e){}
      try { geometry.dispose(); } catch(e){}
      try { densityRT.dispose(); densityRTTemp.dispose(); } catch(e){}
      try { splatMaterial.dispose(); } catch(e){}
      try { blurMaterialH.dispose(); blurMaterialV.dispose(); } catch(e){}
      // remove references
      this._instances.delete(instance);
    };

    // attach convenient references
    instance.particleMaterial = particleMaterial;
    instance.particleGeometry = geometry;

    // done: return instance
    return instance;
  }

  dispose() {
    for (const inst of Array.from(this._instances)) {
      try { inst.dispose(); } catch (e) {}
    }
    this._instances.clear();
  }
}
