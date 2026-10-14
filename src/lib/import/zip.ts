import { crc32, inflateRawSync } from "node:zlib";

/**
 * Internal to the import module: the entries of a zip, read out of memory.
 *
 * Only what a `.docx` is: stored or deflated entries, no ZIP64, no encryption.
 * Nothing is ever extracted to disk under the name an entry carries, so an
 * entry called `../../x` is a string in a map and nothing more. Each entry is
 * checked against its declared size and CRC, and inflating stops at the size
 * declared, so a bomb ends as a refusal rather than as memory.
 */

const END_OF_DIRECTORY = 0x06_05_4b_50;
const DIRECTORY_ENTRY = 0x02_01_4b_50;
const LOCAL_HEADER = 0x04_03_4b_50;
const ZIP64 = 0xff_ff_ff_ff;
/** Far above any picture a treatment holds, and below what a bomb declares. */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

interface ZipEntry {
  readonly compressed: number;
  readonly crc: number;
  readonly flags: number;
  readonly method: number;
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface Archive {
  readonly bytes: Buffer;
  readonly entries: ReadonlyMap<string, ZipEntry>;
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** The archive's directory; entries are read one by one, on demand. */
export function openArchive(bytes: Buffer): Archive {
  const end = endOfDirectory(bytes);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);

  if (count === 0xff_ff || at === ZIP64) {
    throw new ArchiveError("plik .docx w formacie ZIP64 nie jest obsługiwany");
  }

  const entries = new Map<string, ZipEntry>();

  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw new ArchiveError("plik .docx jest uszkodzony: katalog archiwum się urywa");
    }

    const nameLength = bytes.readUInt16LE(at + 28);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);

    entries.set(name, {
      compressed: bytes.readUInt32LE(at + 20),
      crc: bytes.readUInt32LE(at + 16),
      flags: bytes.readUInt16LE(at + 8),
      method: bytes.readUInt16LE(at + 10),
      name,
      offset: bytes.readUInt32LE(at + 42),
      size: bytes.readUInt32LE(at + 24),
    });
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }

  return { bytes, entries };
}

function endOfDirectory(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - 22 - 0xff_ff);

  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (bytes.readUInt32LE(at) === END_OF_DIRECTORY) {
      return at;
    }
  }

  throw new ArchiveError("to nie jest plik .docx: brak katalogu archiwum ZIP");
}

/** One entry's bytes, checked against the size and CRC the directory declares. */
export function readEntry(archive: Archive, name: string): Buffer {
  const entry = archive.entries.get(name);

  if (entry === undefined) {
    throw new ArchiveError(`plik .docx nie zawiera części ${name}`);
  }

  // Bit 0 of the flags: the entry is encrypted.
  if (entry.flags % 2 === 1) {
    throw new ArchiveError(`${name}: dokument jest zaszyfrowany, zapisz go bez hasła`);
  }

  if (entry.size > MAX_ENTRY_BYTES || entry.compressed === ZIP64) {
    throw new ArchiveError(`${name}: część dokumentu jest za duża (${entry.size} B)`);
  }

  const { bytes } = archive;

  if (bytes.readUInt32LE(entry.offset) !== LOCAL_HEADER) {
    throw new ArchiveError(`plik .docx jest uszkodzony: brak nagłówka części ${name}`);
  }

  const start =
    entry.offset +
    30 +
    bytes.readUInt16LE(entry.offset + 26) +
    bytes.readUInt16LE(entry.offset + 28);
  const raw = bytes.subarray(start, start + entry.compressed);

  if (raw.length !== entry.compressed) {
    throw new ArchiveError(`plik .docx jest uszkodzony: część ${name} się urywa`);
  }

  const data = unpack(entry, raw);

  if (data.length !== entry.size || crc32(data) !== entry.crc) {
    throw new ArchiveError(
      `plik .docx jest uszkodzony: suma kontrolna części ${name} się nie zgadza`
    );
  }

  return data;
}

function unpack(entry: ZipEntry, raw: Buffer): Buffer {
  if (entry.method === 0) {
    return raw;
  }

  if (entry.method === 8) {
    return inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
  }

  throw new ArchiveError(`${entry.name}: nieobsługiwana metoda kompresji ${entry.method}`);
}
