// Anime4K WebGPU Upscaling Integration for Fake HDR Project
// Ported from the standalone WebGPU implementation

export class Anime4K {
    constructor() {
        this.MODEL_CANDIDATES = [
            { file: 'models/anime4k/Anime4K_Upscale_GAN_x2_M_fp16.onnx', label: 'GAN x2 M', detail: 'Balanced x2 quality', backend: 'webgpu' }
        ];
        this.MAX_WEBGPU_STORAGE_BUFFERS = 64;
        this.currentSessionInfo = null;
        this.webgpuAvailable = false;
        this.webgpuConfigured = false;
        this.lastImageSignature = '';
        this.onStatus = null;
    }

    async initialize() {
        if (typeof ort === 'undefined' || !ort.env) {
            console.error('ONNX Runtime not loaded');
            return false;
        }

        if (ort.env.wasm) {
            const threads = Math.min(4, Math.max(1, navigator.hardwareConcurrency || 1));
            ort.env.wasm.numThreads = threads;
        }

        this.webgpuAvailable = await this.configureWebGpu();
        return this.webgpuAvailable;
    }

    async configureWebGpu() {
        if (this.webgpuConfigured) return this.webgpuAvailable;
        this.webgpuConfigured = true;

        if (typeof navigator === 'undefined' || !navigator.gpu || !ort?.env?.webgpu) {
            return false;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return false;

            const supportedBuffers = adapter.limits?.maxStorageBuffersPerShaderStage || 8;
            const requestedBuffers = Math.min(this.MAX_WEBGPU_STORAGE_BUFFERS, supportedBuffers);
            const requiredLimits = {};

            if (requestedBuffers > 8) {
                requiredLimits.maxStorageBuffersPerShaderStage = requestedBuffers;
            }

            ort.env.webgpu.deviceOptions = {
                powerPreference: 'high-performance',
                requiredLimits
            };

            return true;
        } catch (error) {
            console.warn('WebGPU adapter setup failed, falling back to WASM.', error);
            return false;
        }
    }

    float32ToFloat16(float32Array) {
        const uint16Array = new Uint16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const val = float32Array[i];
            const floatView = new Float32Array(1);
            const int32View = new Int32Array(floatView.buffer);
            floatView[0] = val;
            const x = int32View[0];
            let bits = (x >> 16) & 0x8000;
            let m = (x >> 12) & 0x07ff;
            const e = (x >> 23) & 0xff;
            if (e >= 103) {
                bits |= ((e - 112) << 10) | (m >> 1);
            } else {
                bits |= (m >> (114 - e));
            }
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
            if (e === 0) {
                float32Array[i] = (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
            } else if (e === 31) {
                float32Array[i] = m === 0 ? (s ? -Infinity : Infinity) : NaN;
            } else {
                float32Array[i] = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
            }
        }
        return float32Array;
    }

    getPreferredCandidates(width, height) {
        const pixels = width * height;
        const gpuModels = this.MODEL_CANDIDATES.filter(c => c.backend === 'webgpu');
        const cpuModels = this.MODEL_CANDIDATES.filter(c => c.backend === 'wasm');

        if (!this.webgpuAvailable) return cpuModels;

        // Priority logic
        return [...gpuModels, ...cpuModels];
    }

    getSessionMetadata(session, inputName) {
        return session?.inputMetadata?.[inputName] || session?.inputs?.[inputName] || null;
    }

    getChannelsNeeded(session, inputName) {
        const metadata = this.getSessionMetadata(session, inputName);
        const dims = metadata?.dimensions || metadata?.dims || metadata?.shape || [];
        const rawChannelCount = Number(dims[1]);
        return (Number.isFinite(rawChannelCount) && rawChannelCount > 0) ? rawChannelCount : 3;
    }

    expectsFloat16(session, inputName) {
        const metadata = this.getSessionMetadata(session, inputName);
        if (!metadata) return true;
        const type = metadata.type;
        return (typeof type === 'string' && type.includes('float16')) || (type === 10);
    }

    async createSession(width, height) {
        const signature = `${width}x${height}`;
        if (this.currentSessionInfo && this.lastImageSignature === signature) {
            return this.currentSessionInfo;
        }

        const candidates = this.getPreferredCandidates(width, height);
        let lastError = null;

        for (const candidate of candidates) {
            const sessionOptions = {
                executionProviders: [candidate.backend],
                graphOptimizationLevel: 'all'
            };

            try {
                if (this.onStatus) this.onStatus(`Loading ${candidate.label} (${candidate.backend})...`);
                const session = await ort.InferenceSession.create(candidate.file, sessionOptions);
                this.currentSessionInfo = { key: `${candidate.backend}:${candidate.file}`, candidate, session };
                this.lastImageSignature = signature;
                return this.currentSessionInfo;
            } catch (error) {
                lastError = error;
                console.warn(`Failed to load ${candidate.file} on ${candidate.backend}`, error);
            }
        }
        throw lastError || new Error('Unable to create Anime4K session');
    }

    async upscale(canvas) {
        const { width, height } = canvas;
        const sessionInfo = await this.createSession(width, height);
        const session = sessionInfo.session;
        const inputName = session.inputNames[0];
        const channelsNeeded = this.getChannelsNeeded(session, inputName);
        const forceFloat16 = this.expectsFloat16(session, inputName);

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, width, height);
        const { data } = imageData;

        const totalPixels = width * height;
        const inputBuffer = new Float32Array(totalPixels * channelsNeeded);

        // Planar packing
        for (let i = 0; i < totalPixels; i++) {
            inputBuffer[i] = data[i * 4] / 255.0;
            inputBuffer[totalPixels + i] = data[i * 4 + 1] / 255.0;
            inputBuffer[2 * totalPixels + i] = data[i * 4 + 2] / 255.0;
            if (channelsNeeded === 4) inputBuffer[3 * totalPixels + i] = data[i * 4 + 3] / 255.0;
        }

        let inputTensor;
        if (forceFloat16) {
            let hBuffer = (typeof Float16Array !== 'undefined') ? new Float16Array(inputBuffer) : this.float32ToFloat16(inputBuffer);
            inputTensor = new ort.Tensor('float16', hBuffer, [1, channelsNeeded, height, width]);
        } else {
            inputTensor = new ort.Tensor('float32', inputBuffer, [1, channelsNeeded, height, width]);
        }

        if (this.onStatus) this.onStatus(`Running Neural Upscale...`);
        const results = await session.run({ [inputName]: inputTensor });
        const outputTensor = results[Object.keys(results)[0]];
        let outputData = outputTensor.data;
        if (outputTensor.type === 'float16') {
            if (!(outputData instanceof (typeof Float16Array !== 'undefined' ? Float16Array : Object))) {
                outputData = this.float16ToFloat32(outputData);
            }
        }
        const [outB, outC, outH, outW] = outputTensor.dims;

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
            outImgData.data[i * 4 + 3] = (outC === 4) ? Math.min(255, Math.max(0, outputData[3 * outPixels + i] * 255)) : 255;
        }
        outCtx.putImageData(outImgData, 0, 0);
        return outCanvas;
    }
}
