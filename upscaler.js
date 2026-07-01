// ==UserScript==
// @name         YouTube Anime4K ONNX Upscaler
// @namespace    YouTubeAnime4KUpscaler
// @version      1.0
// @description  Upscale YouTube anime videos using Anime4K GAN x2 M (fp16) via ONNX Runtime WASM
// @author       WifiLast
// @match        https://www.youtube.com/watch*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm.min.js
// ==/UserScript==

(function () {
    'use strict';

    // ---- TRUSTED TYPES BYPASS (YouTube security workaround) ----
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        if (!window.trustedTypes.defaultPolicy) {
            window.trustedTypes.createPolicy('default', {
                createHTML: (string) => string,
                createScriptURL: (string) => string,
                createScript: (string) => string,
            });
        }
    }

    // ---- SETTINGS ----
    // jsDelivr serves GitHub content with CORS headers — required for ONNX Runtime to fetch the model.
    // GitHub raw URLs (github.com/.../raw/...) are blocked by CORS and will NOT work.
    const MODEL_URL = 'https://cdn.jsdelivr.net/gh/WifiLast/anime4k_youtube_upscaler@main/Anime4K_Upscale_GAN_x2_M_fp16.onnx';
    const FPS_LIMIT = 30;   // Frames per second to attempt upscaling (lower = less GPU load)
    // ------------------

    let globalBoard = null;         // Overlay canvas element
    let globalMovOrig = null;       // Original YouTube <video> element
    let globalUpdateId = null;      // requestAnimationFrame handle
    let globalPreviousDelta = 0;
    let globalCurrentHref = window.location.href;

    const captureCanvas = document.createElement('canvas'); // Reused frame capture buffer
    let upscalerReady = false;
    let isRendering = false;        // Guards against overlapping async inference calls

    // ---- Anime4K ONNX Upscaler (ported from anime4k_upscale.js) ----
    class Anime4K {
        constructor() {
            this.currentSession = null;
        }

        async initialize() {
            if (typeof ort === 'undefined' || !ort.env) {
                console.error('[Anime4K YT] ONNX Runtime not loaded.');
                return false;
            }
            // Disable WASM worker proxy — YouTube's CSP blocks script execution in sandboxed
            // about:blank frames, which is how ort spawns its WASM worker by default.
            if (ort.env.wasm) {
                ort.env.wasm.proxy = false;
                ort.env.wasm.numThreads = 1;
                ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
            }
            console.log('[Anime4K YT] Backend: WASM');
            return true;
        }

        float32ToFloat16(float32Array) {
            const uint16Array = new Uint16Array(float32Array.length);
            for (let i = 0; i < float32Array.length; i++) {
                const floatView = new Float32Array(1);
                const int32View = new Int32Array(floatView.buffer);
                floatView[0] = float32Array[i];
                const x = int32View[0];
                let bits = (x >> 16) & 0x8000;
                let m = (x >> 12) & 0x07ff;
                const e = (x >> 23) & 0xff;
                if (e >= 103) { bits |= ((e - 112) << 10) | (m >> 1); }
                else { bits |= (m >> (114 - e)); }
                uint16Array[i] = bits;
            }
            return uint16Array;
        }

        float16ToFloat32(uint16Array) {
            const float32Array = new Float32Array(uint16Array.length);
            for (let i = 0; i < uint16Array.length; i++) {
                const bits = uint16Array[i];
                const s = (bits >> 15) & 0x1;
                const e = (bits >> 10) & 0x1f;
                const m = bits & 0x3ff;
                if (e === 0) float32Array[i] = (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
                else if (e === 31) float32Array[i] = m === 0 ? (s ? -Infinity : Infinity) : NaN;
                else float32Array[i] = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
            }
            return float32Array;
        }

        getSessionMetadata(session, inputName) {
            return session?.inputMetadata?.[inputName] || session?.inputs?.[inputName] || null;
        }

        getChannelsNeeded(session, inputName) {
            const metadata = this.getSessionMetadata(session, inputName);
            const dims = metadata?.dimensions || metadata?.dims || metadata?.shape || [];
            const c = Number(dims[1]);
            return (Number.isFinite(c) && c > 0) ? c : 3;
        }

        expectsFloat16(session, inputName) {
            const metadata = this.getSessionMetadata(session, inputName);
            if (!metadata) return true;
            const type = metadata.type;
            return (typeof type === 'string' && type.includes('float16')) || (type === 10);
        }

        async getSession() {
            if (this.currentSession) return this.currentSession;
            console.log('[Anime4K YT] Loading model on wasm...');
            this.currentSession = await ort.InferenceSession.create(MODEL_URL, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            });
            console.log('[Anime4K YT] Model loaded successfully on WASM.');
            return this.currentSession;
        }

        async upscaleFrame(videoEl) {
            const width = videoEl.videoWidth;
            const height = videoEl.videoHeight;
            if (!width || !height) return null;

            // Capture current video frame
            captureCanvas.width = width;
            captureCanvas.height = height;
            const captureCtx = captureCanvas.getContext('2d');
            captureCtx.drawImage(videoEl, 0, 0, width, height);

            const session = await this.getSession();
            const inputName = session.inputNames[0];
            const channelsNeeded = this.getChannelsNeeded(session, inputName);
            const forceFloat16 = this.expectsFloat16(session, inputName);

            const { data } = captureCtx.getImageData(0, 0, width, height);
            const totalPixels = width * height;
            const inputBuffer = new Float32Array(totalPixels * channelsNeeded);

            // Pack pixels into planar NCHW format
            for (let i = 0; i < totalPixels; i++) {
                inputBuffer[i] = data[i * 4] / 255.0; // R
                inputBuffer[totalPixels + i] = data[i * 4 + 1] / 255.0; // G
                inputBuffer[2 * totalPixels + i] = data[i * 4 + 2] / 255.0; // B
                if (channelsNeeded === 4) inputBuffer[3 * totalPixels + i] = data[i * 4 + 3] / 255.0;
            }

            let inputTensor;
            if (forceFloat16) {
                const hBuffer = (typeof Float16Array !== 'undefined')
                    ? new Float16Array(inputBuffer)
                    : this.float32ToFloat16(inputBuffer);
                inputTensor = new ort.Tensor('float16', hBuffer, [1, channelsNeeded, height, width]);
            } else {
                inputTensor = new ort.Tensor('float32', inputBuffer, [1, channelsNeeded, height, width]);
            }

            const results = await session.run({ [inputName]: inputTensor });
            const outputTensor = results[Object.keys(results)[0]];
            let outputData = outputTensor.data;

            if (outputTensor.type === 'float16') {
                const F16 = typeof Float16Array !== 'undefined' ? Float16Array : Object;
                if (!(outputData instanceof F16)) {
                    outputData = this.float16ToFloat32(outputData);
                }
            }

            const [, outC, outH, outW] = outputTensor.dims;
            const outCanvas = document.createElement('canvas');
            outCanvas.width = outW;
            outCanvas.height = outH;
            const outCtx = outCanvas.getContext('2d');
            const outImgData = outCtx.createImageData(outW, outH);
            const outPixels = outH * outW;

            for (let i = 0; i < outPixels; i++) {
                outImgData.data[i * 4] = Math.min(255, Math.max(0, outputData[i] * 255));
                outImgData.data[i * 4 + 1] = Math.min(255, Math.max(0, outputData[outPixels + i] * 255));
                outImgData.data[i * 4 + 2] = Math.min(255, Math.max(0, outputData[2 * outPixels + i] * 255));
                outImgData.data[i * 4 + 3] = (outC === 4)
                    ? Math.min(255, Math.max(0, outputData[3 * outPixels + i] * 255))
                    : 255;
            }
            outCtx.putImageData(outImgData, 0, 0);
            return outCanvas;
        }
    }

    const upscaler = new Anime4K();

    // ---- Canvas injection (adapted from upscale_anime4k.js / Bilibili_Anime4K) ----

    async function getVideoTag() {
        while (document.getElementsByTagName('video').length === 0) {
            await new Promise(r => setTimeout(r, 500));
        }
        // Prefer the main YouTube video element
        return document.querySelector('video.html5-main-video') || document.getElementsByTagName('video')[0];
    }

    async function injectCanvas() {
        console.log('[Anime4K YT] Injecting canvas...');

        if (globalUpdateId) {
            cancelAnimationFrame(globalUpdateId);
            globalUpdateId = null;
        }

        globalMovOrig = await getVideoTag();

        // YouTube keeps the video inside .html5-video-container
        const container = globalMovOrig.closest('.html5-video-container') || globalMovOrig.parentElement;
        container.style.position = 'relative';

        // Remove stale canvas from a previous navigation
        const existing = document.getElementById('anime4k-yt-canvas');
        if (existing) existing.remove();

        globalBoard = document.createElement('canvas');
        globalBoard.id = 'anime4k-yt-canvas';
        globalBoard.style.cssText = [
            'position:absolute',
            'top:0', 'left:0',
            'width:100%', 'height:100%',
            'pointer-events:none',
            'z-index:10'
        ].join(';');
        container.appendChild(globalBoard);

        // Re-listen for metadata changes (resolution switches mid-video)
        globalMovOrig.addEventListener('loadedmetadata', () => {
            console.log('[Anime4K YT] Video resolution changed, canvas will adapt.');
        }, true);

        console.log('[Anime4K YT] Canvas injected.');
    }

    // ---- Render loop ----

    async function render(currentDelta) {
        globalUpdateId = requestAnimationFrame(render);

        // FPS limiter (mirrors Bilibili_Anime4K approach)
        const delta = currentDelta - globalPreviousDelta;
        if (FPS_LIMIT && delta < 1000 / FPS_LIMIT) return;
        globalPreviousDelta = currentDelta;

        if (!globalMovOrig || !globalBoard || !upscalerReady) return;
        if (globalMovOrig.paused || globalMovOrig.ended || !globalMovOrig.videoWidth) return;
        if (isRendering) return; // Drop frame; previous inference still running

        isRendering = true;
        try {
            const upscaled = await upscaler.upscaleFrame(globalMovOrig);
            if (upscaled) {
                globalBoard.width = upscaled.width;
                globalBoard.height = upscaled.height;
                globalBoard.getContext('2d').drawImage(upscaled, 0, 0);
            }
        } catch (err) {
            console.error('[Anime4K YT] Render error:', err);
            // Clear the session so getSession() can recreate it (e.g. after a GPU device loss)
            upscaler.currentSession = null;
        }
        isRendering = false;
    }

    // ---- Init ----

    async function init() {
        console.log('[Anime4K YT] Starting...');

        upscalerReady = await upscaler.initialize();
        if (!upscalerReady) {
            console.warn('[Anime4K YT] Upscaler init failed, aborting.');
            return;
        }

        await injectCanvas();
        globalUpdateId = requestAnimationFrame(render);
    }

    // ---- YouTube SPA navigation (mirrors bilibili_script.js / yt-navigate-finish pattern) ----

    function onNavigate() {
        if (window.location.pathname.startsWith('/watch') && globalCurrentHref !== window.location.href) {
            console.log('[Anime4K YT] Navigation detected, re-injecting...');
            globalCurrentHref = window.location.href;
            injectCanvas().then(() => {
                if (!globalUpdateId) globalUpdateId = requestAnimationFrame(render);
            });
        }
    }

    window.addEventListener('yt-navigate-finish', onNavigate, true);

    if (window.location.pathname.startsWith('/watch')) {
        init();
    }

})();
