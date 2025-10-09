// GLTFLoaderService.js
import * as THREE from "https://esm.sh/three@0.128";
import { GLTFLoader } from "https://esm.sh/three@0.128/examples/jsm/loaders/GLTFLoader.js?deps=three@0.128";
import { DRACOLoader } from "https://esm.sh/three@0.128/examples/jsm/loaders/DRACOLoader.js?deps=three@0.128";

export class GLTFLoaderService {
  constructor({ dracoPath = null } = {}) {
    this.loader = new GLTFLoader();
    if (dracoPath) {
      const draco = new DRACOLoader();
      draco.setDecoderPath(dracoPath);
      this.loader.setDRACOLoader(draco);
      this._draco = draco;
    } else {
      this._draco = null;
    }
  }

  // load by URL, returns Promise{ scene, meshes[], bbox }
  load(url) {
    return new Promise((resolve, reject) => {
      this.loader.load(url,
        (gltf) => {
          const scene = gltf.scene || gltf.scenes?.[0] || new THREE.Group();
          scene.updateMatrixWorld(true);
          const meshes = [];
          scene.traverse((c) => { if (c.isMesh) meshes.push(c); });
          const bbox = new THREE.Box3().setFromObject(scene);
          resolve({ scene, meshes, bbox, gltf });
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  // parse ArrayBuffer (optional convenience)
  parse(arraybuffer, path = '') {
    return new Promise((resolve, reject) => {
      this.loader.parse(arraybuffer, path, (gltf) => {
        const scene = gltf.scene || gltf.scenes?.[0] || new THREE.Group();
        scene.updateMatrixWorld(true);
        const meshes = [];
        scene.traverse((c) => { if (c.isMesh) meshes.push(c); });
        const bbox = new THREE.Box3().setFromObject(scene);
        resolve({ scene, meshes, bbox, gltf });
      }, reject);
    });
  }

  dispose() {
    // DRACOLoader exposes dispose
    if (this._draco && typeof this._draco.dispose === 'function') this._draco.dispose();
    this.loader = null;
  }
}
