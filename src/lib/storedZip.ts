export interface StoredZipEntry {
  blob: Blob;
  lastModified?: number;
  name: string;
}

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const UINT32_MAX = 0xffffffff;

let crcTable: Uint32Array | null = null;

export async function createStoredZip(entries: StoredZipEntry[]) {
  if (entries.length === 0) {
    throw new Error("Aucun fichier a zipper");
  }

  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(normalizeEntryName(entry.name));
    const crc = crc32(data);
    const { dosDate, dosTime } = toDosDateTime(
      new Date(entry.lastModified ?? Date.now()),
    );

    assertZip32Size(data.byteLength, "Fichier trop volumineux pour ce ZIP");
    assertZip32Size(localOffset, "Archive trop volumineuse pour ce ZIP");

    const localHeader = createLocalHeader({
      crc,
      dosDate,
      dosTime,
      nameBytes,
      size: data.byteLength,
    });
    const centralHeader = createCentralHeader({
      crc,
      dosDate,
      dosTime,
      localOffset,
      nameBytes,
      size: data.byteLength,
    });

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    localOffset += localHeader.byteLength + data.byteLength;
    centralSize += centralHeader.byteLength;
  }

  assertZip32Size(localOffset, "Archive trop volumineuse pour ce ZIP");
  assertZip32Size(centralSize, "Archive trop volumineuse pour ce ZIP");

  const endRecord = createEndOfCentralDirectory({
    centralOffset: localOffset,
    centralSize,
    entryCount: entries.length,
  });

  return new Blob([...localParts, ...centralParts, endRecord], {
    type: "application/zip",
  });
}

function createLocalHeader({
  crc,
  dosDate,
  dosTime,
  nameBytes,
  size,
}: {
  crc: number;
  dosDate: number;
  dosTime: number;
  nameBytes: Uint8Array;
  size: number;
}) {
  const header = new Uint8Array(30 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_UTF8_FLAG, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function createCentralHeader({
  crc,
  dosDate,
  dosTime,
  localOffset,
  nameBytes,
  size,
}: {
  crc: number;
  dosDate: number;
  dosTime: number;
  localOffset: number;
  nameBytes: Uint8Array;
  size: number;
}) {
  const header = new Uint8Array(46 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, ZIP_UTF8_FLAG, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosTime, true);
  view.setUint16(14, dosDate, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, nameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localOffset, true);
  header.set(nameBytes, 46);
  return header;
}

function createEndOfCentralDirectory({
  centralOffset,
  centralSize,
  entryCount,
}: {
  centralOffset: number;
  centralSize: number;
  entryCount: number;
}) {
  if (entryCount > 0xffff) {
    throw new Error("Trop de fichiers pour ce ZIP");
  }

  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  view.setUint16(20, 0, true);
  return record;
}

function crc32(bytes: Uint8Array) {
  const table = getCrcTable();
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getCrcTable() {
  if (crcTable) {
    return crcTable;
  }

  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}

function normalizeEntryName(name: string) {
  const normalized =
    name
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .join("/")
      .trim() || "image.jpg";

  return normalized;
}

function toDosDateTime(date: Date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hours << 11) | (minutes << 5) | seconds,
  };
}

function assertZip32Size(value: number, message: string) {
  if (value > UINT32_MAX) {
    throw new Error(message);
  }
}
