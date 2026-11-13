# Kokoro-82M v1.0 (ONNX), hosted with the game

- Model: Kokoro-82M by hexgrad, ONNX export by onnx-community (`onnx-community/Kokoro-82M-v1.0-ONNX` on Hugging Face). Licence: Apache-2.0.
- `onnx/model.onnx` (fp32, used with WebGPU) and `onnx/model_quantized.onnx` (q8, used on the CPU) are stored in parts because GitHub refuses files over 100 MB. `voice-worker.js` joins them while downloading. Sizes and SHA-256 of every file and part are in `manifest.json`.
- Checked before upload: both joined model files match the SHA-256 values onnx-community published (fp32 `8fbea51e…34cb`, q8 `fbae9257…a1478`); all 28 voice files are byte-identical to the ones in the official kokoro-js 1.2.1 package; `config.json` and `tokenizer_config.json` match the originals; `tokenizer.json` has the same content as the original (formatting differs).
- To host this folder somewhere else (for example an internal server), copy the whole folder and set `MODEL_BASE_URL` in `index.html` to its new address.
