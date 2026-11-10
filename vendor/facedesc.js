// ─────────────────────────────────────────────────────────────────────
// faceDescriptor(gray, w, h, box)  →  Float32Array(400) | null
//
// A tiny, dependency-free face descriptor used for 1:N identity matching.
//
// Why this and not a neural embedding: the only detector available offline
// is pico.js (Haar cascade). It gives a face box but no embedding, and no
// model weights can be downloaded reliably on this machine. So we build a
// descriptor from the aligned crop itself:
//
//   1. crop the box (+8% margin) and area-average it down to 32×32
//   2. z-score the crop  → kills global brightness/contrast differences
//   3. feature set:
//        • 16×16 downsampled patch (256 dims, weight 0.6)
//          → coarse facial structure (eye/eyebrow/mouth layout)
//        • HOG over 4×4 cells × 9 orientation bins (144 dims, weight 1.0)
//          → local edge structure, fairly robust to lighting
//   4. L2-normalise the concatenation → cosine similarity in [0,1]
//
// Same-person scores land high (≈0.6-0.85 for one reference image),
// different people land low. It is not FaceNet, but it is deterministic,
// runs at ~1ms, and needs no network.
//
// This file is loaded by BOTH sides:
//   server.js  → new Function(src + '; return faceDescriptor;')()
//   client.js  → fetched from /facedesc.js and eval'd the same way
// Never fork the algorithm: both sides must produce identical vectors.
// ─────────────────────────────────────────────────────────────────────
function faceDescriptor(gray, w, h, box) {
    if (!gray || !box || !(box.w > 0) || !(box.h > 0)) return null;

    const S = 32;
    const pad = 0.08 * box.w;
    const x0 = Math.max(0, Math.floor(box.x - pad));
    const y0 = Math.max(0, Math.floor(box.y - pad));
    const x1 = Math.min(w, Math.ceil(box.x + box.w + pad));
    const y1 = Math.min(h, Math.ceil(box.y + box.h + pad));
    if (x1 - x0 < 10 || y1 - y0 < 10) return null;

    // 1. area-average resample into an S×S patch
    const patch = new Float32Array(S * S);
    const dx = (x1 - x0) / S;
    const dy = (y1 - y0) / S;
    for (let j = 0; j < S; j++) {
        const ya = Math.floor(y0 + j * dy);
        const yb = Math.max(ya + 1, Math.floor(y0 + (j + 1) * dy));
        for (let i = 0; i < S; i++) {
            const xa = Math.floor(x0 + i * dx);
            const xb = Math.max(xa + 1, Math.floor(x0 + (i + 1) * dx));
            let sum = 0, n = 0;
            for (let y = ya; y < yb && y < y1; y++) {
                const row = y * w;
                for (let x = xa; x < xb && x < x1; x++) { sum += gray[row + x]; n++; }
            }
            patch[j * S + i] = n ? sum / n : 0;
        }
    }

    // 2. z-score (mean 0, unit variance) — removes exposure differences
    let mean = 0;
    for (let i = 0; i < patch.length; i++) mean += patch[i];
    mean /= patch.length;
    let variance = 0;
    for (let i = 0; i < patch.length; i++) {
        const d = patch[i] - mean;
        variance += d * d;
    }
    const std = Math.sqrt(variance / patch.length) || 1;
    for (let i = 0; i < patch.length; i++) patch[i] = (patch[i] - mean) / std;

    const feats = new Float32Array(256 + 144);

    // 3a. 16×16 coarse patch (2×2 box average of the z-scored 32×32)
    for (let j = 0; j < 16; j++) {
        for (let i = 0; i < 16; i++) {
            const a = patch[(2 * j) * S + 2 * i];
            const b = patch[(2 * j) * S + 2 * i + 1];
            const c = patch[(2 * j + 1) * S + 2 * i];
            const d = patch[(2 * j + 1) * S + 2 * i + 1];
            feats[j * 16 + i] = 0.6 * ((a + b + c + d) / 4);
        }
    }

    // 3b. HOG: 4×4 cells of 8×8 px, 9 unsigned orientation bins
    const CELLS = 4, BINS = 9;
    let o = 256;
    for (let cy = 0; cy < CELLS; cy++) {
        for (let cx = 0; cx < CELLS; cx++) {
            const hist = new Float32Array(BINS);
            for (let y = cy * 8; y < cy * 8 + 8; y++) {
                for (let x = cx * 8; x < cx * 8 + 8; x++) {
                    const xm = x > 0 ? x - 1 : x;
                    const xp = x < S - 1 ? x + 1 : x;
                    const ym = y > 0 ? y - 1 : y;
                    const yp = y < S - 1 ? y + 1 : y;
                    const gx = patch[y * S + xp] - patch[y * S + xm];
                    const gy = patch[yp * S + x] - patch[ym * S + x];
                    const mag = Math.sqrt(gx * gx + gy * gy);
                    if (mag < 1e-6) continue;
                    let ang = Math.atan2(gy, gx);            // -π..π
                    if (ang < 0) ang += Math.PI;             // unsigned: 0..π
                    let bin = Math.floor(ang / Math.PI * BINS);
                    if (bin >= BINS) bin = BINS - 1;
                    hist[bin] += mag;
                }
            }
            // per-cell L2 normalisation (standard HOG practice)
            let n2 = 0;
            for (let k = 0; k < BINS; k++) n2 += hist[k] * hist[k];
            n2 = Math.sqrt(n2) || 1;
            for (let k = 0; k < BINS; k++) feats[o++] = hist[k] / n2;
        }
    }

    // 4. global L2 normalisation → cosine similarity is just a dot product
    let norm = 0;
    for (let i = 0; i < feats.length; i++) norm += feats[i] * feats[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < feats.length; i++) feats[i] /= norm;
    return feats;
}

// Cosine similarity for two descriptors of equal length.
function faceSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    const n = a.length;
    for (let i = 0; i < n; i++) dot += a[i] * b[i];
    return dot;
}
