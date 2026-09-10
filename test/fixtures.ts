const enc = new TextEncoder();

function withHeader(header: number[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(header, 0);
  for (let i = header.length; i < size; i++) out[i] = (i * 31) & 0xff;
  return out;
}

export const fixtures = {
  json: enc.encode(JSON.stringify({ hello: "world", n: [1, 2, 3], nested: { a: null, b: true } })),
  html: enc.encode("<!doctype html><html><head><title>t</title></head><body><h1>Report</h1></body></html>"),
  htmlFragment: enc.encode("<div class=\"x\"><p>hello</p></div>"),
  svg: enc.encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'),
  svgSelfClosing: enc.encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
  txt: enc.encode("just some text\nwith lines\n"),
  md: enc.encode("# Title\n\nSome *markdown*.\n"),
  csv: enc.encode("a,b,c\n1,2,3\n"),
  pdf: withHeader(Array.from(enc.encode("%PDF-1.4\n")), 512),
  png: withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 256),
  jpg: withHeader([0xff, 0xd8, 0xff, 0xe0], 256),
  webp: (() => {
    const b = withHeader(Array.from(enc.encode("RIFF")), 256);
    b.set(enc.encode("WEBP"), 8);
    return b;
  })(),
  gif: withHeader(Array.from(enc.encode("GIF89a")), 256),
  zip: withHeader([0x50, 0x4b, 0x03, 0x04], 256),
  exe: withHeader(Array.from(enc.encode("MZ")), 256),
  sh: enc.encode("#!/bin/sh\necho hi\n"),
  invalidJson: enc.encode('{"a": 1,}'),
  invalidUtf8: new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0xc0]),
  svgNoRoot: enc.encode('<?xml version="1.0"?><root><svg/></root>'),
  scriptHtml: enc.encode("<html><body><script>document.title=document.cookie+localStorage.length</script></body></html>"),
  scriptSvg: enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
};

/** A PNG-looking buffer of exactly `size` bytes. */
export function pngOfSize(size: number): Uint8Array {
  return withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size);
}

/** Valid JSON of roughly `size` bytes: an array of numbers. */
export function jsonOfSize(size: number): Uint8Array {
  const parts: string[] = [];
  let len = 1;
  while (len < size - 2) {
    const s = `${len % 1000000},`;
    parts.push(s);
    len += s.length;
  }
  const text = "[" + parts.join("").replace(/,$/, "") + "]";
  return enc.encode(text);
}
