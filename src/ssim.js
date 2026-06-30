// Structural Similarity (SSIM) on a single (luma) channel — the perceptual
// metric jpeg-recompress uses to decide "is this quality good enough?". This is
// what lets us replicate 2.9's adaptive per-file JPEG compression instead of
// slapping a fixed quality on every image.
//
// Standard Wang et al. SSIM: 11x11 Gaussian window (sigma 1.5), K1=0.01,
// K2=0.03, with the reference implementation's automatic downsampling for large
// images (keeps it fast and matches MATLAB ssim.m / most libraries).

const L = 255;
const C1 = (0.01 * L) ** 2; // 6.5025
const C2 = (0.03 * L) ** 2; // 58.5225
const RADIUS = 5; // 11-tap window

const KERNEL = (() => {
  const sigma = 1.5;
  const k = new Float64Array(2 * RADIUS + 1);
  let sum = 0;
  for (let i = -RADIUS; i <= RADIUS; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + RADIUS] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
})();

/**
 * Convert interleaved RGB(A) (or grayscale) bytes to a Float32 luma plane.
 * Rec.601 luma, matching JPEG's own Y channel.
 * @param {Buffer|Uint8Array} buf
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @returns {Float32Array}
 */
export function toLuma(buf, width, height, channels) {
  const n = width * height;
  const out = new Float32Array(n);
  if (channels >= 3) {
    for (let i = 0, p = 0; i < n; i++, p += channels) {
      out[i] = 0.299 * buf[p] + 0.587 * buf[p + 1] + 0.114 * buf[p + 2];
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += channels) out[i] = buf[p];
  }
  return out;
}

function blurH(src, w, h) {
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -RADIUS; t <= RADIUS; t++) {
        let xx = x + t;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        acc += src[row + xx] * KERNEL[t + RADIUS];
      }
      dst[row + x] = acc;
    }
  }
  return dst;
}

function blurV(src, w, h) {
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -RADIUS; t <= RADIUS; t++) {
        let yy = y + t;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        acc += src[(yy * w + x)] * KERNEL[t + RADIUS];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

const gblur = (src, w, h) => blurV(blurH(src, w, h), w, h);

function downsample(src, w, h, f) {
  if (f <= 1) return { data: src, w, h };
  const nw = Math.floor(w / f);
  const nh = Math.floor(h / f);
  const out = new Float32Array(nw * nh);
  const inv = 1 / (f * f);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * w + x * f;
        for (let dx = 0; dx < f; dx++) s += src[row + dx];
      }
      out[y * nw + x] = s * inv;
    }
  }
  return { data: out, w: nw, h: nh };
}

/**
 * Mean SSIM between two equal-size luma planes (0..1, 1 == identical).
 * @param {Float32Array} a reference luma
 * @param {Float32Array} b comparison luma
 * @param {number} width
 * @param {number} height
 * @param {{ downsample?: boolean }} [opts]
 * @returns {number}
 */
export function ssim(a, b, width, height, opts = {}) {
  const auto = opts.downsample !== false;
  const f = auto ? Math.max(1, Math.round(Math.min(width, height) / 256)) : 1;
  const A = downsample(a, width, height, f);
  const B = downsample(b, width, height, f);
  const w = A.w;
  const h = A.h;
  const n = w * h;
  const x = A.data;
  const y = B.data;

  const x2 = new Float32Array(n);
  const y2 = new Float32Array(n);
  const xy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x2[i] = x[i] * x[i];
    y2[i] = y[i] * y[i];
    xy[i] = x[i] * y[i];
  }

  const mux = gblur(x, w, h);
  const muy = gblur(y, w, h);
  const sxx = gblur(x2, w, h);
  const syy = gblur(y2, w, h);
  const sxy = gblur(xy, w, h);

  // Average over the "valid" interior (drop the window border), unless the image
  // is too small for a border in which case average everything.
  const border = w > 2 * RADIUS + 1 && h > 2 * RADIUS + 1 ? RADIUS : 0;
  let sum = 0;
  let cnt = 0;
  for (let yy = border; yy < h - border; yy++) {
    for (let xx = border; xx < w - border; xx++) {
      const i = yy * w + xx;
      const mx = mux[i];
      const my = muy[i];
      const mx2 = mx * mx;
      const my2 = my * my;
      const mxy = mx * my;
      const vx = sxx[i] - mx2;
      const vy = syy[i] - my2;
      const vxy = sxy[i] - mxy;
      sum += ((2 * mxy + C1) * (2 * vxy + C2)) / ((mx2 + my2 + C1) * (vx + vy + C2));
      cnt++;
    }
  }
  return cnt ? sum / cnt : 1;
}
