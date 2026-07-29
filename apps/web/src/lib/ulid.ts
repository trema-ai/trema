/**
 * Mints a ULID: 10 chars of millisecond time plus 16 chars of randomness in
 * Crockford base32, lexically sortable by creation time. The web adapter owns
 * its thread refs (web 06), and a new chat needs one before anything durable
 * exists — a local mint keeps that a pure view-state act. Hand-rolled because
 * this is the repo's only ULID use; monotonic ordering within a millisecond
 * is not needed for a ref minted once per chat.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(time = Date.now()): string {
  const chars = new Array<string>(26);
  let remaining = time;
  for (let index = 9; index >= 0; index -= 1) {
    chars[index] = ENCODING.charAt(remaining % 32);
    remaining = Math.floor(remaining / 32);
  }
  // A byte mod 32 is uniform: 256 is a multiple of 32.
  const random = crypto.getRandomValues(new Uint8Array(16));
  for (let index = 0; index < 16; index += 1) {
    chars[10 + index] = ENCODING.charAt((random[index] ?? 0) % 32);
  }
  return chars.join("");
}
