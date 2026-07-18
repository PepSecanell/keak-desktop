// openaiLive.ts — EXPERIMENTAL sibling of keakLive.ts. Same throwaway "how fast/how good does live
// speech-to-speech feel" test, but against OpenAI's Realtime API instead of Gemini Live. Lets Pep try the
// "ChatGPT live" voice for Keak AI and compare it to Gemini side by side (see the Live voice card in
// Settings). NOT wired into the real Ctrl+Alt flow.
//
// Auth: a WebView WebSocket can't set Authorization headers, so OpenAI accepts the key via subprotocols
// (openai-insecure-api-key.<key>). This needs a real sk- API key (keak_cu_openai_key) — the ChatGPT
// "sign in" subscription token does NOT work with the Realtime API.

const OPENAI_REALTIME_MODEL = "gpt-realtime";

export type KeakLiveLog = (msg: string) => void;

function b64FromInt16(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  const chunk = 0x8000; // chunk so String.fromCharCode doesn't blow the call stack on long buffers
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
function int16FromB64(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// Sequential 24kHz PCM16 playback queue so audio deltas play back-to-back without overlap.
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
  close() { this.ctx.close(); }
}

// Records `seconds` of mic audio as 24kHz PCM16 and appends it to the open Realtime session.
async function recordAndAppend(ws: WebSocket, seconds: number, onDone: () => void): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: 24000 });
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
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64FromInt16(pcm) }));
      if (Date.now() >= stopAt) { stopped = true; processor.onaudioprocess = null; resolve(); }
    };
  });
  processor.disconnect();
  source.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  await ctx.close();
  onDone();
}

// One full test turn: connect, record `seconds` of mic audio, ask for a reply, play it back, and log the
// time-to-first-audio-byte so it can be compared to Gemini Live and the real Ctrl+Alt pipeline.
export async function runOpenAILiveTest(seconds: number, log: KeakLiveLog): Promise<void> {
  const apiKey = (localStorage.getItem("keak_cu_openai_key") || "").trim();
  if (!apiKey.startsWith("sk-")) {
    log("No OpenAI API key. Settings, Connect your AI, OpenAI: paste a real sk- key from platform.openai.com (the ChatGPT sign-in token doesn't work for live voice), then try again.");
    return;
  }

  log("Connecting to OpenAI Realtime...");
  let ws: WebSocket;
  try {
    // GA Realtime API: no "openai-beta.realtime-v1" subprotocol (that triggers the retired beta shape).
    ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`, [
      "realtime",
      "openai-insecure-api-key." + apiKey,
    ]);
  } catch (e) { log("Couldn't open the connection: " + String(e)); return; }

  const player = new AudioPlayer();
  let sentAt = 0;
  let firstAudioAt = 0;
  let recording = false;
  let settled = false;

  await new Promise<void>((resolve) => {
    ws.onopen = () => {
      // GA Realtime session shape: audio config nests under session.audio.{input,output}; a fixed test turn
      // means server turn detection off (we commit + response.create ourselves).
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "You are Keak, a friendly voice assistant. Answer in 1-2 short spoken sentences. No markdown.",
          output_modalities: ["audio"],
          audio: {
            input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice: "alloy" },
          },
        },
      }));
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!msg) return;

      if (msg.type === "error") { log("OpenAI error: " + JSON.stringify(msg.error || msg)); return; }

      // session.created arrives right after connect — start recording then.
      if ((msg.type === "session.created" || msg.type === "session.updated") && !recording) {
        recording = true;
        log(`Connected. Recording ${seconds}s — speak now...`);
        recordAndAppend(ws, seconds, () => {
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          ws.send(JSON.stringify({ type: "response.create" }));
          sentAt = performance.now();
          log("Sent. Waiting for first audio back...");
        });
        return;
      }

      // Audio comes back as response.audio.delta (base64 PCM16 @ 24kHz).
      if ((msg.type === "response.audio.delta" || msg.type === "response.output_audio.delta") && msg.delta) {
        if (!firstAudioAt) {
          firstAudioAt = performance.now();
          log(`First audio byte in ${Math.round(firstAudioAt - sentAt)}ms`);
        }
        player.push(int16FromB64(msg.delta));
      }

      if (msg.type === "response.done") {
        log("Turn complete.");
        settled = true;
        ws.close();
        resolve();
      }
    };

    ws.onerror = () => { log("WebSocket error — check the OpenAI key and network."); settled = true; resolve(); };
    ws.onclose = (ev) => {
      if (!settled) { log(`Connection closed early. code=${ev.code} reason=${ev.reason || "(none)"}`); resolve(); }
    };
  });

  player.close();
}
