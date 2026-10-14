import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { parseClass } from "./classfile";

/** A classpath element. Classes are identified by binary name, e.g. `java/util/Map$Entry`. */
export interface ClassSource {
    readonly location: string;
    classNames(): Iterable<string>;
    read(binaryName: string): Buffer | undefined;
    /** `.kotlin_builtins` files (kotlin-stdlib): Kotlin's own declarations of List, String, Int, ... */
    builtins?(): Buffer[];
}

function readAt(file: string, position: number, length: number): Buffer {
    const fd = fs.openSync(file, "r");
    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, position);
        return buffer;
    } finally {
        fs.closeSync(fd);
    }
}

interface ZipEntry { method: number; size: number; offset: number }

export class JarSource implements ClassSource {
    private readonly entries = new Map<string, ZipEntry>();
    private readonly builtinEntries: ZipEntry[] = [];

    constructor(readonly location: string) {
        const size = fs.statSync(location).size;
        const tailLength = Math.min(size, 22 + 0xffff);
        const tail = readAt(location, size - tailLength, tailLength);
        let eocd = tail.length - 22;
        while (eocd >= 0 && tail.readUInt32LE(eocd) !== 0x06054b50) { eocd--; }
        if (eocd < 0) { throw new Error("not a zip file"); }
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        if (cdOffset === 0xffffffff) { throw new Error("ZIP64 archives are not supported"); }
        // Offsets are relative to the start of the zip data, which may follow a prefix (launcher scripts, jmod header).
        const base = size - tailLength + eocd - cdSize - cdOffset;
        const cd = readAt(location, base + cdOffset, cdSize);
        for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
            const nameLength = cd.readUInt16LE(p + 28);
            const name = cd.toString("utf8", p + 46, p + 46 + nameLength);
            const entry = () => ({ method: cd.readUInt16LE(p + 10), size: cd.readUInt32LE(p + 20), offset: base + cd.readUInt32LE(p + 42) });
            if (name.endsWith(".class") && !name.startsWith("META-INF/")) {
                this.entries.set(name.slice(0, -6), entry());
            } else if (name.endsWith(".kotlin_builtins")) {
                this.builtinEntries.push(entry());
            }
            p += 46 + nameLength + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
        }
    }

    classNames(): Iterable<string> { return this.entries.keys(); }

    read(binaryName: string): Buffer | undefined {
        const entry = this.entries.get(binaryName);
        return entry && this.inflate(entry);
    }

    builtins(): Buffer[] {
        return this.builtinEntries.map(e => this.inflate(e)).filter((b): b is Buffer => !!b);
    }

    private inflate(entry: ZipEntry): Buffer | undefined {
        const header = readAt(this.location, entry.offset, 30);
        const data = readAt(this.location, entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), entry.size);
        return entry.method === 8 ? zlib.inflateRawSync(data) : entry.method === 0 ? data : undefined;
    }
}

export class DirSource implements ClassSource {
    private readonly names: string[] = [];

    constructor(readonly location: string) { this.walk(""); }

    private walk(relative: string) {
        for (const e of fs.readdirSync(path.join(this.location, relative), { withFileTypes: true })) {
            const child = relative ? `${relative}/${e.name}` : e.name;
            if (e.isDirectory()) { this.walk(child); }
            else if (e.name.endsWith(".class")) { this.names.push(child.slice(0, -6)); }
        }
    }

    classNames(): Iterable<string> { return this.names; }

    read(binaryName: string): Buffer | undefined {
        try { return fs.readFileSync(path.join(this.location, `${binaryName}.class`)); } catch { return undefined; }
    }
}

const MODULE = 1, PARENT = 2, BASE = 3, EXTENSION = 4, OFFSET = 5, COMPRESSED = 6, UNCOMPRESSED = 7;

interface ImageEntry { offset: number; compressed: number; size: number }

/** The JDK 9+ class image `lib/modules` (jimage). Only packages exported by their module are listed. */
export class JImageSource implements ClassSource {
    private readonly entries = new Map<string, ImageEntry>();
    private readonly littleEndian: boolean;
    private readonly strings: Buffer;
    private readonly contentStart: number;

    constructor(readonly location: string) {
        const header = readAt(location, 0, 28);
        this.littleEndian = header.readUInt32LE(0) === 0xcafedada;
        if (!this.littleEndian && header.readUInt32BE(0) !== 0xcafedada) { throw new Error("not a jimage file"); }
        const tableLength = this.u32(header, 16);
        const locationsSize = this.u32(header, 20);
        const stringsSize = this.u32(header, 24);
        const offsetsStart = 28 + tableLength * 4;
        const locationsStart = offsetsStart + tableLength * 4;
        const offsets = readAt(location, offsetsStart, tableLength * 4);
        const locations = readAt(location, locationsStart, locationsSize);
        this.strings = readAt(location, locationsStart + locationsSize, stringsSize);
        this.contentStart = locationsStart + locationsSize + stringsSize;

        const classes: Array<[module: string, name: string, entry: ImageEntry]> = [];
        for (let i = 0; i < tableLength; i++) {
            const a = decodeLocation(locations, this.u32(offsets, i * 4));
            if (this.string(a[EXTENSION]) !== "class") { continue; }
            const parent = this.string(a[PARENT]);
            const base = this.string(a[BASE]);
            classes.push([this.string(a[MODULE]), parent ? `${parent}/${base}` : base,
                { offset: a[OFFSET], compressed: a[COMPRESSED], size: a[UNCOMPRESSED] }]);
        }
        const exported = new Map<string, Set<string>>();
        for (const [module, name, entry] of classes) {
            if (name !== "module-info") { continue; }
            try {
                const bytes = this.load(entry);
                if (bytes) { exported.set(module, new Set(parseClass(bytes).exports)); }
            } catch { /* module without readable descriptor: hidden */ }
        }
        for (const [module, name, entry] of classes) {
            if (exported.get(module)?.has(name.slice(0, Math.max(0, name.lastIndexOf("/"))))) {
                this.entries.set(name, entry);
            }
        }
    }

    private u32(b: Buffer, offset: number): number {
        return this.littleEndian ? b.readUInt32LE(offset) : b.readUInt32BE(offset);
    }

    private string(offset: number): string {
        return this.strings.toString("utf8", offset, this.strings.indexOf(0, offset));
    }

    classNames(): Iterable<string> { return this.entries.keys(); }

    read(binaryName: string): Buffer | undefined {
        const entry = this.entries.get(binaryName);
        return entry && this.load(entry);
    }

    private load(entry: ImageEntry): Buffer | undefined {
        let data = readAt(this.location, this.contentStart + entry.offset, entry.compressed || entry.size);
        if (!entry.compressed) { return data; }
        // jlink --compress: header(s) of magic, compressed size, uncompressed size, decompressor name, ...
        while (data.length >= 29 && this.u32(data, 0) === 0xcafefafa) {
            const size = Number(this.littleEndian ? data.readBigUInt64LE(4) : data.readBigUInt64BE(4));
            if (this.string(this.u32(data, 20)) !== "zip") { return undefined; }
            data = zlib.inflateSync(data.subarray(29, 29 + size));
        }
        return data;
    }
}

/** Location attributes: a kind/length byte followed by a big-endian value, terminated by kind 0. */
function decodeLocation(b: Buffer, p: number): number[] {
    const attributes = [0, 0, 0, 0, 0, 0, 0, 0];
    while (b[p] >>> 3 !== 0) {
        const kind = b[p] >>> 3;
        const length = (b[p++] & 7) + 1;
        let value = 0;
        for (let i = 0; i < length; i++) { value = value * 256 + b[p++]; }
        attributes[kind] = value;
    }
    return attributes;
}
