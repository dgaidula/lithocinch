// Show control and invisible characters in a name or path as escapes, for
// anything printed for a person (`lithocinch density`, the main command's
// per-file lines and messages). --json output keeps the real text.

/**
 * One item is always one line, and two names that differ only by an invisible
 * character (a zero-width space, a joiner, a directional mark) do not look
 * alike. The invisible ones are the Unicode format characters (Cf). A backslash
 * is not escaped (README, Not covered).
 */
const isControl = (n) =>
  (n < 32 && n !== 9) || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || /^\p{Cf}$/u.test(String.fromCodePoint(n));
const hex = (n, width) => n.toString(16).padStart(width, '0');

/** The text as an array with one entry per character: the character, or its escape. */
export const escChars = (s) =>
  [...String(s)].map((c) => {
    const n = c.codePointAt(0);
    if (!isControl(n)) return c;
    return n < 256 ? `\\x${hex(n, 2)}` : n < 0x10000 ? `\\u${hex(n, 4)}` : `\\u{${n.toString(16)}}`;
  });

export const esc = (s) => escChars(s).join('');
