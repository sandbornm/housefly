import { readFile } from 'node:fs/promises';
import { loadNeuralGraph } from '../../src/neural/data.ts';

export function loadNodeGraph(baseURL = new URL('../../public/', import.meta.url)) {
  return loadNeuralGraph(baseURL, { read: async url => {
    const bytes = await readFile(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } });
}
