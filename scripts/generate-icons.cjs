// Simple script to generate placeholder PNG icons
// Run with: node scripts/generate-icons.cjs

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const iconsDir = path.join(__dirname, '..', 'icons');

// Ensure icons directory exists
fs.mkdirSync(iconsDir, { recursive: true });

// CRC32 implementation for PNG
let crcTable = null;
function getCRCTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }
  return crcTable;
}

function crc32(data) {
  let crc = 0xffffffff;
  const table = getCRCTable();
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function createPNG(size) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);  // width
  ihdrData.writeUInt32BE(size, 4);  // height
  ihdrData.writeUInt8(8, 8);        // bit depth
  ihdrData.writeUInt8(2, 9);        // color type (RGB)
  ihdrData.writeUInt8(0, 10);       // compression
  ihdrData.writeUInt8(0, 11);       // filter
  ihdrData.writeUInt8(0, 12);       // interlace
  const ihdr = createChunk('IHDR', ihdrData);

  // Create raw image data with filter bytes
  const rowSize = 1 + size * 3; // filter byte + RGB per pixel
  const rawData = Buffer.alloc(rowSize * size);

  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size / 2 - 1;
  const innerRadius = outerRadius * 0.75;

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowSize;
    rawData[rowStart] = 0; // no filter

    for (let x = 0; x < size; x++) {
      const pixelStart = rowStart + 1 + x * 3;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= outerRadius) {
        if (dist <= innerRadius) {
          // Inner circle - white
          rawData[pixelStart] = 255;
          rawData[pixelStart + 1] = 255;
          rawData[pixelStart + 2] = 255;

          // Draw clock hands
          const hourHandLength = innerRadius * 0.5;
          const minuteHandLength = innerRadius * 0.8;
          const handWidth = Math.max(1, size * 0.06);

          // Hour hand (pointing up)
          if (x >= cx - handWidth && x <= cx + handWidth && y >= cy - hourHandLength && y <= cy) {
            rawData[pixelStart] = 25;
            rawData[pixelStart + 1] = 118;
            rawData[pixelStart + 2] = 210;
          }

          // Minute hand (pointing right)
          if (y >= cy - handWidth && y <= cy + handWidth && x >= cx && x <= cx + minuteHandLength) {
            rawData[pixelStart] = 25;
            rawData[pixelStart + 1] = 118;
            rawData[pixelStart + 2] = 210;
          }

          // Center dot
          if (dist <= size * 0.08) {
            rawData[pixelStart] = 25;
            rawData[pixelStart + 1] = 118;
            rawData[pixelStart + 2] = 210;
          }
        } else {
          // Outer ring - blue
          rawData[pixelStart] = 25;
          rawData[pixelStart + 1] = 118;
          rawData[pixelStart + 2] = 210;
        }
      } else {
        // Outside - white (will be transparent in browser)
        rawData[pixelStart] = 255;
        rawData[pixelStart + 1] = 255;
        rawData[pixelStart + 2] = 255;
      }
    }
  }

  // Compress using zlib
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idat = createChunk('IDAT', compressed);

  // IEND chunk
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// Generate icons
const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  const png = createPNG(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath}`);
}

console.log('Icons generated successfully!');
