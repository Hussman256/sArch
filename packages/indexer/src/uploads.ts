/**
 * Storage for what a creator uploads at launch: the coin's image, and a small
 * metadata document with the full description and links.
 *
 * Both are stored under the hash of their contents. The image's address goes
 * on chain as the coin's image link; the document's hash goes on chain as the
 * coin's metadata hash. So neither can be swapped after launch without the
 * mismatch being detectable, and this module checks it on every read.
 *
 * Files live on local disk here. In production put a bucket or a CDN behind
 * the same interface.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@archpad/sdk";

export const MAX_IMAGE_BYTES = 1_000_000;
export const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_LINK_CHARS = 200;

const IMAGE_TYPES = [
  { extension: "png", contentType: "image/png", matches: (b: Uint8Array) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { extension: "jpg", contentType: "image/jpeg", matches: (b: Uint8Array) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { extension: "gif", contentType: "image/gif", matches: (b: Uint8Array) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a" },
  { extension: "webp", contentType: "image/webp", matches: (b: Uint8Array) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
] as const;

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** A problem with what the client sent, safe to show them. */
export class UploadError extends Error {
  override readonly name = "UploadError";
}

/** Links a creator can attach to a coin. Each must be an https URL. */
export interface CoinLinks {
  website?: string;
  x?: string;
  telegram?: string;
}

/** The off-chain half of a coin's metadata. Its SHA-256 is what the chain records. */
export interface CoinDocument {
  name: string;
  symbol: string;
  description: string;
  image: string;
  links: CoinLinks;
}

export interface StoredImage {
  /** File name the image is served under. */
  name: string;
  contentType: string;
}

const IMAGE_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
const DOCUMENT_HASH = /^[0-9a-f]{64}$/;

function checkedLink(label: string, value: unknown, hosts?: string[]): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_LINK_CHARS) throw new UploadError(`the ${label} link is too long`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UploadError(`the ${label} link is not a valid address`);
  }
  // Only https: a "javascript:" or "data:" link would run in the visitor's browser.
  if (url.protocol !== "https:") throw new UploadError(`the ${label} link must start with https://`);
  if (hosts && !hosts.includes(url.hostname.replace(/^www\./, ""))) {
    throw new UploadError(`the ${label} link must be on ${hosts.join(" or ")}`);
  }
  return url.toString();
}

function checkedText(label: string, value: unknown, max: number, required: boolean): string {
  if (typeof value !== "string") throw new UploadError(`${label} must be text`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new UploadError(`${label} is required`);
  if (trimmed.length > max) throw new UploadError(`${label} is longer than ${max} characters`);
  return trimmed;
}

/**
 * Validates a document and puts it in its one canonical form, so the same
 * content always hashes the same.
 */
export function canonicalDocument(input: unknown): CoinDocument {
  if (typeof input !== "object" || input === null) throw new UploadError("expected a JSON object");
  const raw = input as Record<string, unknown>;
  const links = (typeof raw["links"] === "object" && raw["links"] !== null ? raw["links"] : {}) as Record<string, unknown>;
  const website = checkedLink("website", links["website"]);
  const x = checkedLink("X", links["x"], ["x.com", "twitter.com"]);
  const telegram = checkedLink("Telegram", links["telegram"], ["t.me", "telegram.me"]);
  return {
    name: checkedText("name", raw["name"], 64, true),
    symbol: checkedText("ticker", raw["symbol"], 16, true),
    description: checkedText("description", raw["description"] ?? "", MAX_DESCRIPTION_CHARS, false),
    image: checkedText("image", raw["image"] ?? "", 256, false),
    links: {
      ...(website ? { website } : {}),
      ...(x ? { x } : {}),
      ...(telegram ? { telegram } : {}),
    },
  };
}

/** The exact bytes a document is stored and hashed as. */
export function documentBytes(document: CoinDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

export const documentHash = (document: CoinDocument): string => bytesToHex(sha256(documentBytes(document)));

export class UploadStore {
  private readonly files: string;
  private readonly documents: string;

  constructor(directory: string) {
    this.files = join(directory, "files");
    this.documents = join(directory, "documents");
  }

  /** Stores an image after checking it really is one. Returns the name it is served under. */
  async saveImage(bytes: Uint8Array): Promise<StoredImage> {
    if (bytes.length === 0) throw new UploadError("the image is empty");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new UploadError(`the image is larger than ${MAX_IMAGE_BYTES / 1_000_000} MB`);
    }
    // The type comes from the bytes, never from what the client claims. That
    // rules out SVG and HTML, which can carry scripts.
    const type = IMAGE_TYPES.find((candidate) => candidate.matches(bytes));
    if (!type) throw new UploadError("the image must be a PNG, JPEG, GIF or WebP file");

    const name = `${bytesToHex(sha256(bytes)).slice(0, 32)}.${type.extension}`;
    await mkdir(this.files, { recursive: true });
    await writeFile(join(this.files, name), bytes);
    return { name, contentType: type.contentType };
  }

  /** An uploaded image, or null if there is none by that name. */
  async readImage(name: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (!IMAGE_NAME.test(name)) return null;
    const extension = name.slice(name.lastIndexOf(".") + 1);
    const type = IMAGE_TYPES.find((candidate) => candidate.extension === extension)!;
    try {
      return { bytes: await readFile(join(this.files, name)), contentType: type.contentType };
    } catch {
      return null;
    }
  }

  /** Stores a coin's metadata document. Returns its hash, which the launch records on chain. */
  async saveDocument(input: unknown): Promise<{ hash: string; document: CoinDocument }> {
    const document = canonicalDocument(input);
    const bytes = documentBytes(document);
    const hash = bytesToHex(sha256(bytes));
    await mkdir(this.documents, { recursive: true });
    await writeFile(join(this.documents, `${hash}.json`), bytes);
    return { hash, document };
  }

  /**
   * The document with the given hash, or null. The stored bytes are hashed
   * again on the way out, so a file altered on disk is treated as missing
   * rather than served as if the chain vouched for it.
   */
  async readDocument(hash: string): Promise<CoinDocument | null> {
    if (!DOCUMENT_HASH.test(hash)) return null;
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(this.documents, `${hash}.json`));
    } catch {
      return null;
    }
    if (bytesToHex(sha256(bytes)) !== hash) return null;
    try {
      return canonicalDocument(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return null;
    }
  }
}
