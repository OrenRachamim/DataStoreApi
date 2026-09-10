import { describe, it, expect } from "vitest";
import { detectContent, validateJson, UnsupportedContent } from "../src/content";
import { fixtures, jsonOfSize } from "./fixtures";

const enc = new TextEncoder();

describe("validateJson (unit)", () => {
  const good = [
    "{}",
    "[]",
    '{"a":1}',
    "[1,2,3]",
    '{"a":{"b":[1,{"c":null}]},"d":"x\\"y\\u00e9"}',
    ' \n{"a" : [ ] }\n',
    "-1.5e10",
    '"str"',
    "true",
    "null",
    '{"a":[[[]]],"b":{}}',
  ];
  const bad = [
    "",
    "{",
    '{"a":1,}',
    "[1,]",
    '{"a":}',
    "{a:1}",
    "{'a':1}",
    "[1 2]",
    '{"a":1}x',
    "01",
    "1.",
    '"\\q"',
    '"',
    '{"a":1}{"b":2}',
    "[",
    "]",
    '{"a"}',
    '{"a":1 "b":2}',
  ];
  for (const s of good) it(`accepts ${JSON.stringify(s)}`, () => expect(validateJson(enc.encode(s))).toBe(true));
  for (const s of bad) it(`rejects ${JSON.stringify(s)}`, () => expect(validateJson(enc.encode(s))).toBe(false));
  it("agrees with JSON.parse on a 2 MB array", () => {
    const big = jsonOfSize(2 * 1024 * 1024);
    expect(validateJson(big)).toBe(true);
    JSON.parse(new TextDecoder().decode(big));
  });
});

describe("detectContent (unit)", () => {
  it("detects binary formats by magic bytes", () => {
    expect(detectContent(fixtures.png).contentType).toBe("image/png");
    expect(detectContent(fixtures.jpg).contentType).toBe("image/jpeg");
    expect(detectContent(fixtures.gif).contentType).toBe("image/gif");
    expect(detectContent(fixtures.webp).contentType).toBe("image/webp");
    expect(detectContent(fixtures.pdf).contentType).toBe("application/pdf");
  });
  it("detects text formats by content", () => {
    expect(detectContent(fixtures.json)).toEqual({ contentType: "application/json", kind: "json" });
    expect(detectContent(fixtures.html)).toEqual({ contentType: "text/html", kind: "html" });
    expect(detectContent(fixtures.htmlFragment).contentType).toBe("text/html");
    expect(detectContent(fixtures.svg)).toEqual({ contentType: "image/svg+xml", kind: "svg" });
    expect(detectContent(fixtures.svgSelfClosing).contentType).toBe("image/svg+xml");
    expect(detectContent(fixtures.txt).contentType).toBe("text/plain");
    expect(detectContent(fixtures.md, "text/markdown").contentType).toBe("text/markdown");
    expect(detectContent(fixtures.csv, "text/csv").contentType).toBe("text/csv");
    expect(detectContent(fixtures.md).contentType).toBe("text/plain");
  });
  it("content beats the declared type", () => {
    expect(detectContent(fixtures.html, "image/png").contentType).toBe("text/html");
    expect(detectContent(fixtures.png, "application/json").contentType).toBe("image/png");
    expect(detectContent(fixtures.svg, "application/json").contentType).toBe("image/svg+xml");
  });
  it("rejects forbidden and broken content", () => {
    for (const b of [fixtures.zip, fixtures.exe, fixtures.sh, fixtures.invalidUtf8, new Uint8Array(0)]) {
      expect(() => detectContent(b)).toThrow(UnsupportedContent);
    }
    expect(() => detectContent(fixtures.svgNoRoot, "image/svg+xml")).toThrow(UnsupportedContent);
    expect(detectContent(fixtures.svgNoRoot).contentType).toBe("text/plain");
    expect(() => detectContent(fixtures.invalidJson, "application/json")).toThrow(UnsupportedContent);
    expect(() => detectContent(fixtures.txt, "application/json")).toThrow(UnsupportedContent);
    expect(() => detectContent(enc.encode("<svg>unclosed"))).toThrow(UnsupportedContent);
  });
});
