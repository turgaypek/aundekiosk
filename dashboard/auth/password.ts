import { argon2id, argon2Verify } from "npm:hash-wasm@4.11.0";

// Argon2id parameters per OWASP's baseline recommendation for interactive
// logins (m=19MiB, t=2, p=1) — chosen to stay fast enough on a Raspberry
// Pi's CPU while still meeting the memory-hardness argon2id is for.
const MEMORY_SIZE_KIB = 19456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return await argon2id({
    password,
    salt,
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_SIZE_KIB,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  return await argon2Verify({ password, hash: encodedHash });
}
