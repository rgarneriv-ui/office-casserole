/**
 * Minimal ZIP container writer/reader for the OOXML pipeline (spec §5.2).
 * Deflate via the platform CompressionStream/DecompressionStream (browser and
 * Node ≥18); falls back to STORED entries when compression is unavailable.
 * Scope: single-disk archives, no ZIP64, no encryption — sufficient for OOXML
 * packages well under 4 GB; out-of-scope inputs fail loudly, never silently.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// ---------- CRC-32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- deflate helpers ----------
async function pipeThrough(data: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const src: ReadableStream<Uint8Array> = new Blob([data as BlobPart]).stream();
  const buf = await new Response(src.pipeThrough(stream as never)).arrayBuffer();
  return new Uint8Array(buf);
}

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  return pipeThrough(data, new CompressionStream("deflate-raw"));
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Cannot read compressed ZIP entries: DecompressionStream unavailable");
  }
  return pipeThrough(data, new DecompressionStream("deflate-raw"));
}

// ---------- writer ----------
const textEncoder = new TextEncoder();

export async function zipWrite(entries: ZipEntry[]): Promise<Uint8Array> {
  interface Prepared {
    nameBytes: Uint8Array;
    data: Uint8Array;
    raw: Uint8Array;
    method: number;
    crc: number;
    offset: number;
  }
  const prepared: Prepared[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const crc = crc32(entry.data);
    const deflated = await deflateRaw(entry.data);
    const useDeflate = deflated !== null && deflated.length < entry.data.length;
    const raw = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0, true); // flags
    header.setUint16(8, method, true);
    header.setUint16(10, 0, true); // mod time
    header.setUint16(12, 0x21, true); // mod date (1980-01-01)
    header.setUint32(14, crc, true);
    header.setUint32(18, raw.length, true);
    header.setUint32(22, entry.data.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true); // extra len

    prepared.push({ nameBytes, data: entry.data, raw, method, crc, offset });
    chunks.push(new Uint8Array(header.buffer), nameBytes, raw);
    offset += 30 + nameBytes.length + raw.length;
  }

  const cdStart = offset;
  for (const p of prepared) {
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0, true);
    cd.setUint16(10, p.method, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, p.crc, true);
    cd.setUint32(20, p.raw.length, true);
    cd.setUint32(24, p.data.length, true);
    cd.setUint16(28, p.nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra
    cd.setUint16(32, 0, true); // comment
    cd.setUint16(34, 0, true); // disk start
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, p.offset, true);
    chunks.push(new Uint8Array(cd.buffer), p.nameBytes);
    offset += 46 + p.nameBytes.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, prepared.length, true);
  eocd.setUint16(10, prepared.length, true);
  eocd.setUint32(12, offset - cdStart, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  chunks.push(new Uint8Array(eocd.buffer));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ---------- reader ----------
const textDecoder = new TextDecoder();

export async function zipRead(bytes: Uint8Array): Promise<ZipEntry[]> {
  // locate EOCD: scan backward over at most 64KB + 22 bytes
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const scanFloor = Math.max(0, bytes.length - 65558);
  for (let i = bytes.length - 22; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a ZIP archive (no end-of-central-directory record)");
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) {
      throw new Error("Corrupt ZIP: bad central-directory signature");
    }
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) data = await inflateRaw(new Uint8Array(raw));
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);

    if (data.length !== uncompSize) {
      throw new Error(`Corrupt ZIP entry ${name}: size mismatch`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`Corrupt ZIP entry ${name}: CRC mismatch`);
    }
    entries.push({ name, data });
  }
  return entries;
}
