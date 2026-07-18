// liveKeak.ts — the REAL live voice for Keak AI (not the throwaway Settings test). A LiveKeak session
// opens a realtime speech-to-speech connection to the user's connected provider (Gemini Live or OpenAI
// Realtime), streams the mic in, and plays Keak's spoken reply back the instant you stop — no
// record -> transcribe -> LLM -> TTS chain. It also pulls text transcripts of both sides so the overlay
// can show captions and the app can keep history + Memory.
//
// Two turn modes:
//  - "ptt"      : push-to-talk. The caller opens the session, streams while the key is held, and calls
//                 finishTurn() on release. (Ctrl+Alt.)
//  - "handsfree": the session runs its own silence detector and calls finishTurn() itself after ~1.2s of
//                 quiet. (Wake word / orb click.)
//
// Providers: Gemini needs a Gemini key (keak_cu_gemini_key), OpenAI needs a real sk- key
// (keak_cu_openai_key). Any other provider has no realtime API, so the caller falls back to the classic flow.

const GEMINI_MODEL = "models/gemini-3.1-flash-live-preview";
const OPENAI_REALTIME_MODEL = "gpt-realtime";

export type LiveProvider = "gemini" | "openai";
export type LiveMode = "ptt" | "handsfree";

export type LiveHandlers = {
  onListening?: () => void;                         // mic open, user can speak
  onResponding?: () => void;                        // first audio coming back
  onUserText?: (text: string) => void;              // running transcript of what the user said
  onKeakText?: (text: string) => void;              // running transcript of Keak's spoken reply
  onDone?: (userText: string, keakText: string) => void; // turn finished
  onError?: (msg: string) => void;
  // The live model can call a tool mid-turn to look something up (e.g. search the Second Brain). Return the
  // result as a short string; the model then keeps talking with it. Providing this enables the search tool.
  onToolCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
};

// The one tool the live model can call: search the user's Second Brain for anything it needs to answer.
const BRAIN_TOOL = {
  name: "search_second_brain",
  description: "Search the user's connected Second Brain (their notes, files, projects, people, facts) for anything you need to answer their question. Use it whenever they ask about their own stuff or something you don't already know.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "what to look for" } },
    required: ["query"],
  },
};

function b64FromInt16(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  return btoa(binary);
}
function int16FromB64(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// Sequential PCM16 playback queue so audio deltas play back-to-back without gaps.
class AudioPlayer {
  private ctx: AudioContext;
  private nextStart = 0;
  private stopped = false;
  constructor(sampleRate: number) { this.ctx = new AudioContext({ sampleRate }); }
  push(samples: Int16Array, sampleRate: number) {
    if (this.stopped) return;
    const float = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) float[i] = samples[i] / 32768;
    const buffer = this.ctx.createBuffer(1, float.length, sampleRate);
    buffer.copyToChannel(float, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + buffer.duration;
  }
  stop() { this.stopped = true; try { this.ctx.close(); } catch { /* already closed */ } }
}

export class LiveKeak {
  private ws: WebSocket | null = null;
  private player: AudioPlayer | null = null;
  private micStream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private closed = false;
  private finished = false;
  private micReady = false;
  private wantFinish = false; // finishTurn() was requested before the mic was streaming (a very quick tap)
  private pendingCall: { callId: string; name: string } | null = null; // OpenAI function call being assembled
  private toolInFlight = false; // waiting on a tool result, so the tool-call's response.done isn't the end
  private userText = "";
  private keakText = "";
  private firstAudio = false;
  // handsfree silence detection
  private spoke = false;
  private silenceStart = 0;
  private startedAt = 0;

  constructor(
    private mode: LiveMode,
    private provider: LiveProvider,
    private apiKey: string,
    private instructions: string,
    private handlers: LiveHandlers,
  ) {}

  private inRate(): number { return this.provider === "gemini" ? 16000 : 24000; }

  async open(): Promise<void> {
    try {
      if (this.provider === "gemini") await this.openGemini();
      else await this.openOpenAI();
    } catch (e) {
      this.handlers.onError?.("Couldn't start live voice: " + String(e).slice(0, 140));
      this.close();
    }
  }

  // ---- Gemini Live ----
  private async openGemini(): Promise<void> {
    const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`);
    this.ws = ws;
    this.player = new AudioPlayer(24000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        setup: {
          model: GEMINI_MODEL,
          generationConfig: { responseModalities: ["AUDIO"] },
          systemInstruction: { parts: [{ text: this.instructions }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(this.handlers.onToolCall ? { tools: [{ functionDeclarations: [BRAIN_TOOL] }] } : {}),
        },
      }));
    };
    ws.onmessage = async (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text();
      let msg: any; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.error) { this.handlers.onError?.("Gemini: " + JSON.stringify(msg.error).slice(0, 140)); return; }
      if (msg.setupComplete) { await this.startMic(); return; }
      // The model wants to look something up: run the tool and send the result back so it can keep talking.
      if (msg.toolCall?.functionCalls?.length) {
        for (const c of msg.toolCall.functionCalls) {
          let result = "No result.";
          try { result = await this.handlers.onToolCall!(c.name, c.args || {}); } catch (e) { result = "Search failed: " + String(e).slice(0, 100); }
          ws.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: c.id, name: c.name, response: { result } }] } }));
        }
        return;
      }
      const sc = msg.serverContent;
      if (sc?.inputTranscription?.text) { this.userText += sc.inputTranscription.text; this.handlers.onUserText?.(this.userText); }
      if (sc?.outputTranscription?.text) { this.keakText += sc.outputTranscription.text; this.handlers.onKeakText?.(this.keakText); }
      const parts = sc?.modelTurn?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          if (!this.firstAudio) { this.firstAudio = true; this.handlers.onResponding?.(); }
          this.player?.push(int16FromB64(p.inlineData.data), 24000);
        }
      }
      if (sc?.turnComplete) this.finishDone();
    };
    ws.onerror = () => this.handlers.onError?.("Live connection error. Check the Gemini key and network.");
    ws.onclose = (e) => { if (!this.closed && !this.finished) this.handlers.onError?.(`Live closed early (${e.code}) ${e.reason || ""}`.trim()); };
  }

  // ---- OpenAI Realtime (GA) ----
  private async openOpenAI(): Promise<void> {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`, [
      "realtime",
      "openai-insecure-api-key." + this.apiKey,
    ]);
    this.ws = ws;
    this.player = new AudioPlayer(24000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: this.instructions,
          output_modalities: ["audio"],
          audio: {
            input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null, transcription: { model: "gpt-4o-mini-transcribe" } },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice: "alloy" },
          },
          ...(this.handlers.onToolCall ? { tools: [{ type: "function", ...BRAIN_TOOL }], tool_choice: "auto" } : {}),
        },
      }));
    };
    let started = false;
    ws.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (!msg) return;
      if (msg.type === "error") { this.handlers.onError?.("OpenAI: " + JSON.stringify(msg.error || msg).slice(0, 140)); return; }
      if ((msg.type === "session.created" || msg.type === "session.updated") && !started) { started = true; this.startMic(); return; }
      if ((msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") && msg.delta) {
        if (!this.firstAudio) { this.firstAudio = true; this.handlers.onResponding?.(); }
        this.player?.push(int16FromB64(msg.delta), 24000);
      }
      if ((msg.type === "response.output_audio_transcript.delta" || msg.type === "response.audio_transcript.delta") && msg.delta) {
        this.keakText += msg.delta; this.handlers.onKeakText?.(this.keakText);
      }
      if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
        this.userText = String(msg.transcript); this.handlers.onUserText?.(this.userText);
      }
      // Tool (function) calling: capture the call, run it, feed the result back, ask for the spoken answer.
      if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
        this.pendingCall = { callId: msg.item.call_id, name: msg.item.name };
      }
      if (msg.type === "response.function_call_arguments.done" && this.pendingCall) {
        const call = this.pendingCall; this.pendingCall = null;
        this.toolInFlight = true; // the next response.done is for this tool call, not the final answer
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(msg.arguments || "{}"); } catch { /* ignore */ }
        (async () => {
          let result = "No result.";
          try { result = await this.handlers.onToolCall!(call.name, args); } catch (e) { result = "Search failed: " + String(e).slice(0, 100); }
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.callId, output: result } }));
            this.ws.send(JSON.stringify({ type: "response.create" }));
          }
        })();
        return;
      }
      if (msg.type === "response.done") {
        if (this.toolInFlight) { this.toolInFlight = false; return; } // that was the tool call, keep going
        this.finishDone();
      }
    };
    ws.onerror = () => this.handlers.onError?.("Live connection error. Check the OpenAI key and network.");
    ws.onclose = (e) => { if (!this.closed && !this.finished) this.handlers.onError?.(`Live closed early (${e.code}) ${e.reason || ""}`.trim()); };
  }

  // Stream the mic to the open session until finishTurn() (ptt) or internal silence (handsfree).
  private async startMic(): Promise<void> {
    if (this.closed) return;
    const rate = this.inRate();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch { this.handlers.onError?.("Microphone access denied"); this.close(); return; }
    this.micCtx = new AudioContext({ sampleRate: rate });
    const source = this.micCtx.createMediaStreamSource(this.micStream);
    const processor = this.micCtx.createScriptProcessor(4096, 1, 1);
    this.processor = processor;
    source.connect(processor);
    processor.connect(this.micCtx.destination);
    this.startedAt = performance.now();
    this.micReady = true;
    this.handlers.onListening?.();
    if (this.wantFinish) { this.finishTurn(); return; } // a release came in before the mic was ready
    processor.onaudioprocess = (e) => {
      if (this.closed || this.finished) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      let sum = 0;
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 32768 : s * 32767;
        sum += s * s;
      }
      this.sendAudio(pcm);
      // Handsfree (wake word): no release signal, so end the turn after a short pause once the user has spoken.
      if (this.mode === "handsfree") {
        const rms = Math.sqrt(sum / input.length);
        const now = performance.now();
        if (rms > 0.010) { this.spoke = true; this.silenceStart = now; }
        else if (this.spoke && now - this.silenceStart > 650) { this.finishTurn(); }
        if (now - this.startedAt > 14000) this.finishTurn(); // hard cap
      }
    };
  }

  private sendAudio(pcm: Int16Array) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.provider === "gemini") {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromInt16(pcm), mimeType: `audio/pcm;rate=${this.inRate()}` } } }));
    } else {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64FromInt16(pcm) }));
    }
  }

  // User stopped talking: stop capturing and ask the model to reply.
  finishTurn(): void {
    if (this.finished || this.closed) return;
    // If the release beat the mic opening, remember it and finish as soon as the mic is ready.
    if (!this.micReady) { this.wantFinish = true; return; }
    this.finished = true;
    this.stopMic();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.provider === "gemini") {
      ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } else {
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      ws.send(JSON.stringify({ type: "response.create" }));
    }
  }

  private finishDone(): void {
    const u = this.userText.trim(), k = this.keakText.trim();
    this.handlers.onDone?.(u, k);
    this.close();
  }

  private stopMic(): void {
    if (this.processor) { try { this.processor.disconnect(); this.processor.onaudioprocess = null; } catch { /* noop */ } this.processor = null; }
    if (this.micCtx) { try { this.micCtx.close(); } catch { /* noop */ } this.micCtx = null; }
    if (this.micStream) { this.micStream.getTracks().forEach((t) => t.stop()); this.micStream = null; }
  }

  // Tear everything down (also used to interrupt a reply that's still playing).
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopMic();
    this.player?.stop(); this.player = null;
    if (this.ws) { try { this.ws.close(); } catch { /* noop */ } this.ws = null; }
  }
}

// Which live provider (if any) the user has connected + can use for live voice. Returns null when the
// connected provider has no realtime API (Claude/Ollama/etc.) or no credential — caller uses the classic flow.
export function liveInfo(): { provider: LiveProvider; apiKey: string } | null {
  if (localStorage.getItem("keak_live_mode") === "0") return null; // user turned live voice off
  const provider = localStorage.getItem("keak_cu_provider") || "";
  if (provider === "gemini") {
    const key = (localStorage.getItem("keak_cu_gemini_key") || "").trim();
    return key ? { provider: "gemini", apiKey: key } : null;
  }
  if (provider === "openai") {
    const key = (localStorage.getItem("keak_cu_openai_key") || "").trim(); // realtime needs a real sk- key
    return key.startsWith("sk-") ? { provider: "openai", apiKey: key } : null;
  }
  return null;
}
