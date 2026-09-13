/** Deterministic non-cryptographic fallback identity; never used as a security primitive. */
export function hash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    a = Math.imul(a ^ value.charCodeAt(index), 0x01000193);
    b = Math.imul(b ^ value.charCodeAt(index), 0x85ebca6b);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
