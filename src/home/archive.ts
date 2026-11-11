import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { AppError } from "../util/errors.js";

/**
 * The encrypted container a home bundle travels in.
 *
 * Plain layout, then gzip: a 4-byte header length, the JSON header (format,
 * version, file list with sizes and SHA-256 digests, a summary), then each
 * file's bytes in header order. The gzip is sealed with AES-256-GCM under a
 * key derived from a passphrase with scrypt, so a bundle is unreadable without
 * the passphrase and any change to it is refused rather than half-imported.
 */

const MAGIC = Buffer.from("AAHB", "ascii");
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES + TAG_BYTES;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
/** A bundle holds a slim database and documents; a gzip that inflates past this is refused. */
const MAX_PLAIN_BYTES = 1024 ** 3;
export const MIN_PASSPHRASE_LENGTH = 20;

export type BundleFile = { path: string; bytes: Buffer };

const FileEntrySchema = z.object({ path: z.string().min(1), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });

const HeaderSchema = z.object({
  format: z.literal("autoapply-home"),
  version: z.literal(1),
  createdAt: z.string(),
  summary: z.record(z.string(), z.unknown()),
  files: z.array(FileEntrySchema),
});

export type BundleHeader = z.infer<typeof HeaderSchema>;

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Refuses a bundle entry that could land outside the home it is imported
 * into: absolute paths, drive letters, backslashes, "." and ".." segments and
 * control characters. Entries are always relative, with forward slashes.
 */
export function assertSafeEntryPath(path: string): void {
  const segments = path.split("/");
  const unsafe =
    path.length === 0 ||
    path.startsWith("/") ||
    /[\\:\u0000-\u001f]/.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");
  if (unsafe) throw new AppError("bundle_invalid", `bundle entry "${path}" is not a safe relative path`);
}

export function assertPassphrase(passphrase: string | undefined): asserts passphrase is string {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new AppError("bundle_passphrase_weak", `the bundle passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

export function packFiles(meta: Omit<BundleHeader, "files">, files: readonly BundleFile[]): Buffer {
  for (const file of files) assertSafeEntryPath(file.path);
  const header: BundleHeader = { ...meta, files: files.map((file) => ({ path: file.path, size: file.bytes.length, sha256: digest(file.bytes) })) };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return gzipSync(Buffer.concat([length, headerBytes, ...files.map((file) => file.bytes)]), { level: 9 });
}

export function unpackFiles(packed: Buffer): { header: BundleHeader; files: BundleFile[] } {
  let raw: Buffer;
  try {
    raw = gunzipSync(packed, { maxOutputLength: MAX_PLAIN_BYTES });
  } catch {
    throw new AppError("bundle_invalid", "the bundle's contents are not readable");
  }
  if (raw.length < 4) throw new AppError("bundle_invalid", "the bundle is empty");
  const headerLength = raw.readUInt32BE(0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.subarray(4, 4 + headerLength).toString("utf8"));
  } catch {
    throw new AppError("bundle_invalid", "the bundle header is not readable");
  }
  const header = HeaderSchema.safeParse(parsed);
  if (!header.success) throw new AppError("bundle_invalid", `the bundle header is not valid: ${header.error.issues[0]?.message ?? "unknown"}`);

  let offset = 4 + headerLength;
  const files = header.data.files.map((entry) => {
    assertSafeEntryPath(entry.path);
    const bytes = Buffer.from(raw.subarray(offset, offset + entry.size));
    offset += entry.size;
    if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) {
      throw new AppError("bundle_invalid", `bundle entry "${entry.path}" does not match its recorded size and digest`);
    }
    return { path: entry.path, bytes };
  });
  if (offset !== raw.length) throw new AppError("bundle_invalid", "the bundle holds bytes its header does not account for");
  return { header: header.data, files };
}

function keyFor(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

export function encryptBundle(plain: Buffer, passphrase: string): Buffer {
  assertPassphrase(passphrase);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const version = Buffer.from([VERSION]);
  const cipher = createCipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  cipher.setAAD(Buffer.concat([MAGIC, version]));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, version, salt, iv, cipher.getAuthTag(), body]);
}

export function decryptBundle(data: Buffer, passphrase: string): Buffer {
  assertPassphrase(passphrase);
  if (data.length <= PREFIX_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new AppError("bundle_invalid", "this file is not an autoapply home bundle");
  }
  if (data[MAGIC.length] !== VERSION) throw new AppError("bundle_invalid", `unsupported bundle version ${data[MAGIC.length]}`);
  let offset = MAGIC.length + 1;
  const salt = data.subarray(offset, (offset += SALT_BYTES));
  const iv = data.subarray(offset, (offset += IV_BYTES));
  const tag = data.subarray(offset, (offset += TAG_BYTES));
  const decipher = createDecipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  decipher.setAAD(data.subarray(0, MAGIC.length + 1));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()]);
  } catch {
    throw new AppError("bundle_decrypt_failed", "the passphrase is wrong, or the bundle was changed after it was made");
  }
}
