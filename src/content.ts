/**
 * Content type detection by content, not by what the client declared, and
 * validation of text formats. See DESIGN.md section 7.
 */

export type ContentKind = "json" | "html" | "svg" | "text" | "binary";

export interface DetectedContent {
  contentType: string;
  kind: ContentKind;
}

export const ALLOWED_TYPES = [
  "application/json",
  "text/html",
  "image/svg+xml",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export class UnsupportedContent extends Error {
  constructor(message: string) {
    super(message);
  }
}

const TEXT_SUBTYPES: Record<string, string> = {
  "text/plain": "text/plain",
  "text/markdown": "text/markdown",
  "text/x-markdown": "text/markdown",
  "text/csv": "text/csv",
};

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(s: string): number[] {
  return Array.from(s, (ch) => ch.charCodeAt(0));
}

const FORBIDDEN_MAGIC: Array<{ name: string; sig: number[]; offset?: number }> = [
  { name: "zip", sig: ascii("PK\x03\x04") },
  { name: "zip", sig: ascii("PK\x05\x06") },
  { name: "elf", sig: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "exe", sig: ascii("MZ") },
  { name: "mach-o", sig: [0xca, 0xfe, 0xba, 0xbe] },
  { name: "mach-o", sig: [0xfe, 0xed, 0xfa, 0xce] },
  { name: "mach-o", sig: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "mach-o", sig: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "gzip", sig: [0x1f, 0x8b] },
  { name: "7z", sig: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: "rar", sig: ascii("Rar!") },
  { name: "script", sig: ascii("#!") },
];

export function normalizeDeclaredType(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  return header.split(";")[0].trim().toLowerCase() || undefined;
}

/**
 * Decide the stored content type. Binary magic wins. Text is validated as
 * UTF-8 and then classified: JSON, SVG and HTML by content; plain text
 * subtypes by the declared type when it is allowed.
 */
export function detectContent(bytes: Uint8Array, declared?: string): DetectedContent {
  if (bytes.length === 0) throw new UnsupportedContent("Empty body.");

  for (const f of FORBIDDEN_MAGIC) {
    if (startsWith(bytes, f.sig, f.offset ?? 0)) {
      throw new UnsupportedContent(`Content looks like a ${f.name} file, which is not allowed.`);
    }
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", kind: "binary" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", kind: "binary" };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return { contentType: "image/gif", kind: "binary" };
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return { contentType: "image/webp", kind: "binary" };
  if (startsWith(bytes, ascii("%PDF-"))) return { contentType: "application/pdf", kind: "binary" };

  // Everything else must be valid UTF-8 text.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UnsupportedContent("Content is neither an allowed binary format nor valid UTF-8 text.");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const trimmed = text.trimStart();
  const first = trimmed[0];

  if (first === "<") {
    const root = xmlRootElement(trimmed);
    if (root === "svg") {
      if (!looksLikeCompleteSvg(trimmed)) throw new UnsupportedContent("SVG is not well-formed: missing closing </svg>.");
      return { contentType: "image/svg+xml", kind: "svg" };
    }
    if (root === "html" || /^<!doctype\s+html/i.test(trimmed) || looksLikeHtml(trimmed)) {
      return { contentType: "text/html", kind: "html" };
    }
    if (root !== undefined && declared === "image/svg+xml") {
      throw new UnsupportedContent("SVG must have <svg> as its root element.");
    }
  }

  if (first === "{" || first === "[") {
    if (validateJson(bytes)) return { contentType: "application/json", kind: "json" };
    if (declared === "application/json") throw new UnsupportedContent("Body is not valid JSON.");
  } else if (declared === "application/json") {
    throw new UnsupportedContent("Body is not valid JSON.");
  }

  if (declared === "text/html" || looksLikeHtml(trimmed)) return { contentType: "text/html", kind: "html" };
  if (declared === "image/svg+xml") throw new UnsupportedContent("SVG must have <svg> as its root element.");

  const sub = declared ? TEXT_SUBTYPES[declared] : undefined;
  return { contentType: sub ?? "text/plain", kind: "text" };
}

/** Name of the root element after any BOM, XML declaration, comments and doctype. */
function xmlRootElement(s: string): string | undefined {
  let i = 0;
  const n = Math.min(s.length, 4096);
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (s[i] !== "<") return undefined;
    if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i);
      if (end < 0) return undefined;
      i = end + 2;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i);
      if (end < 0) return undefined;
      i = end + 3;
      continue;
    }
    if (s.startsWith("<!", i)) {
      const end = s.indexOf(">", i);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    const m = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(s.slice(i, i + 64));
    return m ? m[1].toLowerCase().replace(/^.*:/, "") : undefined;
  }
  return undefined;
}

function looksLikeCompleteSvg(s: string): boolean {
  const tail = s.trimEnd();
  if (tail.endsWith("</svg>")) return true;
  // Self-closing root with no children: <svg .../>
  const open = tail.indexOf("<svg");
  const close = tail.indexOf(">", open);
  return open >= 0 && close === tail.length - 1 && tail[close - 1] === "/";
}

function looksLikeHtml(s: string): boolean {
  return /<(?:!doctype\s+html|html|head|body|script|div|p|span|h[1-6]|table|a|img|ul|ol|li|form|iframe|style|meta|link|title)\b[^>]*>/i.test(
    s.slice(0, 2048),
  );
}

// ---------------------------------------------------------------------------
// Streaming JSON syntax validator. Walks the bytes once, keeps only a stack of
// container types, and never builds the value. Works on the raw UTF-8 bytes.
// ---------------------------------------------------------------------------

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function validateJson(bytes: Uint8Array): boolean {
  let i = 0;
  const n = bytes.length;
  const stack: number[] = []; // 0x7b '{' or 0x5b '['

  const skipWs = () => {
    while (i < n && WS.has(bytes[i])) i++;
  };

  const parseString = (): boolean => {
    // assumes bytes[i] === '"'
    i++;
    while (i < n) {
      const c = bytes[i];
      if (c === 0x22) {
        i++;
        return true;
      }
      if (c === 0x5c) {
        i++;
        if (i >= n) return false;
        const e = bytes[i];
        if (e === 0x75) {
          for (let k = 1; k <= 4; k++) {
            const h = bytes[i + k];
            if (!((h >= 0x30 && h <= 0x39) || (h >= 0x41 && h <= 0x46) || (h >= 0x61 && h <= 0x66))) return false;
          }
          i += 5;
          continue;
        }
        if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(e)) return false;
        i++;
        continue;
      }
      if (c < 0x20) return false;
      i++;
    }
    return false;
  };

  const parseNumber = (): boolean => {
    const start = i;
    if (bytes[i] === 0x2d) i++;
    if (bytes[i] === 0x30) {
      i++;
    } else if (bytes[i] >= 0x31 && bytes[i] <= 0x39) {
      while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    } else {
      return false;
    }
    if (bytes[i] === 0x2e) {
      i++;
      if (!(bytes[i] >= 0x30 && bytes[i] <= 0x39)) return false;
      while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    }
    if (bytes[i] === 0x65 || bytes[i] === 0x45) {
      i++;
      if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++;
      if (!(bytes[i] >= 0x30 && bytes[i] <= 0x39)) return false;
      while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++;
    }
    return i > start;
  };

  const parseLiteral = (lit: string): boolean => {
    for (let k = 0; k < lit.length; k++) if (bytes[i + k] !== lit.charCodeAt(k)) return false;
    i += lit.length;
    return true;
  };

  // Parses one value starting at i (after whitespace). Containers push to the stack.
  const parseValueStart = (): boolean => {
    const c = bytes[i];
    if (c === 0x7b || c === 0x5b) {
      stack.push(c);
      i++;
      return true;
    }
    if (c === 0x22) return parseString();
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return parseNumber();
    if (c === 0x74) return parseLiteral("true");
    if (c === 0x66) return parseLiteral("false");
    if (c === 0x6e) return parseLiteral("null");
    return false;
  };

  skipWs();
  if (i >= n) return false;
  if (!parseValueStart()) return false;

  // State machine for containers.
  // For each open container we need to know whether we expect a value, a key, a comma or close.
  // We track it with an explicit "expect" per level in a parallel array.
  const expect: number[] = []; // 0 = value-or-close (fresh), 1 = comma-or-close, 2 = value (after comma), 3 = key-or-close, 4 = key (after comma), 5 = colon
  if (stack.length) expect.push(stack[0] === 0x7b ? 3 : 0);

  while (stack.length) {
    skipWs();
    if (i >= n) return false;
    const top = stack[stack.length - 1];
    const st = expect[expect.length - 1];
    const c = bytes[i];

    if (top === 0x5b) {
      if (st === 0 && c === 0x5d) {
        i++;
        stack.pop();
        expect.pop();
        if (expect.length) expect[expect.length - 1] = 1;
        continue;
      }
      if (st === 0 || st === 2) {
        if (!parseValueStart()) return false;
        if (stack[stack.length - 1] !== top || stack.length !== expect.length) {
          // a container was pushed
          expect[expect.length - 1] = 1;
          expect.push(stack[stack.length - 1] === 0x7b ? 3 : 0);
        } else {
          expect[expect.length - 1] = 1;
        }
        continue;
      }
      if (st === 1) {
        if (c === 0x2c) {
          i++;
          expect[expect.length - 1] = 2;
          continue;
        }
        if (c === 0x5d) {
          i++;
          stack.pop();
          expect.pop();
          if (expect.length) expect[expect.length - 1] = 1;
          continue;
        }
        return false;
      }
      return false;
    }

    // object
    if (st === 3 && c === 0x7d) {
      i++;
      stack.pop();
      expect.pop();
      if (expect.length) expect[expect.length - 1] = 1;
      continue;
    }
    if (st === 3 || st === 4) {
      if (c !== 0x22 || !parseString()) return false;
      expect[expect.length - 1] = 5;
      continue;
    }
    if (st === 5) {
      if (c !== 0x3a) return false;
      i++;
      skipWs();
      if (i >= n) return false;
      const depth = stack.length;
      if (!parseValueStart()) return false;
      if (stack.length > depth) {
        expect[expect.length - 1] = 1;
        expect.push(stack[stack.length - 1] === 0x7b ? 3 : 0);
      } else {
        expect[expect.length - 1] = 1;
      }
      continue;
    }
    if (st === 1) {
      if (c === 0x2c) {
        i++;
        expect[expect.length - 1] = 4;
        continue;
      }
      if (c === 0x7d) {
        i++;
        stack.pop();
        expect.pop();
        if (expect.length) expect[expect.length - 1] = 1;
        continue;
      }
      return false;
    }
    return false;
  }

  skipWs();
  return i === n;
}
