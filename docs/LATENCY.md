# Recording and response latency (1.0.1)

## Changes

- Transcribe completed speech during Start/Stop recording instead of waiting to process the entire recording after Stop. Preserve the selected model, language, precision and decoding algorithm.
- Use voice detection for boundaries while retaining original audio between boundaries. Short replies and the final partial AudioWorklet/VAD frame survive. Digital silence does not create unnecessary requests; quiet undetected ranges retain the existing RMS fallback threshold of 0.002.
- Load the selected local model asynchronously before the first segment. Keep one model cached, releasing references to unused recognizers when switching models.
- On Apple Silicon, Parakeet uses up to four available CPU threads. Other models and platforms retain up to two. No model/quantization downgrade was introduced.
- Keep failed speech segments in memory for explicit retry. Retry preserves ordering and does not retranscribe successful segments. Do not suggest an answer from an incomplete recording.
- Reject new recordings, input/model changes and Respond while transcription is pending. Tag each recording to avoid mixing recordings or delivering a delayed suggestion into a different chat.
- Follow actual PowerPoint slide ordering and speaker-note relationships, including reordered decks.
- Flush the transcript on ordinary quit. Align the archive preflight check with the actual storage limit.
- Put unchanged notes and documents first in model requests, before history and the changing transcript/question. Claude API requests mark that exact stable block for five-minute prompt caching. OpenAI and Gemini can use their implicit prefix caches. Account adapters receive the same full material; they do not receive unsupported HTTP cache parameters.
- Memoize the document preamble until context changes. Keep existing context limits; no summarization, embedding retrieval, or new content truncation is used to obtain the latency improvement.
- Use one cancellable deadline for the entire AssemblyAI upload/submission/poll cycle. Never display provider error bodies that can contain credentials or private text.

Cloud transcription now sends completed segments while recording is active. Audio is never written to disk. Failed audio is lost on quit or process failure, and Clear deliberately discards it.

## Local measurement

Measured on the development Apple Silicon Mac using the existing Parakeet TDT v2 int8 model and its public `test_wavs/0.wav` fixture. Three repetitions of the 7.435-second clip, with one-second gaps, form a 24.305-second recording. The benchmark replays audio at real-time speed for the new pipeline, then measures the remaining work at Stop. The baseline processes all segments after Stop. Models are warm for this comparison.

| Measurement | Two threads | Four threads |
| --- | ---: | ---: |
| Model loading | 954 ms | 1,067 ms |
| Warm decoding of the 7.435 s clip | 248 ms | 174 ms |
| Baseline transcription work after Stop | 769 ms | 543 ms |
| New remaining transcription work after Stop | 311 ms | 242 ms |

The pipeline change reduced Stop-to-transcript time by about 60% at two threads in this run. Including the measured thread tuning, the comparison with the old two-thread baseline was about 69%. These are single-fixture measurements, not production percentiles or end-to-end answer latency. The benchmark excludes cloud network latency and AI answer generation.

The two-thread and four-thread runs produced identical text for corresponding segments. Old and new segmentation differed in punctuation and the spelling of the proper noun “Phoebe”/“Phebe.” All sentences were retained, but this is not proof of equal word-error rate across real meetings. A representative consented corpus covering the user's languages, accents, noise and meeting vocabulary is still needed for that claim.

Run the reproducible harness with a supported local model and a 16 kHz WAV:

```sh
node scripts/benchmark-speech.js MODEL_DIRECTORY WAV_FILE 2
node scripts/benchmark-speech.js MODEL_DIRECTORY WAV_FILE 4
```

No microphone, account credentials, or cloud inference is used by this benchmark. It prints timing and transcript comparisons as JSON. Fixture copies and downloaded benchmark weights are not shipped with the app.

## Research behind the decisions

- [sherpa-onnx non-streaming JavaScript API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_non_streaming_asr.html) provides asynchronous recognizer loading and decoding. [Its microphone example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_vad_asr_non_streaming_moonshine_microphone.js) combines voice detection with an offline recognizer. This supports overlapping capture with recognition while retaining the same model.
- [ONNX Runtime threading](https://onnxruntime.ai/docs/performance/tune-performance/threading.html) describes operator-level parallelism and contention tradeoffs. We measured two versus four threads instead of assuming that the maximum available count would be faster.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), and [Gemini caching](https://ai.google.dev/gemini-api/docs/caching) describe reuse of matching prompt prefixes. Stable references belong before changing content. Cache eligibility, expiry, routing, and hits remain provider-controlled. The first request still processes the full input; cache writes may carry provider-specific pricing.
- [NVIDIA's Parakeet model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) describes the existing English model. GPU/batched throughput figures are not treated as desktop microphone latency measurements.

## Verification

Validated on macOS arm64: 154 unit tests and 48 Electron desktop checks passed, with no skipped tests. The forced-exit recovery check also passed using a temporary encrypted profile. Five packaged-app checks passed: source/runtime matching, native speech loading, PDF extraction, encrypted storage, and bundled account sign-in/cancellation. The app retains its existing stable local signing identity.

Unit regressions cover sample continuity, bounded recording buffers, partial-frame flushing, short replies, ordered retries, stale-work cancellation, model warmup reuse, thread limits, stable context placement, and cancellation of cloud polling. Desktop checks exercise the real Electron bridge, live fake-device audio, recording while hidden, retries, model-change races, missing devices and automatic answer delivery. Existing account, screenshot, encrypted storage and crash-recovery checks remain part of validation.

Live provider cache hits and latency were not measured with personal credentials. No guarantee of perfect transcription or constant latency for unlimited context is made.
