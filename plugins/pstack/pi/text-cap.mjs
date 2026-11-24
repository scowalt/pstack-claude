// Plain JavaScript, so the bb batch tracker, which node runs on its own, can import it.
export const OUTPUT_CAP_BYTES = 50 * 1024;

export function truncateUtf8(text, cap) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}
