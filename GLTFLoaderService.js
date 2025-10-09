// GLTFLoaderService.js
import * as THREE from "https://esm.sh/three@0.128";
import { GLTFLoader } from "https://esm.sh/three@0.128/examples/jsm/loaders/GLTFLoader.js?deps=three@0.128";
import { DRACOLoader } from "https://esm.sh/three@0.128/examples/jsm/loaders/DRACOLoader.js?deps=three@0.128";

// GLTFLoaderService.html
// Plain JS (no <script> tags). Designed to be injected into a module that already imports THREE, GLTFLoader and DRACOLoader,
// or to be used in a file that imports those modules and then evaluates this text in module scope.

class GLTFLoaderService {
  constructor({ dracoPath = null } = {}) {
    this._dracoPath = dracoPath;
    this._loader = null;    // lazy-initialized GLTFLoader instance
    this._draco = null;     // lazy-initialized DRACOLoader (if requested)
  }

  // lazy create the GLTFLoader (and DRACOLoader if requested)
  _ensureLoader() {
    if (this._loader) return;
    if (typeof GLTFLoader === 'undefined') {
      throw new Error('GLTFLoader is not available in module scope. Import GLTFLoader before using GLTFLoaderService.');
    }
    this._loader = new GLTFLoader();

    if (this._dracoPath) {
      if (typeof DRACOLoader === 'undefined') {
        console.warn('DRACOLoader is not available; continuing without Draco support.');
      } else {
        this._draco = new DRACOLoader();
        this._draco.setDecoderPath(this._dracoPath);
        this._loader.setDRACOLoader(this._draco);
      }
    }
  }

  // load(url) -> Promise resolving { scene, meshes, bbox, gltf }
  load(url) {
    this._ensureLoader();
    return new Promise((resolve, reject) => {
      this._loader.load(
        url,
        (gltf) => {
          const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]) || null;
          if (scene) scene.updateMatrixWorld(true);
          const meshes = [];
          if (scene) {
            scene.traverse((c) => { if (c.isMesh) meshes.push(c); });
          }
          const bbox = scene ? new THREE.Box3().setFromObject(scene) : null;
          resolve({ scene, meshes, bbox, gltf });
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  // convenience: parse ArrayBuffer (like GLTFLoader.parse)
  parse(arraybuffer, path = '') {
    this._ensureLoader();
    return new Promise((resolve, reject) => {
      // GLTFLoader.parse exists on the loader instance
      if (typeof this._loader.parse !== 'function') {
        reject(new Error('GLTFLoader.parse is not available on this loader instance.'));
        return;
      }
      this._loader.parse(arraybuffer, path, (gltf) => {
        const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]) || null;
        if (scene) scene.updateMatrixWorld(true);
        const meshes = [];
        if (scene) {
          scene.traverse((c) => { if (c.isMesh) meshes.push(c); });
        }
        const bbox = scene ? new THREE.Box3().setFromObject(scene) : null;
        resolve({ scene, meshes, bbox, gltf });
      }, reject);
    });
  }

  // dispose loader/decoder resources (safe to call multiple times)
  dispose() {
    try {
      if (this._draco && typeof this._draco.dispose === 'function') this._draco.dispose();
    } catch (e) {}
    this._draco = null;
    this._loader = null;
  }
}

// Export/attach for use depending on environment:
// - If running inside an ES module that will import this file directly, keep the exported name.
// - If you inject this text into a module scope, the class will be available by name.

export { GLTFLoaderService };
