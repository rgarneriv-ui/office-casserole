"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // engines/presentation-model/src/model.ts
  var DECK_SCHEMA_VERSION = "1.0";
  var CANVAS_W = 1600;
  var CANVAS_H = 900;
  var counter = 0;
  function newElemId() {
    counter += 1;
    return `e${Date.now().toString(36)}-${counter.toString(36)}`;
  }
  function newSlide(elements = []) {
    return { id: newElemId(), elements };
  }
  function newDeck() {
    return {
      schemaVersion: DECK_SCHEMA_VERSION,
      slides: [
        newSlide([
          textElement({ x: 160, y: 300, w: 1280, h: 160, text: "Title slide", size: 88, bold: true, align: "center" }),
          textElement({ x: 160, y: 500, w: 1280, h: 80, text: "Subtitle", size: 40, align: "center", color: "#666666" })
        ])
      ]
    };
  }
  function textElement(props) {
    return {
      id: newElemId(),
      kind: "text",
      text: "Text",
      size: 36,
      bold: false,
      align: "left",
      color: "#222222",
      ...props
    };
  }
  function rectElement(props) {
    return { id: newElemId(), kind: "rect", fill: "#dbe7f0", ...props };
  }
  function lineElement(props) {
    return { id: newElemId(), kind: "line", dir: "down", stroke: "#444444", strokeWidth: 4, arrow: false, ...props };
  }
  function imageElement(src, props) {
    return { id: newElemId(), kind: "image", src, ...props };
  }
  function addSlide(deck2, afterIndex) {
    const slide = newSlide([
      textElement({ x: 120, y: 80, w: 1360, h: 110, text: "Slide title", size: 60, bold: true }),
      textElement({ x: 120, y: 260, w: 1360, h: 540, text: "Body text", size: 36 })
    ]);
    const at = Math.min(Math.max(afterIndex + 1, 0), deck2.slides.length);
    deck2.slides.splice(at, 0, slide);
    return at;
  }
  function removeSlide(deck2, index) {
    if (deck2.slides.length <= 1) {
      deck2.slides[0] = newSlide();
      return;
    }
    deck2.slides.splice(index, 1);
  }
  function duplicateSlide(deck2, index) {
    const src = deck2.slides[index];
    if (!src) return index;
    const copy = {
      id: newElemId(),
      elements: src.elements.map((e) => ({ ...e, id: newElemId() }))
    };
    deck2.slides.splice(index + 1, 0, copy);
    return index + 1;
  }
  function addElement(deck2, slideIndex, element) {
    deck2.slides[slideIndex]?.elements.push(element);
  }
  function reorderElement(deck2, slideIndex, elementId, move) {
    const slide = deck2.slides[slideIndex];
    if (!slide) return;
    const i = slide.elements.findIndex((e) => e.id === elementId);
    if (i < 0) return;
    const [el] = slide.elements.splice(i, 1);
    const target = move === "front" ? slide.elements.length : move === "back" ? 0 : move === "forward" ? Math.min(slide.elements.length, i + 1) : Math.max(0, i - 1);
    slide.elements.splice(target, 0, el);
  }
  function removeElement(deck2, slideIndex, elementId) {
    const slide = deck2.slides[slideIndex];
    if (!slide) return;
    slide.elements = slide.elements.filter((e) => e.id !== elementId);
  }
  function updateElement(deck2, slideIndex, elementId, patch) {
    const el = deck2.slides[slideIndex]?.elements.find((e) => e.id === elementId);
    if (!el) return;
    Object.assign(el, patch, { id: el.id, kind: el.kind });
    clampElement(el);
  }
  function clampElement(el) {
    const minSide = el.kind === "line" ? 4 : 40;
    el.w = Math.max(minSide, Math.min(el.w, CANVAS_W));
    el.h = Math.max(minSide, Math.min(el.h, CANVAS_H));
    el.x = Math.max(0, Math.min(el.x, CANVAS_W - el.w));
    el.y = Math.max(0, Math.min(el.y, CANVAS_H - el.h));
  }
  function validateDeck(deck2) {
    const errors = [];
    if (deck2.schemaVersion !== DECK_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${deck2.schemaVersion}`);
    if (deck2.slides.length === 0) errors.push("deck has no slides");
    const ids = /* @__PURE__ */ new Set();
    deck2.slides.forEach((s, si) => {
      if (ids.has(s.id)) errors.push(`duplicate slide id ${s.id}`);
      ids.add(s.id);
      s.elements.forEach((e) => {
        if (ids.has(e.id)) errors.push(`duplicate element id ${e.id}`);
        ids.add(e.id);
        if (e.kind !== "text" && e.kind !== "rect" && e.kind !== "image" && e.kind !== "line")
          errors.push(`slide ${si}: unknown element kind`);
        if (e.kind === "image" && (typeof e.src !== "string" || !e.src.startsWith("data:image/")))
          errors.push(`slide ${si}: image element without a data:image src`);
        if (e.x < 0 || e.y < 0 || e.x + e.w > CANVAS_W || e.y + e.h > CANVAS_H) {
          errors.push(`slide ${si}: element ${e.id} outside canvas`);
        }
      });
    });
    return errors;
  }
  function deckToJSON(deck2) {
    return JSON.stringify(deck2, null, 2);
  }
  function deckFromJSON(json) {
    const deck2 = JSON.parse(json);
    const errors = validateDeck(deck2);
    if (errors.length > 0) throw new Error(`Invalid deck: ${errors.join("; ")}`);
    return deck2;
  }

  // engines/document-model/src/history.ts
  var COALESCE_MS = 1e3;
  function clone(model) {
    return typeof structuredClone === "function" ? structuredClone(model) : JSON.parse(JSON.stringify(model));
  }
  var History = class {
    constructor(limit = 200) {
      __publicField(this, "undoStack", []);
      __publicField(this, "redoStack", []);
      __publicField(this, "limit");
      this.limit = limit;
    }
    /** Record the pre-change state. Call before applying a transaction. */
    checkpoint(model, key = null, now = Date.now()) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (key !== null && top && top.key === key && now - top.at < COALESCE_MS) {
        top.at = now;
        this.redoStack = [];
        return;
      }
      this.undoStack.push({ model: clone(model), key, at: now });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack = [];
    }
    canUndo() {
      return this.undoStack.length > 0;
    }
    canRedo() {
      return this.redoStack.length > 0;
    }
    /** Returns the model state to restore, or null. `current` goes to the redo stack. */
    undo(current2) {
      const entry = this.undoStack.pop();
      if (!entry) return null;
      this.redoStack.push({ model: clone(current2), key: null, at: Date.now() });
      return clone(entry.model);
    }
    redo(current2) {
      const entry = this.redoStack.pop();
      if (!entry) return null;
      this.undoStack.push({ model: clone(current2), key: null, at: Date.now() });
      return clone(entry.model);
    }
  };

  // engines/format-conversion/src/zip.ts
  var CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(data) {
    let crc = 4294967295;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 255] ^ crc >>> 8;
    }
    return (crc ^ 4294967295) >>> 0;
  }
  async function pipeThrough(data, stream) {
    const src = new Blob([data]).stream();
    const buf = await new Response(src.pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function deflateRaw(data) {
    if (typeof CompressionStream === "undefined") return null;
    return pipeThrough(data, new CompressionStream("deflate-raw"));
  }
  async function inflateRaw(data) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Cannot read compressed ZIP entries: DecompressionStream unavailable");
    }
    return pipeThrough(data, new DecompressionStream("deflate-raw"));
  }
  var textEncoder = new TextEncoder();
  async function zipWrite(entries) {
    const prepared = [];
    const chunks = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = textEncoder.encode(entry.name);
      const crc = crc32(entry.data);
      const deflated = await deflateRaw(entry.data);
      const useDeflate = deflated !== null && deflated.length < entry.data.length;
      const raw = useDeflate ? deflated : entry.data;
      const method = useDeflate ? 8 : 0;
      const header = new DataView(new ArrayBuffer(30));
      header.setUint32(0, 67324752, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 0, true);
      header.setUint16(8, method, true);
      header.setUint16(10, 0, true);
      header.setUint16(12, 33, true);
      header.setUint32(14, crc, true);
      header.setUint32(18, raw.length, true);
      header.setUint32(22, entry.data.length, true);
      header.setUint16(26, nameBytes.length, true);
      header.setUint16(28, 0, true);
      prepared.push({ nameBytes, data: entry.data, raw, method, crc, offset });
      chunks.push(new Uint8Array(header.buffer), nameBytes, raw);
      offset += 30 + nameBytes.length + raw.length;
    }
    const cdStart = offset;
    for (const p of prepared) {
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 33639248, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0, true);
      cd.setUint16(10, p.method, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 33, true);
      cd.setUint32(16, p.crc, true);
      cd.setUint32(20, p.raw.length, true);
      cd.setUint32(24, p.data.length, true);
      cd.setUint16(28, p.nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, p.offset, true);
      chunks.push(new Uint8Array(cd.buffer), p.nameBytes);
      offset += 46 + p.nameBytes.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 101010256, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, prepared.length, true);
    eocd.setUint16(10, prepared.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    eocd.setUint16(20, 0, true);
    chunks.push(new Uint8Array(eocd.buffer));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
  var textDecoder = new TextDecoder();
  async function zipRead(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    const scanFloor = Math.max(0, bytes.length - 65558);
    for (let i = bytes.length - 22; i >= scanFloor; i--) {
      if (view.getUint32(i, true) === 101010256) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Not a ZIP archive (no end-of-central-directory record)");
    const count = view.getUint16(eocd + 10, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 33639248) {
        throw new Error("Corrupt ZIP: bad central-directory signature");
      }
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compSize = view.getUint32(p + 20, true);
      const uncompSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = new Uint8Array(raw);
      else if (method === 8) data = await inflateRaw(new Uint8Array(raw));
      else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
      if (data.length !== uncompSize) {
        throw new Error(`Corrupt ZIP entry ${name}: size mismatch`);
      }
      if (crc32(data) !== crc) {
        throw new Error(`Corrupt ZIP entry ${name}: CRC mismatch`);
      }
      entries.push({ name, data });
    }
    return entries;
  }

  // engines/format-conversion/src/pptx.ts
  var textEncoder2 = new TextEncoder();
  var EMU_PER_UNIT = 7620;
  var PT_PER_UNIT = 0.6;
  var SLIDE_CX = 12192e3;
  var SLIDE_CY = 6858e3;
  var NS_P = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  var NS_A = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
  var NS_R = `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  var REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  function decodeBase64(b64) {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  function encodeBase64(data) {
    if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
    let bin = "";
    for (const byte of data) bin += String.fromCharCode(byte);
    return btoa(bin);
  }
  var DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/;
  function xmlEscape(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function hex6(color, fallback) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(color ?? "");
    return (m ? m[1] : fallback).toUpperCase();
  }
  function shapeXml(el, index, media) {
    const off = `<a:off x="${Math.round(el.x * EMU_PER_UNIT)}" y="${Math.round(el.y * EMU_PER_UNIT)}"/>`;
    const ext = `<a:ext cx="${Math.round(el.w * EMU_PER_UNIT)}" cy="${Math.round(el.h * EMU_PER_UNIT)}"/>`;
    const xfrm = `<a:xfrm>${off}${ext}</a:xfrm>`;
    const geom = `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
    if (el.kind === "image") {
      const m = DATA_URL_RE.exec(el.src ?? "");
      if (!m || !media) {
        return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="Image ${index + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}${geom}<a:solidFill><a:srgbClr val="EEEEEE"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
      }
      const ext2 = m[1] === "jpg" ? "jpeg" : m[1];
      const partName = `ppt/media/image${media.parts.length + 1}.${ext2}`;
      media.parts.push({ name: partName, ext: ext2, data: decodeBase64(m[2]) });
      const relId = `rIdImg${media.slideRels.length + 1}`;
      media.slideRels.push({ id: relId, target: `../media/${partName.split("/").pop()}` });
      return `<p:pic><p:nvPicPr><p:cNvPr id="${index + 2}" name="Picture ${index + 1}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm}${geom}</p:spPr></p:pic>`;
    }
    if (el.kind === "line") {
      const flip = el.dir === "up" ? ` flipV="1"` : "";
      const lineXfrm = `<a:xfrm${flip}>${off}${ext}</a:xfrm>`;
      const wEmu = Math.max(1, Math.round((el.strokeWidth ?? 4) * EMU_PER_UNIT));
      const head = el.arrow ? `<a:tailEnd type="triangle" w="med" len="med"/>` : "";
      return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${index + 2}" name="Line ${index + 1}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${lineXfrm}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${wEmu}"><a:solidFill><a:srgbClr val="${hex6(el.stroke, "444444")}"/></a:solidFill>${head}</a:ln></p:spPr></p:cxnSp>`;
    }
    if (el.kind === "rect") {
      const prst = el.shape === "ellipse" ? "ellipse" : "rect";
      const shapeGeom = `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`;
      return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="Box ${index + 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}${shapeGeom}<a:solidFill><a:srgbClr val="${hex6(el.fill, "DBE7F0")}"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
    }
    const algn = el.align === "center" ? "ctr" : el.align === "right" ? "r" : "l";
    const sz = Math.max(100, Math.round((el.size ?? 36) * PT_PER_UNIT * 100));
    const bold = el.bold ? ` b="1"` : "";
    const color = hex6(el.color, "222222");
    const lines = (el.text ?? "").split("\n");
    const paragraphs = lines.map((line) => {
      const run = line.length > 0 ? `<a:r><a:rPr lang="en-US" sz="${sz}"${bold} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlEscape(line)}</a:t></a:r>` : `<a:endParaRPr lang="en-US" sz="${sz}"${bold}/>`;
      return `<a:p><a:pPr algn="${algn}"/>${run}</a:p>`;
    }).join("");
    return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="TextBox ${index + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}${geom}<a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  }
  function slideXml(slide, media) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` + slide.elements.map((el, i) => shapeXml(el, i, media)).join("") + `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`;
  }
  var CLR_MAP = `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"`;
  var SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;
  var SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout ${NS_P} ${NS_A} ${NS_R} type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  var THEME = (() => {
    const fill = (shade) => `<a:solidFill><a:schemeClr val="phClr">${shade}</a:schemeClr></a:solidFill>`;
    const ln = (w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
    const effect = `<a:effectStyle><a:effectLst/></a:effectStyle>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme ${NS_A} name="Casserole"><a:themeElements><a:clrScheme name="Casserole"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="26222E"/></a:dk2><a:lt2><a:srgbClr val="EFEEF4"/></a:lt2><a:accent1><a:srgbClr val="6B4B9E"/></a:accent1><a:accent2><a:srgbClr val="B4552D"/></a:accent2><a:accent3><a:srgbClr val="3C6E47"/></a:accent3><a:accent4><a:srgbClr val="2D6CB4"/></a:accent4><a:accent5><a:srgbClr val="B42D6C"/></a:accent5><a:accent6><a:srgbClr val="6CB42D"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Casserole"><a:majorFont><a:latin typeface="Avenir Next"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Avenir Next"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Casserole"><a:fillStyleLst>${fill("")}${fill(`<a:tint val="50000"/>`)}${fill(`<a:shade val="75000"/>`)}</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst><a:effectStyleLst>${effect}${effect}${effect}</a:effectStyleLst><a:bgFillStyleLst>${fill("")}${fill(`<a:tint val="90000"/>`)}${fill(`<a:shade val="85000"/>`)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  })();
  function rels(entries) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` + entries.map((e) => `<Relationship Id="${e.id}" Type="${REL_NS}/${e.type}" Target="${e.target}"/>`).join("") + `</Relationships>`;
  }
  async function exportPptx(deck2) {
    const n = deck2.slides.length;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` + deck2.slides.map(
      (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    ).join("") + `</Types>`;
    const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation ${NS_P} ${NS_A} ${NS_R}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>` + deck2.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("") + `</p:sldIdLst><p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/><p:notesSz cx="${SLIDE_CY}" cy="${SLIDE_CX}"/></p:presentation>`;
    const presRels = rels([
      { id: "rId1", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
      ...deck2.slides.map((_, i) => ({
        id: `rId${i + 2}`,
        type: "slide",
        target: `slides/slide${i + 1}.xml`
      }))
    ]);
    const entries = [
      { name: "[Content_Types].xml", data: textEncoder2.encode(contentTypes) },
      {
        name: "_rels/.rels",
        data: textEncoder2.encode(rels([{ id: "rId1", type: "officeDocument", target: "ppt/presentation.xml" }]))
      },
      { name: "ppt/presentation.xml", data: textEncoder2.encode(presentation) },
      { name: "ppt/_rels/presentation.xml.rels", data: textEncoder2.encode(presRels) },
      { name: "ppt/slideMasters/slideMaster1.xml", data: textEncoder2.encode(SLIDE_MASTER) },
      {
        name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        data: textEncoder2.encode(
          rels([
            { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
            { id: "rId2", type: "theme", target: "../theme/theme1.xml" }
          ])
        )
      },
      { name: "ppt/slideLayouts/slideLayout1.xml", data: textEncoder2.encode(SLIDE_LAYOUT) },
      {
        name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        data: textEncoder2.encode(rels([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]))
      },
      { name: "ppt/theme/theme1.xml", data: textEncoder2.encode(THEME) }
    ];
    const allMedia = [];
    deck2.slides.forEach((slide, i) => {
      const media = { parts: allMedia, slideRels: [] };
      const xml = slideXml(slide, media);
      entries.push({ name: `ppt/slides/slide${i + 1}.xml`, data: textEncoder2.encode(xml) });
      entries.push({
        name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        data: textEncoder2.encode(
          rels([
            { id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" },
            ...media.slideRels.map((r) => ({ id: r.id, type: "image", target: r.target }))
          ])
        )
      });
    });
    for (const part of allMedia) {
      entries.push({ name: part.name, data: part.data });
    }
    return {
      bytes: await zipWrite(entries),
      report: {
        format: "pptx",
        lossless: true,
        warnings: []
      }
    };
  }
  var textDecoder2 = new TextDecoder();
  function defaultParse(xml) {
    if (typeof DOMParser === "undefined") {
      throw new Error("No XML parser available: pass parseXml to importPptx");
    }
    return new DOMParser().parseFromString(xml, "application/xml");
  }
  function kids(el, name) {
    const out = [];
    const children = el.children ?? [];
    for (let i = 0; i < children.length; i++) {
      if (children[i].localName === name) out.push(children[i]);
    }
    return out;
  }
  function kid(el, name) {
    return kids(el, name)[0] ?? null;
  }
  function deep(el, name) {
    const out = [];
    const walk = (e) => {
      const children = e.children ?? [];
      for (let i = 0; i < children.length; i++) {
        const c = children[i];
        if (c.localName === name) out.push(c);
        walk(c);
      }
    };
    walk(el);
    return out;
  }
  function importConnector(cxn, scale) {
    const spPr = kid(cxn, "spPr");
    const xfrm = spPr ? kid(spPr, "xfrm") : null;
    if (!spPr || !xfrm) return null;
    const off = kid(xfrm, "off");
    const extEl = kid(xfrm, "ext");
    const el = {
      id: newElemId(),
      kind: "line",
      x: Number(off?.getAttribute("x") ?? 0) * scale.x,
      y: Number(off?.getAttribute("y") ?? 0) * scale.y,
      w: Number(extEl?.getAttribute("cx") ?? 0) * scale.x,
      h: Number(extEl?.getAttribute("cy") ?? 0) * scale.y,
      dir: xfrm.getAttribute("flipV") === "1" ? "up" : "down"
    };
    const ln = kid(spPr, "ln");
    if (ln) {
      const wAttr = ln.getAttribute("w");
      if (wAttr) el.strokeWidth = Math.max(1, Math.round(Number(wAttr) / EMU_PER_UNIT));
      const clr = deep(ln, "srgbClr")[0];
      if (clr) el.stroke = `#${(clr.getAttribute("val") ?? "444444").toLowerCase()}`;
      if (kid(ln, "tailEnd")?.getAttribute("type") === "triangle") el.arrow = true;
    }
    clampElement(el);
    return el;
  }
  function importShape(sp, scale, warnings, slideIndex, fallbackSlot) {
    const spPr = kid(sp, "spPr");
    const xfrm = spPr ? kid(spPr, "xfrm") : null;
    let x, y, w, h;
    if (xfrm) {
      const off = kid(xfrm, "off");
      const ext = kid(xfrm, "ext");
      x = Number(off?.getAttribute("x") ?? 0) * scale.x;
      y = Number(off?.getAttribute("y") ?? 0) * scale.y;
      w = Number(ext?.getAttribute("cx") ?? 0) * scale.x;
      h = Number(ext?.getAttribute("cy") ?? 0) * scale.y;
    } else {
      warnings.push({
        code: "PPTX-IMPORT-NO-GEOMETRY",
        message: `Slide ${slideIndex + 1}: a placeholder had no explicit position (layout inheritance not yet resolved); default position used.`,
        blockIndex: slideIndex
      });
      x = 120;
      y = 100 + fallbackSlot.n * 180;
      w = CANVAS_W - 240;
      h = 160;
      fallbackSlot.n++;
    }
    const txBody = kid(sp, "txBody");
    const paragraphs = txBody ? kids(txBody, "p") : [];
    const textLines = paragraphs.map(
      (p) => deep(p, "t").map((t) => t.textContent ?? "").join("")
    );
    const hasText = textLines.some((l) => l.length > 0);
    if (!hasText) {
      const fillClr = spPr ? deep(spPr, "srgbClr")[0] : null;
      const fill = fillClr ? `#${(fillClr.getAttribute("val") ?? "DBE7F0").toLowerCase()}` : void 0;
      const prst = spPr ? deep(spPr, "prstGeom")[0]?.getAttribute("prst") : null;
      const el2 = { id: newElemId(), kind: "rect", x, y, w, h, fill };
      if (prst === "ellipse") el2.shape = "ellipse";
      clampElement(el2);
      return el2;
    }
    const firstPPr = paragraphs.map((p) => kid(p, "pPr")).find((p) => p) ?? null;
    const algnAttr = firstPPr?.getAttribute("algn") ?? null;
    const align = algnAttr === "ctr" ? "center" : algnAttr === "r" ? "right" : "left";
    const firstRPr = deep(txBody, "rPr")[0] ?? null;
    const szAttr = firstRPr?.getAttribute("sz");
    const size = szAttr ? Math.max(12, Math.round(Number(szAttr) / 100 / PT_PER_UNIT)) : 36;
    const bold = firstRPr?.getAttribute("b") === "1";
    const clr = firstRPr ? deep(firstRPr, "srgbClr")[0] : null;
    const color = clr ? `#${(clr.getAttribute("val") ?? "222222").toLowerCase()}` : "#222222";
    const rPrs = deep(txBody, "rPr");
    if (rPrs.length > 1) {
      const uniform = rPrs.every(
        (r) => (r.getAttribute("sz") ?? "") === (rPrs[0].getAttribute("sz") ?? "") && (r.getAttribute("b") ?? "") === (rPrs[0].getAttribute("b") ?? "")
      );
      if (!uniform) {
        warnings.push({
          code: "PPTX-IMPORT-MIXED-RUNS",
          message: `Slide ${slideIndex + 1}: mixed per-run formatting flattened to the first run's style (per-run styling not yet in the model).`,
          blockIndex: slideIndex
        });
      }
    }
    const el = {
      id: newElemId(),
      kind: "text",
      x,
      y,
      w,
      h,
      text: textLines.join("\n"),
      size,
      bold,
      align,
      color
    };
    clampElement(el);
    return el;
  }
  async function importPptx(bytes, parseXml = defaultParse) {
    const warnings = [];
    const entries = await zipRead(bytes);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const presEntry = byName.get("ppt/presentation.xml");
    if (!presEntry) throw new Error("Not a PPTX package: ppt/presentation.xml missing");
    const pres = parseXml(textDecoder2.decode(presEntry.data));
    const sldSz = deep(pres, "sldSz")[0];
    const cx = Number(sldSz?.getAttribute("cx") ?? SLIDE_CX);
    const cy = Number(sldSz?.getAttribute("cy") ?? SLIDE_CY);
    const scale = { x: CANVAS_W / cx, y: CANVAS_H / cy };
    if (Math.abs(cx / cy - 16 / 9) > 0.02) {
      warnings.push({
        code: "PPTX-IMPORT-ASPECT",
        message: `Source slides are ${cx}\xD7${cy} EMU (not 16:9); geometry was scaled per axis to fit the 16:9 canvas.`,
        blockIndex: -1
      });
    }
    const relsEntry = byName.get("ppt/_rels/presentation.xml.rels");
    const relTargets = /* @__PURE__ */ new Map();
    if (relsEntry) {
      const relsDom = parseXml(textDecoder2.decode(relsEntry.data));
      for (const rel of deep(relsDom, "Relationship")) {
        relTargets.set(rel.getAttribute("Id") ?? "", rel.getAttribute("Target") ?? "");
      }
    }
    const slideParts = [];
    for (const sldId of deep(pres, "sldId")) {
      const rId = sldId.getAttributeNS?.("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? sldId.getAttribute("r:id") ?? "";
      const target = relTargets.get(rId);
      if (target) slideParts.push("ppt/" + target.replace(/^\.\//, ""));
    }
    if (slideParts.length === 0) {
      for (const name of [...byName.keys()].sort()) {
        if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) slideParts.push(name);
      }
    }
    if (slideParts.length === 0) throw new Error("PPTX package has no slides");
    const deck2 = { schemaVersion: DECK_SCHEMA_VERSION, slides: [] };
    slideParts.forEach((part, si) => {
      const entry = byName.get(part);
      const slide = { id: newElemId(), elements: [] };
      if (!entry) {
        warnings.push({
          code: "PPTX-IMPORT-MISSING-PART",
          message: `Slide part ${part} is referenced but missing; imported as an empty slide.`,
          blockIndex: si
        });
        deck2.slides.push(slide);
        return;
      }
      const dom = parseXml(textDecoder2.decode(entry.data));
      const slideRelTargets = /* @__PURE__ */ new Map();
      {
        const dir = part.slice(0, part.lastIndexOf("/"));
        const relsName = `${dir}/_rels/${part.split("/").pop()}.rels`;
        const relsPart = byName.get(relsName);
        if (relsPart) {
          const relsDom = parseXml(textDecoder2.decode(relsPart.data));
          for (const rel of deep(relsDom, "Relationship")) {
            const target = rel.getAttribute("Target") ?? "";
            const resolved = target.startsWith("../") ? "ppt/" + target.slice(3) : `${dir}/${target}`;
            slideRelTargets.set(rel.getAttribute("Id") ?? "", resolved);
          }
        }
      }
      const spTree = deep(dom, "spTree")[0];
      if (!spTree) {
        deck2.slides.push(slide);
        return;
      }
      const fallbackSlot = { n: 0 };
      for (let i = 0; i < spTree.children.length; i++) {
        const child = spTree.children[i];
        if (child.localName === "sp") {
          const el = importShape(child, scale, warnings, si, fallbackSlot);
          if (el) slide.elements.push(el);
        } else if (child.localName === "pic") {
          const el = importPicture(child, scale, si, warnings, slideRelTargets, byName);
          if (el) slide.elements.push(el);
        } else if (child.localName === "cxnSp") {
          const el = importConnector(child, scale);
          if (el) slide.elements.push(el);
          else
            warnings.push({
              code: "PPTX-IMPORT-CONNECTOR",
              message: `Slide ${si + 1}: a connector without usable geometry was skipped.`,
              blockIndex: si
            });
        } else if (child.localName === "graphicFrame") {
          warnings.push({
            code: "PPTX-IMPORT-GRAPHIC",
            message: `Slide ${si + 1}: a table/chart/diagram frame was skipped.`,
            blockIndex: si
          });
        } else if (child.localName === "grpSp") {
          warnings.push({
            code: "PPTX-IMPORT-GROUP",
            message: `Slide ${si + 1}: a grouped shape was skipped (group transforms not yet supported).`,
            blockIndex: si
          });
        }
      }
      deck2.slides.push(slide);
    });
    const errors = validateDeck(deck2);
    if (errors.length > 0) throw new Error(`PPTX import produced invalid deck: ${errors.join("; ")}`);
    return { deck: deck2, report: { format: "pptx", lossless: warnings.length === 0, warnings } };
  }
  var MIME_BY_EXT = {
    png: "image/png",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    gif: "image/gif"
  };
  function importPicture(pic, scale, slideIndex, warnings, relTargets, byName) {
    const xfrm = deep(pic, "xfrm")[0];
    const off = xfrm ? kid(xfrm, "off") : null;
    const ext = xfrm ? kid(xfrm, "ext") : null;
    const x = Number(off?.getAttribute("x") ?? 0) * scale.x;
    const y = Number(off?.getAttribute("y") ?? 0) * scale.y;
    const w = Number(ext?.getAttribute("cx") ?? 0) * scale.x || 400;
    const h = Number(ext?.getAttribute("cy") ?? 0) * scale.y || 300;
    const blip = deep(pic, "blip")[0];
    const embed = blip?.getAttributeNS?.("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") ?? blip?.getAttribute("r:embed") ?? "";
    const target = relTargets.get(embed);
    const part = target ? byName.get(target) : void 0;
    const fileExt = target?.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_BY_EXT[fileExt];
    if (!part || !mime) {
      warnings.push({
        code: "PPTX-IMPORT-PICTURE-MISSING",
        message: `Slide ${slideIndex + 1}: a picture's media part was missing or unsupported (${fileExt || "unknown"}); placeholder kept.`,
        blockIndex: slideIndex
      });
      const el2 = { id: newElemId(), kind: "rect", x, y, w, h, fill: "#eeeeee" };
      clampElement(el2);
      return el2;
    }
    const el = imageElement(`data:${mime};base64,${encodeBase64(part.data)}`, { x, y, w, h });
    clampElement(el);
    return el;
  }

  // apps/slides/src/main.ts
  var STORAGE_KEY = "casserole-slides:v1:default";
  var deck = newDeck();
  var current = 0;
  var selectedId = null;
  var history = new History();
  var thumbsEl = document.getElementById("thumbs");
  var canvasEl = document.getElementById("canvas");
  var statusEl = document.getElementById("status");
  var presentEl = document.getElementById("present");
  var propsEl = document.getElementById("props");
  var saveTimer = null;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, deckToJSON(deck));
      statusEl.textContent = `Saved ${(/* @__PURE__ */ new Date()).toLocaleTimeString()}`;
    } catch {
      statusEl.textContent = "Autosave unavailable \u2014 export JSON to keep your work";
    }
  }
  function scheduleSave() {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 500);
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        deck = deckFromJSON(raw);
        statusEl.textContent = "Restored deck";
        return;
      }
    } catch {
      statusEl.textContent = "Stored deck unreadable; started fresh (storage left untouched until next save)";
    }
    deck = newDeck();
    addSlide(deck, 0);
    updateElement(deck, 1, deck.slides[1].elements[0].id, { text: "Why Casserole Slides" });
    updateElement(deck, 1, deck.slides[1].elements[1].id, {
      text: "\u2022 Real editable elements, not images\n\u2022 Drag to move, handle to resize\n\u2022 Double-click any text to edit\n\u2022 Undo/redo, autosave, present mode (\u25B6)"
    });
  }
  function elementHtml(el, scale, selected) {
    const style = `left:${el.x * scale}px;top:${el.y * scale}px;width:${el.w * scale}px;height:${el.h * scale}px;`;
    if (el.kind === "image") {
      return `<div class="el image${selected ? " sel" : ""}" data-id="${el.id}" style="${style}"><img src="${el.src ?? ""}" alt="" draggable="false"/>` + (selected ? `<div class="handle" data-handle="${el.id}"></div>` : "") + `</div>`;
    }
    if (el.kind === "line") {
      const sw = Math.max(1, (el.strokeWidth ?? 4) * scale);
      const stroke = el.stroke ?? "#444444";
      const up = el.dir === "up";
      const W = Math.max(1, el.w * scale);
      const H = Math.max(1, el.h * scale);
      const y1 = up ? H : 0;
      const y2 = up ? 0 : H;
      const mid = `m-${el.id}`;
      const marker = el.arrow ? `<defs><marker id="${mid}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${stroke}"/></marker></defs>` : "";
      return `<div class="el line${selected ? " sel" : ""}" data-id="${el.id}" style="${style}"><svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${marker}<line x1="0" y1="${y1}" x2="${W}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"` + (el.arrow ? ` marker-end="url(#${mid})"` : "") + ` /></svg>` + (selected ? `<div class="handle" data-handle="${el.id}"></div>` : "") + `</div>`;
    }
    if (el.kind === "rect") {
      const radius = el.shape === "ellipse" ? "border-radius:50%;" : "";
      return `<div class="el rect${selected ? " sel" : ""}" data-id="${el.id}" style="${style}${radius}background:${el.fill ?? "#dbe7f0"}">` + (selected ? `<div class="handle" data-handle="${el.id}"></div>` : "") + `</div>`;
    }
    const textStyle = `font-size:${(el.size ?? 36) * scale}px;font-weight:${el.bold ? 700 : 400};text-align:${el.align ?? "left"};color:${el.color ?? "#222"};`;
    const text = (el.text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
    return `<div class="el text${selected ? " sel" : ""}" data-id="${el.id}" style="${style}"><div class="t" style="${textStyle}">${text}</div>` + (selected ? `<div class="handle" data-handle="${el.id}"></div>` : "") + `</div>`;
  }
  function slideHtml(index, scale, selectable) {
    const slide = deck.slides[index];
    if (!slide) return "";
    return slide.elements.map((el) => elementHtml(el, scale, selectable && el.id === selectedId)).join("");
  }
  function render() {
    const scale = canvasEl.clientWidth / CANVAS_W;
    canvasEl.innerHTML = slideHtml(current, scale, true);
    thumbsEl.innerHTML = deck.slides.map(
      (s, i) => `<div class="thumb${i === current ? " active" : ""}" data-slide="${i}"><div class="mini">${slideHtml(i, 160 / CANVAS_W, false)}</div><span class="n">${i + 1}</span></div>`
    ).join("");
    renderProps();
    const errors = validateDeck(deck);
    if (errors.length > 0) {
      console.error("DECK INVARIANT VIOLATION:", errors);
      statusEl.textContent = "\u26A0 internal model error \u2014 see console";
    }
  }
  function selectedElement() {
    return deck.slides[current]?.elements.find((e) => e.id === selectedId) ?? null;
  }
  function renderProps() {
    const el = selectedElement();
    if (!el) {
      propsEl.innerHTML = `<span class="hint">Select an element \u2014 or double-click text to edit it</span>`;
      return;
    }
    if (el.kind === "text") {
      propsEl.innerHTML = `<label>Size <input id="p-size" type="number" min="12" max="200" value="${el.size ?? 36}"></label><label><input id="p-bold" type="checkbox" ${el.bold ? "checked" : ""}> Bold</label><label>Align <select id="p-align">` + ["left", "center", "right"].map((a) => `<option ${a === (el.align ?? "left") ? "selected" : ""}>${a}</option>`).join("") + `</select></label><label>Color <input id="p-color" type="color" value="${el.color ?? "#222222"}"></label>`;
    } else if (el.kind === "rect") {
      propsEl.innerHTML = `<label>Fill <input id="p-fill" type="color" value="${el.fill ?? "#dbe7f0"}"></label><label>Shape <select id="p-shape"><option value="rect" ${el.shape !== "ellipse" ? "selected" : ""}>Rectangle</option><option value="ellipse" ${el.shape === "ellipse" ? "selected" : ""}>Ellipse</option></select></label>`;
    } else if (el.kind === "line") {
      propsEl.innerHTML = `<label>Stroke <input id="p-stroke" type="color" value="${el.stroke ?? "#444444"}"></label><label>Width <input id="p-strokew" type="number" min="1" max="40" value="${el.strokeWidth ?? 4}"></label><label><input id="p-arrow" type="checkbox" ${el.arrow ? "checked" : ""}> Arrow</label><button id="p-flip" title="Flip direction">\u21F5 Flip</button>`;
    } else {
      propsEl.innerHTML = `<span class="hint">Image \u2014 drag to move, handle to resize</span>`;
    }
    if (el) {
      propsEl.innerHTML += `<span class="z-group"><button id="p-front" title="Bring to front">\u2B06\u2B06</button><button id="p-forward" title="Bring forward">\u2B06</button><button id="p-backward" title="Send backward">\u2B07</button><button id="p-back" title="Send to back">\u2B07\u2B07</button></span>`;
    }
    const patch = (p) => {
      history.checkpoint(deck, "props");
      updateElement(deck, current, el.id, p);
      render();
      scheduleSave();
    };
    document.getElementById("p-size")?.addEventListener(
      "change",
      (e) => patch({ size: Number(e.target.value) || 36 })
    );
    document.getElementById("p-bold")?.addEventListener(
      "change",
      (e) => patch({ bold: e.target.checked })
    );
    document.getElementById("p-align")?.addEventListener(
      "change",
      (e) => patch({ align: e.target.value })
    );
    document.getElementById("p-color")?.addEventListener(
      "change",
      (e) => patch({ color: e.target.value })
    );
    document.getElementById("p-stroke")?.addEventListener(
      "change",
      (e) => patch({ stroke: e.target.value })
    );
    document.getElementById("p-strokew")?.addEventListener(
      "change",
      (e) => patch({ strokeWidth: Math.max(1, Number(e.target.value) || 4) })
    );
    document.getElementById("p-arrow")?.addEventListener(
      "change",
      (e) => patch({ arrow: e.target.checked })
    );
    document.getElementById("p-flip")?.addEventListener(
      "click",
      () => patch({ dir: el.dir === "up" ? "down" : "up" })
    );
    document.getElementById("p-fill")?.addEventListener(
      "change",
      (e) => patch({ fill: e.target.value })
    );
    document.getElementById("p-shape")?.addEventListener(
      "change",
      (e) => patch({ shape: e.target.value })
    );
    for (const [id, move] of [["p-front", "front"], ["p-forward", "forward"], ["p-backward", "backward"], ["p-back", "back"]]) {
      document.getElementById(id)?.addEventListener("click", () => {
        if (!selectedId) return;
        history.checkpoint(deck);
        reorderElement(deck, current, selectedId, move);
        render();
        scheduleSave();
      });
    }
  }
  var drag = null;
  canvasEl.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest("[data-handle]");
    const elDiv = e.target.closest(".el");
    const scale = canvasEl.clientWidth / CANVAS_W;
    if (handle) {
      const el = selectedElement();
      if (!el) return;
      drag = { id: el.id, mode: "resize", startX: e.clientX, startY: e.clientY, orig: { ...el }, moved: false };
      canvasEl.setPointerCapture(e.pointerId);
      return;
    }
    if (elDiv) {
      const id = elDiv.dataset.id;
      if (selectedId !== id) {
        selectedId = id;
        render();
      }
      const el = selectedElement();
      if (!el) return;
      drag = { id, mode: "move", startX: e.clientX, startY: e.clientY, orig: { ...el }, moved: false };
      canvasEl.setPointerCapture(e.pointerId);
    } else {
      selectedId = null;
      render();
    }
  });
  canvasEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const el = deck.slides[current]?.elements.find((x) => x.id === drag.id);
    if (!el) return;
    const scale = canvasEl.clientWidth / CANVAS_W;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    if (!drag.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
      history.checkpoint(deck, "drag-" + drag.id);
      drag.moved = true;
    }
    if (!drag.moved) return;
    if (drag.mode === "move") {
      el.x = drag.orig.x + dx;
      el.y = drag.orig.y + dy;
    } else {
      el.w = drag.orig.w + dx;
      el.h = drag.orig.h + dy;
    }
    clampElement(el);
    render();
  });
  canvasEl.addEventListener("pointerup", () => {
    if (drag?.moved) scheduleSave();
    drag = null;
  });
  var editingOverlay = null;
  function closeOverlay(commit) {
    if (!editingOverlay) return;
    const overlay = editingOverlay;
    editingOverlay = null;
    const id = overlay.dataset.elId;
    const value = overlay.value;
    overlay.remove();
    if (commit) {
      const el = deck.slides[current]?.elements.find((x) => x.id === id);
      if (el && value !== (el.text ?? "")) {
        history.checkpoint(deck);
        updateElement(deck, current, id, { text: value });
        scheduleSave();
      }
    }
    render();
  }
  function openOverlay(el) {
    closeOverlay(true);
    const scale = canvasEl.clientWidth / CANVAS_W;
    const overlay = document.createElement("textarea");
    overlay.className = "edit-overlay";
    overlay.dataset.elId = el.id;
    overlay.value = el.text ?? "";
    overlay.style.left = `${el.x * scale}px`;
    overlay.style.top = `${el.y * scale}px`;
    overlay.style.width = `${el.w * scale}px`;
    overlay.style.height = `${el.h * scale}px`;
    overlay.style.fontSize = `${(el.size ?? 36) * scale}px`;
    overlay.style.fontWeight = el.bold ? "700" : "400";
    overlay.style.textAlign = el.align ?? "left";
    overlay.style.color = el.color ?? "#222";
    overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") closeOverlay(false);
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) closeOverlay(true);
    });
    overlay.addEventListener("blur", () => closeOverlay(true));
    overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
    canvasEl.appendChild(overlay);
    editingOverlay = overlay;
    overlay.focus();
    overlay.select();
  }
  canvasEl.addEventListener("dblclick", (e) => {
    const elDiv = e.target.closest(".el.text");
    if (!elDiv) return;
    const el = deck.slides[current]?.elements.find((x) => x.id === elDiv.dataset.id);
    if (!el) return;
    selectedId = el.id;
    render();
    openOverlay(el);
  });
  thumbsEl.addEventListener("click", (e) => {
    const t = e.target.closest("[data-slide]");
    if (!t) return;
    current = Number(t.dataset.slide);
    selectedId = null;
    render();
  });
  function cmd(fn) {
    history.checkpoint(deck);
    fn();
    render();
    scheduleSave();
  }
  document.getElementById("btn-add-slide")?.addEventListener(
    "click",
    () => cmd(() => {
      current = addSlide(deck, current);
      selectedId = null;
    })
  );
  document.getElementById("btn-dup-slide")?.addEventListener(
    "click",
    () => cmd(() => {
      current = duplicateSlide(deck, current);
      selectedId = null;
    })
  );
  document.getElementById("btn-del-slide")?.addEventListener("click", () => {
    if (!window.confirm("Delete this slide?")) return;
    cmd(() => {
      removeSlide(deck, current);
      current = Math.min(current, deck.slides.length - 1);
      selectedId = null;
    });
  });
  document.getElementById("btn-add-text")?.addEventListener(
    "click",
    () => cmd(() => {
      const el = textElement({ x: 400, y: 350, w: 800, h: 150, text: "New text" });
      addElement(deck, current, el);
      selectedId = el.id;
    })
  );
  document.getElementById("btn-add-image")?.addEventListener("click", () => {
    document.getElementById("image-open")?.click();
  });
  document.getElementById("image-open")?.addEventListener("change", (e) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result ?? "");
      const probe = new Image();
      probe.onload = () => {
        const maxW = 700;
        const ratio = probe.naturalHeight / Math.max(1, probe.naturalWidth);
        const w = Math.min(maxW, probe.naturalWidth || maxW);
        const h = Math.max(60, Math.round(w * ratio) || 400);
        cmd(() => {
          const el = imageElement(src, { x: (1600 - w) / 2, y: Math.max(40, (900 - h) / 2), w, h });
          addElement(deck, current, el);
          selectedId = el.id;
        });
      };
      probe.onerror = () => {
        statusEl.textContent = "\u26A0 Could not read that image";
      };
      probe.src = src;
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("btn-add-rect")?.addEventListener(
    "click",
    () => cmd(() => {
      const el = rectElement({ x: 500, y: 300, w: 600, h: 300 });
      addElement(deck, current, el);
      selectedId = el.id;
    })
  );
  document.getElementById("btn-add-line")?.addEventListener(
    "click",
    () => cmd(() => {
      const el = lineElement({ x: 500, y: 400, w: 600, h: 100, arrow: true });
      addElement(deck, current, el);
      selectedId = el.id;
    })
  );
  document.getElementById("btn-del-el")?.addEventListener("click", () => {
    if (!selectedId) return;
    cmd(() => {
      removeElement(deck, current, selectedId);
      selectedId = null;
    });
  });
  document.getElementById("btn-undo")?.addEventListener("click", () => {
    const prev = history.undo(deck);
    if (prev) {
      deck = prev;
      current = Math.min(current, deck.slides.length - 1);
      selectedId = null;
      render();
      scheduleSave();
    }
  });
  document.getElementById("btn-redo")?.addEventListener("click", () => {
    const next = history.redo(deck);
    if (next) {
      deck = next;
      current = Math.min(current, deck.slides.length - 1);
      selectedId = null;
      render();
      scheduleSave();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!presentEl.hidden) {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") showPresent(presentIndex + 1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") showPresent(presentIndex - 1);
      else if (e.key === "Escape") exitPresent();
      e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      document.getElementById("btn-undo").click();
    } else if (mod && (e.key.toLowerCase() === "y" || e.key.toLowerCase() === "z" && e.shiftKey)) {
      e.preventDefault();
      document.getElementById("btn-redo").click();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !["INPUT", "TEXTAREA"].includes(e.target.tagName)) {
      e.preventDefault();
      document.getElementById("btn-del-el").click();
    }
  });
  var presentIndex = 0;
  function showPresent(index) {
    presentIndex = Math.max(0, Math.min(index, deck.slides.length - 1));
    const stage = presentEl.querySelector(".stage");
    const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H) * 0.94;
    stage.style.width = `${CANVAS_W * scale}px`;
    stage.style.height = `${CANVAS_H * scale}px`;
    stage.innerHTML = deck.slides[presentIndex].elements.map((el) => elementHtml(el, scale, false)).join("");
    presentEl.querySelector(".counter").textContent = `${presentIndex + 1} / ${deck.slides.length}`;
  }
  function exitPresent() {
    presentEl.hidden = true;
  }
  document.getElementById("btn-present")?.addEventListener("click", () => {
    presentEl.hidden = false;
    showPresent(current);
  });
  presentEl.addEventListener("click", () => showPresent(presentIndex + 1));
  var hostDownloads = null;
  if (window.claude?.use) {
    window.claude.use("downloads").then((d) => {
      hostDownloads = d;
    }).catch(() => {
    });
  }
  async function deliverBlob(filename, blob) {
    if (hostDownloads) {
      try {
        await hostDownloads.save({ filename, data: blob });
        return;
      } catch {
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  document.getElementById("btn-export-json")?.addEventListener(
    "click",
    () => deliverBlob("deck.json", new Blob([deckToJSON(deck)], { type: "application/json" }))
  );
  document.getElementById("btn-open")?.addEventListener("click", () => {
    document.getElementById("file-open")?.click();
  });
  document.getElementById("file-open")?.addEventListener("change", async (e) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      if (file.name.toLowerCase().endsWith(".json")) {
        history.checkpoint(deck);
        deck = deckFromJSON(await file.text());
        current = 0;
        selectedId = null;
        render();
        scheduleSave();
        statusEl.textContent = "Imported JSON deck";
        return;
      }
      const { deck: imported, report } = await importPptx(new Uint8Array(await file.arrayBuffer()));
      history.checkpoint(deck);
      deck = imported;
      current = 0;
      selectedId = null;
      render();
      scheduleSave();
      if (report.lossless) {
        statusEl.textContent = "Imported PPTX \u2014 no loss detected for this deck";
      } else {
        statusEl.textContent = `Imported PPTX with ${report.warnings.length} note(s)`;
        window.alert(
          "Import loss report:\n\n" + [...new Set(report.warnings.map((w) => `\u2022 ${w.message}`))].join("\n")
        );
      }
    } catch (err) {
      statusEl.textContent = `\u26A0 Import failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  document.getElementById("btn-export-pptx")?.addEventListener("click", async () => {
    try {
      const { bytes } = await exportPptx(deck);
      await deliverBlob(
        "deck.pptx",
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        })
      );
    } catch (err) {
      statusEl.textContent = `\u26A0 PPTX export failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  restore();
  render();
  window.addEventListener("resize", render);
})();
