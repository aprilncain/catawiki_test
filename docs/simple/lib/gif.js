/* Minimal GIF89a encoder (no deps).
   - Fixed 256-color palette using 3-3-2 uniform quantization.
   - Global color table, per-frame LZW compression.
   - Optimized for simple marketing animations (3–5 frames).

   Exposes: window.CWGIF.encodeGIF({ width, height, frames: [{rgba, delayCs}], loop })
   where rgba is Uint8ClampedArray (length width*height*4), delayCs is centiseconds.
*/
(function () {
  "use strict";

  function clamp8(n) {
    return n < 0 ? 0 : n > 255 ? 255 : n | 0;
  }

  function build332Palette() {
    const pal = new Uint8Array(256 * 3);
    let p = 0;
    for (let r = 0; r < 8; r++) {
      for (let g = 0; g < 8; g++) {
        for (let b = 0; b < 4; b++) {
          pal[p++] = Math.round((r * 255) / 7);
          pal[p++] = Math.round((g * 255) / 7);
          pal[p++] = Math.round((b * 255) / 3);
        }
      }
    }
    return pal;
  }

  function rgbaToIndex332(rgba, transparentIndex) {
    const n = (rgba.length / 4) | 0;
    const out = new Uint8Array(n);
    for (let i = 0, px = 0; px < n; px++, i += 4) {
      const a = rgba[i + 3];
      if (a < 16) {
        out[px] = transparentIndex;
        continue;
      }
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const ri = (r * 7 + 127) / 255 | 0;
      const gi = (g * 7 + 127) / 255 | 0;
      const bi = (b * 3 + 127) / 255 | 0;
      out[px] = ((ri << 5) | (gi << 2) | bi) & 255;
    }
    return out;
  }

  function ByteSink(initialSize) {
    this.buf = new Uint8Array(initialSize || 1024);
    this.len = 0;
  }
  ByteSink.prototype.ensure = function (need) {
    const want = this.len + need;
    if (want <= this.buf.length) return;
    let next = this.buf.length;
    while (next < want) next = (next * 1.7 + 1024) | 0;
    const nb = new Uint8Array(next);
    nb.set(this.buf);
    this.buf = nb;
  };
  ByteSink.prototype.u8 = function (v) {
    this.ensure(1);
    this.buf[this.len++] = v & 255;
  };
  ByteSink.prototype.u16le = function (v) {
    this.ensure(2);
    this.buf[this.len++] = v & 255;
    this.buf[this.len++] = (v >> 8) & 255;
  };
  ByteSink.prototype.bytes = function (arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  };
  ByteSink.prototype.sub = function () {
    return this.buf.slice(0, this.len);
  };

  // GIF sub-block writer for image data
  function writeSubBlocks(sink, data) {
    let i = 0;
    while (i < data.length) {
      const size = Math.min(255, data.length - i);
      sink.u8(size);
      sink.bytes(data.subarray(i, i + size));
      i += size;
    }
    sink.u8(0); // terminator
  }

  // LZW compression for GIF (indexed pixels)
  function lzwCompress(minCodeSize, indices) {
    const CLEAR = 1 << minCodeSize;
    const EOI = CLEAR + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = EOI + 1;
    const dict = new Map();

    function resetDict() {
      dict.clear();
      codeSize = minCodeSize + 1;
      nextCode = EOI + 1;
    }

    // Bit packing (LSB-first)
    const out = new ByteSink((indices.length / 2) | 0);
    let cur = 0;
    let curBits = 0;
    function emit(code) {
      cur |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) {
        out.u8(cur & 255);
        cur >>= 8;
        curBits -= 8;
      }
    }

    resetDict();
    emit(CLEAR);

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      // Prefix is a GIF code (up to 12 bits); string key avoids any numeric packing edge cases.
      const key = String(prefix) + "," + String(k);
      const existing = dict.get(key);
      if (existing !== undefined) {
        prefix = existing;
      } else {
        emit(prefix);
        dict.set(key, nextCode++);
        prefix = k;

        if (nextCode === (1 << codeSize) && codeSize < 12) {
          codeSize++;
        } else if (nextCode >= 4096) {
          emit(CLEAR);
          resetDict();
          prefix = k;
        }
      }
    }

    emit(prefix);
    emit(EOI);

    if (curBits > 0) out.u8(cur & 255);
    return out.sub();
  }

  function encodeGIF(opts) {
    const width = opts.width | 0;
    const height = opts.height | 0;
    const frames = opts.frames || [];
    const loop = opts.loop === undefined ? 0 : opts.loop | 0; // 0 = infinite
    if (!width || !height) throw new Error("encodeGIF: width/height required");
    if (!frames.length) throw new Error("encodeGIF: at least 1 frame required");

    const sink = new ByteSink(1024 * 1024);
    const palette = build332Palette();
    const transparentIndex = 0; // OK because palette[0] = (0,0,0); treat alpha<16 as transparent

    // Header
    sink.bytes(new TextEncoder().encode("GIF89a"));

    // Logical Screen Descriptor
    sink.u16le(width);
    sink.u16le(height);
    const gctFlag = 1 << 7;
    const colorRes = 7 << 4; // 8 bits/channel (nominal)
    const sortFlag = 0 << 3;
    const gctSize = 7; // 2^(7+1)=256
    sink.u8(gctFlag | colorRes | sortFlag | gctSize);
    sink.u8(transparentIndex); // background color index
    sink.u8(0); // pixel aspect ratio

    // Global Color Table
    sink.bytes(palette);

    // Netscape loop extension
    sink.u8(0x21);
    sink.u8(0xff);
    sink.u8(11);
    sink.bytes(new TextEncoder().encode("NETSCAPE2.0"));
    sink.u8(3);
    sink.u8(1);
    sink.u16le(loop);
    sink.u8(0);

    for (const frame of frames) {
      const rgba = frame.rgba;
      const delayCs = frame.delayCs | 0;
      if (!rgba || rgba.length !== width * height * 4) {
        throw new Error("encodeGIF: frame rgba has wrong length");
      }

      // Graphics Control Extension
      sink.u8(0x21);
      sink.u8(0xf9);
      sink.u8(4);
      // Full-canvas frames: disposal 1 avoids “strip” artifacts in some decoders vs restore-to-bg.
      const disposal = 1;
      const transpFlag = 1;
      sink.u8((disposal << 2) | transpFlag);
      sink.u16le(delayCs);
      sink.u8(transparentIndex);
      sink.u8(0);

      // Image Descriptor
      sink.u8(0x2c);
      sink.u16le(0); // left
      sink.u16le(0); // top
      sink.u16le(width);
      sink.u16le(height);
      sink.u8(0x00); // no local table

      // Image Data
      const minCodeSize = 8;
      sink.u8(minCodeSize);
      const indices = rgbaToIndex332(rgba, transparentIndex);
      const lzw = lzwCompress(minCodeSize, indices);
      writeSubBlocks(sink, lzw);
    }

    sink.u8(0x3b); // trailer
    return sink.sub();
  }

  window.CWGIF = { encodeGIF, clamp8 };
})();
