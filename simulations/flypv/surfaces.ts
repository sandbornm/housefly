import * as THREE from 'three';

type Surface = 'stone' | 'timber' | 'roof' | 'plaster' | 'paving';
const noise = (x: number, y: number) => ((Math.imul(x + 17, 374761393) ^ Math.imul(y + 43, 668265263)) >>> 0) / 4294967295;

// Small repeating raster maps keep masonry and grain legible at street level.
export function surfaceMaterial(color: number, surface?: Surface): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color, roughness: surface === 'roof' ? .84 : .96, flatShading: true });
  if (!surface) return material;
  const size = 256, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let value = 1;
    if (surface === 'stone' || surface === 'paving') {
      const height = surface === 'stone' ? 32 : 64, row = Math.floor(y / height);
      const offset = (row % 2) * 32, col = Math.floor((x + offset) / 64);
      const u = (x + offset) % 64, v = y % height;
      const edge = Math.min(u, 63 - u, v, height - 1 - v);
      value = edge < 2 ? .43 : .79 + noise(col, row) * .24 + (noise(x, y) - .5) * .1;
      if (edge >= 2 && (v < 5 || u < 4)) value += .1;
      if (v > height - 5 && edge >= 2) value -= .13;
    } else if (surface === 'roof') {
      const row = Math.floor(y / 32), u = (x + (row % 2) * 16) % 32, v = y % 32;
      value = .8 + noise(Math.floor((x + (row % 2) * 16) / 32), row) * .2;
      if (u < 2 || v > 28) value = .43;
      else if (v < 3) value += .16;
      value += (noise(x, y) - .5) * .06;
    } else if (surface === 'timber') {
      const grain = Math.sin(x * .43 + Math.sin(y * .033) * 1.8 + Math.sin(x * .12));
      value = .8 + grain * .11 + noise(x, y) * .1;
      if (x % 64 < 3) value = .5;
      const knot = Math.hypot((x % 64 - 31) * 1.8, (y % 128 - 67) * .52);
      if (knot < 15) value -= (Math.sin(knot * .65) + 1) * .09;
    } else value = .88 + noise(x, y) * .1 + Math.sin(x * .07) * Math.sin(y * .09) * .025;
    const i = (y * size + x) * 4, channel = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
    pixels[i] = pixels[i + 1] = pixels[i + 2] = channel; pixels[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.anisotropy = 4; texture.needsUpdate = true;
  material.map = texture;
  // World-sized UVs preserve the same stone scale on instanced walls and houses.
  material.onBeforeCompile = shader => {
    const scale = surface === 'timber' ? 1.7 : surface === 'roof' ? 4.5 : surface === 'paving' ? 5 : 4;
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `
      #include <uv_vertex>
      vec4 surfacePosition = vec4(position, 1.0);
      vec3 surfaceNormal = normal;
      #ifdef USE_INSTANCING
        surfacePosition = instanceMatrix * surfacePosition;
        surfaceNormal = mat3(instanceMatrix) * surfaceNormal;
      #endif
      surfacePosition = modelMatrix * surfacePosition;
      surfaceNormal = abs(mat3(modelMatrix) * surfaceNormal);
      vec2 surfaceUv = surfaceNormal.y > max(surfaceNormal.x, surfaceNormal.z) ? surfacePosition.xz
        : surfaceNormal.x > surfaceNormal.z ? surfacePosition.zy : surfacePosition.xy;
      vMapUv = ${surface === 'roof' ? 'surfacePosition.zx' : 'surfaceUv'} / ${scale.toFixed(1)};
    `);
  };
  material.customProgramCacheKey = () => `flypv-surface-${surface}`;
  return material;
}
