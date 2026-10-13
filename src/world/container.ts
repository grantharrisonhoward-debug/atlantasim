// Reader for the "ATLW" binary container written by tools/build_world.py:
//   [u32 magic][u32 headerLen][header JSON][typed arrays, 8-byte aligned]

export type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array;

export interface Container<H> {
  header: H;
  arrays: Record<string, TypedArray>;
}

const CTORS: Record<string, any> = {
  i1: Int8Array, u1: Uint8Array, i2: Int16Array, u2: Uint16Array,
  i4: Int32Array, u4: Uint32Array, f4: Float32Array,
};

export function parseContainer<H = any>(buf: ArrayBuffer): Container<H> {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'ATLW') throw new Error('bad world container');
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const base = 8 + hlen;
  const arrays: Record<string, TypedArray> = {};
  for (const [name, [dtype, off, count]] of Object.entries(header.arrays as Record<string, [string, number, number]>)) {
    const C = CTORS[dtype];
    if (!C) throw new Error('unknown dtype ' + dtype);
    const start = base + off;
    if (start % C.BYTES_PER_ELEMENT === 0) arrays[name] = new C(buf, start, count);
    else arrays[name] = new C(buf.slice(start, start + count * C.BYTES_PER_ELEMENT));
  }
  return { header, arrays };
}
