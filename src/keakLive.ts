// keakLive.ts — EXPERIMENTAL, throwaway branch (experiment/keak-live-gemini). Validates whether
// Gemini Live (true realtime speech-to-speech) feels meaningfully faster than the current
// record -> transcribe -> keak-assistant -> keak-tts chain used by the real Ctrl+Alt flow.
//
// Hardcoded prompt, no tool calls, no conversation history — just latency + voice-quality feel.
// NOT wired into the real Ctrl+Alt flow or answerWithOwnAI. Triggered only via a floating test
// button gated behind localStorage.keak_live_experiment === "1". Delete this file (and the few
// lines that render the test button) to remove the experiment entirely — nothing else depends on it.
//
// Uses the user's own connected Gemini key (keak_cu_gemini_key, same one "Connect your AI" already
// stores for the BYOK chat path in Overlay.tsx's answerWithOwnAI) — zero new cost, zero new setup
// if Gemini is already connected.

const GEMINI_MODEL = "models/gemini-3.1-flash-live-preview";

export type KeakLiveLog = (msg: string) => void;

function base64FromInt16(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function int16FromBase64(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// Sequential playback queue for 24kHz PCM16 chunks so audio deltas play back-to-back without
// overlapping or glitching, even though they arrive in separate WebSocket messages.
class AudioPlayer {
  private ctx = new AudioContext({ sampleRate: 24000 });
  private nextStart = 0;

  push(samples: Int16Array) {
    const float = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) float[i] = samples[i] / 32768;
    const buffer = this.ctx.createBuffer(1, float.length, 24000);
    buffer.copyToChannel(float, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + buffer.duration;
  }

  close() {
    this.ctx.close();
  }
}

// Records `seconds` of mic audio as 16kHz PCM16 and streams it to the already-open Gemini Live
// socket in realtimeInput.audio chunks. Uses ScriptProcessorNode (deprecated but universally
// supported) rather than an AudioWorklet module — fine for a throwaway timing test.
async function recordAndSend(ws: WebSocket, seconds: number, onSent: () => void): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(ctx.destination);

  let stopped = false;
  const stopAt = Date.now() + seconds * 1000;

  await new Promise<void>((resolve) => {
    processor.onaudioprocess = (e) => {
      if (stopped) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 32768 : s * 32767;
      }
      ws.send(JSON.stringify({
        realtimeInput: { audio: { data: base64FromInt16(pcm), mimeType: "audio/pcm;rate=16000" } },
      }));
      if (Date.now() >= stopAt) {
        stopped = true;
        processor.onaudioprocess = null;
        resolve();
      }
    };
  });

  processor.disconnect();
  source.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  await ctx.close();
  onSent();
}

// Runs one full test turn: connect, record `seconds` of mic audio, send it, play back the reply,
// and log the time-to-first-audio-byte so it can be compared against the real Ctrl+Alt pipeline.
export async function runKeakLiveTest(seconds: number, log: KeakLiveLog): Promise<void> {
  const apiKey = localStorage.getItem("keak_cu_gemini_key") || "";
  if (!apiKey) {
    log("No Gemini key connected. Settings -> Connect your AI -> Gemini -> paste a key from aistudio.google.com, then try again.");
    return;
  }

  log("Connecting to Gemini Live...");
  const ws = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`
  );

  const player = new AudioPlayer();
  let sentAt = 0;
  let firstAudioAt = 0;
  let settled = false;

  await new Promise<void>((resolve) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: GEMINI_MODEL,
          responseModalities: ["AUDIO"],
          systemInstruction: {
            parts: [{ text: "You are Keak, a friendly voice assistant. Answer in 1-2 short spoken sentences. No markdown." }],
          },
        },
      }));
    };

    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text();
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.error) { log("Gemini error: " + JSON.stringify(msg.error)); }

      if (msg.setupComplete) {
        log(`Setup complete. Recording ${seconds}s — speak now...`);
        await recordAndSend(ws, seconds, () => {
          sentAt = performance.now();
          log("Sent. Waiting for first audio back...");
        });
        return;
      }

      const parts = msg.serverContent?.modelTurn?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          if (!firstAudioAt) {
            firstAudioAt = performance.now();
            log(`First audio byte in ${Math.round(firstAudioAt - sentAt)}ms`);
          }
          player.push(int16FromBase64(p.inlineData.data));
        }
      }

      if (msg.serverContent?.turnComplete) {
        log("Turn complete.");
        settled = true;
        ws.close();
        resolve();
      }
    };

    ws.onerror = () => { log("WebSocket error — check the Gemini key and network."); settled = true; resolve(); };
    ws.onclose = (ev) => {
      if (!settled) { log(`Connection closed early. code=${ev.code} reason=${ev.reason || "(none)"}`); resolve(); }
    };
  });

  player.close();
}
