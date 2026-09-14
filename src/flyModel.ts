import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export interface FlyMotion {
  moving?: boolean;
  reaching?: boolean;
  throwing?: boolean;
  swinging?: boolean;
}

export interface DrosophilaActor {
  group: THREE.Group;
  body: THREE.Group;
  jersey: THREE.MeshStandardMaterial;
  setTeam(color: number): void;
  animate(time: number, motion?: FlyMotion, selected?: boolean): void;
}

let template: THREE.Group | undefined;
let loading: Promise<THREE.Group> | undefined;

export async function loadDrosophilaTemplate(): Promise<THREE.Group> {
  if (template) return template;
  if (!loading) {
    loading = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/drosophila.glb`).then(gltf => {
      gltf.scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = true;
          object.receiveShadow = true;
          object.geometry.computeBoundingSphere();
        }
      });
      template = gltf.scene;
      return template;
    });
  }
  return loading;
}

export function createDrosophila(teamColor: number, scale = 1.25): DrosophilaActor {
  if (!template) throw new Error("Drosophila template has not loaded");
  const group = new THREE.Group();
  const inner = template.clone(true);
  group.add(inner);
  let jersey = new THREE.MeshStandardMaterial();
  const thorax = inner.getObjectByName("thorax");
  if (thorax instanceof THREE.Mesh) {
    jersey = (thorax.material as THREE.MeshStandardMaterial).clone();
    thorax.material = jersey;
  }
  jersey.color.setHex(teamColor);
  const lWing = inner.getObjectByName("lWing");
  const rWing = inner.getObjectByName("rWing");
  inner.scale.setScalar(scale);
  return {
    group, body: inner, jersey,
    setTeam(color: number) { jersey.color.setHex(color); },
    animate(time: number, motion: FlyMotion = {}, selected = false) {
      const moving = Boolean(motion.moving);
      inner.position.y = moving ? .08 + Math.sin(time * 22) * .035 : Math.sin(time * 2.4) * .016;
      inner.rotation.x = motion.swinging ? -.22 : motion.reaching ? -.08 : motion.throwing ? -.12 : 0;
      const beat = moving ? 70 : motion.reaching || motion.throwing || motion.swinging ? 36 : 18;
      const amp = moving ? .38 : .06;
      if (lWing) { lWing.rotation.x = .5; lWing.rotation.z = .06 + Math.sin(time * beat) * amp; }
      if (rWing) { rWing.rotation.x = .5; rWing.rotation.z = -.06 - Math.sin(time * beat) * amp; }
      inner.scale.setScalar(selected ? scale * 1.14 : scale);
    },
  };
}
