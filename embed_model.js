#!/usr/bin/env node
// embed_model.js
// Reads the ONNX model, base64-encodes it, and produces upscaler.dist.js
// with the model embedded as an inline Uint8Array.
//
// Usage: node embed_model.js

const fs = require('fs');
const path = require('path');

const ROOT        = __dirname;
const ONNX_FILE   = path.join(ROOT, 'Anime4K_Upscale_GAN_x2_M_fp16.onnx');
const SOURCE_FILE = path.join(ROOT, 'upscaler.js');
const OUT_FILE    = path.join(ROOT, 'upscaler.dist.js');

const MODEL_URL_LINE = /^\s*const MODEL_URL\s*=\s*['"][^'"]+['"];.*$/m;
const MODEL_URL_REF  = /\bMODEL_URL\b/g;

function main() {
    if (!fs.existsSync(ONNX_FILE)) {
        console.error(`ONNX file not found: ${ONNX_FILE}`);
        process.exit(1);
    }
    if (!fs.existsSync(SOURCE_FILE)) {
        console.error(`Source file not found: ${SOURCE_FILE}`);
        process.exit(1);
    }

    const onnxBytes = fs.readFileSync(ONNX_FILE);
    const b64 = onnxBytes.toString('base64');
    console.log(`Model size: ${(onnxBytes.length / 1024).toFixed(1)} KB  →  base64: ${(b64.length / 1024).toFixed(1)} KB`);

    const inlineDecl2 =
        `const MODEL_DATA = Uint8Array.from(atob('${b64}'), c => c.charCodeAt(0));`;

    let src = fs.readFileSync(SOURCE_FILE, 'utf8');

    if (!MODEL_URL_LINE.test(src)) {
        console.error('Could not find `const MODEL_URL = ...` in source. Aborting.');
        process.exit(1);
    }

    // Replace the MODEL_URL declaration with the embedded data
    src = src.replace(MODEL_URL_LINE, inlineDecl2);

    // Replace every reference to MODEL_URL with MODEL_DATA
    src = src.replace(MODEL_URL_REF, 'MODEL_DATA');

    fs.writeFileSync(OUT_FILE, src, 'utf8');
    console.log(`Written: ${OUT_FILE}`);
}

main();
