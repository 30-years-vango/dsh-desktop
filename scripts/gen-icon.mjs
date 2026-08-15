/**
 * gen-icon.mjs
 * 生成 DeepSeek 鲸鱼应用图标（使用 DSH 前端自带的官方 favicon.svg）：
 *   - 白色鲸鱼 + DeepSeek 蓝(#4D6BFE)圆角渐变底
 *   - 输出 resources/icon.ico（多尺寸，NSIS/窗口图标）和 src/assets/icon.png（托盘/窗口）
 *
 * 依赖：复用 resources/dsh 内嵌依赖中的 sharp 做 SVG→PNG 渲染。
 * 用法：node scripts/gen-icon.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icoPath = path.join(root, "resources", "icon.ico");
const pngPath = path.join(root, "src", "assets", "icon.png");

const WHALE_SVG = path.join(
  root,
  "resources",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-web-frontend",
  "dist",
  "favicon.svg"
);
const SHARP_DIR = path.join(root, "resources", "dsh", "node_modules", "sharp");

const require = createRequire(import.meta.url);
const sharp = require(SHARP_DIR);

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const WHALE_RATIO = 0.76; // 鲸鱼占图标的比例
const BRAND_BLUE_TOP = [0x4d, 0x6b, 0xfe];
const BRAND_BLUE_BOTTOM = [0x3b, 0x51, 0xe8];

/* ── PNG 编码（纯 JS） ────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ── 绘制 ─────────────────────────────────────────────────── */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** DeepSeek 蓝圆角渐变背景 */
function drawBackground(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;
  const aa = Math.max(1, size / 256);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = (y * size + x) * 4;
      const qx = Math.max(Math.abs(px - cx) - (cx - radius), 0);
      const qy = Math.max(Math.abs(py - cy) - (cy - radius), 0);
      const dist = Math.hypot(qx, qy);
      const cover = 1 - smoothstep(-aa / 2, aa / 2, dist - radius);
      const t = y / (size - 1);
      rgba[i] = Math.round(BRAND_BLUE_TOP[0] + (BRAND_BLUE_BOTTOM[0] - BRAND_BLUE_TOP[0]) * t);
      rgba[i + 1] = Math.round(BRAND_BLUE_TOP[1] + (BRAND_BLUE_BOTTOM[1] - BRAND_BLUE_TOP[1]) * t);
      rgba[i + 2] = Math.round(BRAND_BLUE_TOP[2] + (BRAND_BLUE_BOTTOM[2] - BRAND_BLUE_TOP[2]) * t);
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return rgba;
}
/** 白鲸像素合成到背景上 */
function composite(bg, size, whaleRgba, whaleSize) {
  const offset = Math.round((size - whaleSize) / 2);
  const out = Buffer.from(bg);
  for (let y = 0; y < whaleSize; y++) {
    for (let x = 0; x < whaleSize; x++) {
      const ws = (y * whaleSize + x) * 4;
      const a = whaleRgba[ws + 3];
      if (a === 0) continue;
      const oy = y + offset;
      const ox = x + offset;
      if (oy < 0 || oy >= size || ox < 0 || ox >= size) continue;
      const di = (oy * size + ox) * 4;
      const t = a / 255;
      out[di] = Math.round(out[di] + (255 - out[di]) * t);
      out[di + 1] = Math.round(out[di + 1] + (255 - out[di + 1]) * t);
      out[di + 2] = Math.round(out[di + 2] + (255 - out[di + 2]) * t);
      if (out[di + 3] < a) out[di + 3] = a;
    }
  }
  return out;
}

/** 渲染白色鲸鱼（透明底） */
async function renderWhale(size) {
  let svg = readFileSync(WHALE_SVG, "utf8");
  svg = svg.replace(/<style>[\s\S]*?<\/style>/g, ""); // 去掉媒体查询样式
  svg = svg.replace(/fill="#000"/g, 'fill="#ffffff"'); // 鲸鱼固定为白色
  const big = await sharp(Buffer.from(svg)).resize(1024, 1024).png().toBuffer();
  const { data, info } = await sharp(big).resize(size, size, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  return { data, size: info.width };
}

/* ── ICO 封装 ─────────────────────────────────────────────── */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { s, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((im) => im.png)]);
}

async function main() {
  const images = [];
  for (const size of SIZES) {
    const bg = drawBackground(size);
    const whaleSize = Math.max(8, Math.round(size * WHALE_RATIO));
    const { data } = await renderWhale(whaleSize);
    const composed = composite(bg, size, data, whaleSize);
    images.push({ s: size, png: encodePng(size, size, composed) });
    console.log(`[gen-icon] ${size}x${size} 完成`);
  }
  mkdirSync(path.dirname(icoPath), { recursive: true });
  mkdirSync(path.dirname(pngPath), { recursive: true });
  writeFileSync(icoPath, buildIco(images));
  writeFileSync(pngPath, images.find((im) => im.s === 256).png);
  console.log(`[gen-icon] 已生成 ${icoPath}`);
  console.log(`[gen-icon] 已生成 ${pngPath}`);
}

main().catch((err) => {
  console.error("[gen-icon] 失败:", err);
  process.exit(1);
});
