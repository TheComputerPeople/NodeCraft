// npm-style package tarballs for the tests: gzipped ustar, with a pax header for a long path.
import { gzipSync } from 'node:zlib';

export interface TarEntry {
  path: string;
  data?: string;
  // '0' a file (the default), '5' a folder.
  type?: '0' | '5';
}

function header(name: string, size: number, type: string, prefix = ''): Buffer {
  const block = Buffer.alloc(512);
  const put = (text: string, at: number, length: number) => block.write(text.slice(0, length), at, length, 'utf8');
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  // The checksum counts its own field as spaces.
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, b) => total + b, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

export function tar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '', 'utf8');
    if (Buffer.byteLength(entry.path) > 100) {
      // A pax record: "<length> path=<value>\n", its length counting itself.
      const body = ` path=${entry.path}\n`;
      let length = body.length + 1;
      while (`${length}${body}`.length !== length) length += 1;
      const record = Buffer.from(`${length}${body}`, 'utf8');
      blocks.push(header('PaxHeader', record.length, 'x'), padded(record));
    }
    blocks.push(header(entry.path, entry.type === '5' ? 0 : data.length, entry.type ?? '0'));
    if (entry.type !== '5') blocks.push(padded(data));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

// A package's files, under npm's "package/" folder.
export function tarball(files: Record<string, string>): Buffer {
  return gzipSync(tar(Object.entries(files).map(([path, data]) => ({ path: `package/${path}`, data }))));
}
