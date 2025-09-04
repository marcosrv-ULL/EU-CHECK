import { useEffect, useRef, useState, useCallback } from "react";
import ChatBubble from "./chatBubble";
import { useWS } from "../hooks/useWS";

/* ==== TTS (Web Speech API) - minimal ==== */
function speak(text, opts = {}) {
  if (!("speechSynthesis" in window)) return;
  const { rate = 1.05, pitch = 1.0, volume = 1.0, voiceName = null } = opts;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = rate; u.pitch = pitch; u.volume = volume;

  if (voiceName) {
    const all = window.speechSynthesis.getVoices?.() || [];
    const v = all.find(x => x.name === voiceName);
    if (v) u.voice = v;
  }
  window.speechSynthesis.speak(u);
}
function stopSpeech() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

/* ==== Icons ==== */
function MicIcon({ className = "w-5 h-5" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm-7-3a1 1 0 1 1 2 0 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V20h3a1 1 0 1 1 0 2H10a1 1 0 1 1 0-2h3v-2.07A7 7 0 0 1 5 11Z"/>
    </svg>
  );
}
function VideoIcon({ className = "w-5 h-5" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M15 8a3 3 0 0 1 3 3v.382l3.447-2.297A1 1 0 0 1 23 10v4a1 1 0 0 1-1.553.832L18 12.535V13a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3Z"/>
    </svg>
  );
}
function SendIcon({ className = "w-5 h-5" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/>
    </svg>
  );
}

// === Utils: Blob -> base64 ===
async function blobToBase64(blob) {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = r.result;
      if (typeof s === "string") {
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      } else reject(new Error("Unexpected FileReader result"));
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}


export default function Chat({
  initialMessages = [{ id: "m1", role: "assistant", text: "Hi!" }],
  onSend, // optional: fallback if no WS
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const recChunksRef = useRef([]); // << acumula blobs aquí


  // WS
  const { connected, sendJson, onMessage } = useWS(); // /api/chat/ws
  const currentAssistantIdRef = useRef(null);
  const currentTurnIdRef = useRef(null);

  // ==== TTS control (Piper by default, Web Speech fallback) ====
  const ttsModeRef = useRef('piper');
  const hadTtsErrorRef = useRef(false);

  // Piper queue
  const piperQueueRef = useRef([]);
  const piperAudioRef = useRef(new Audio());
  const piperPlayingRef = useRef(false);

  // VAD canvas
  const vadCanvasRef = useRef(null);
  const lastLogAtRef = useRef(0);



  function enqueuePiper(b64) {
    const url = `data:audio/wav;base64,${b64}`;
    piperQueueRef.current.push(url);
    if (!piperPlayingRef.current) playNextPiper();
  }
  function playNextPiper() {
    const next = piperQueueRef.current.shift();
    if (!next) { piperPlayingRef.current = false; return; }
    piperPlayingRef.current = true;
    const a = piperAudioRef.current;
    a.src = next;
    a.onended = () => playNextPiper();
    a.onerror = () => playNextPiper();
    a.play?.();
  }
  function stopAllAudio() {
    // Web Speech TTS
    stopSpeech();
    // Piper
    const a = piperAudioRef.current;
    try { a.pause(); } catch {}
    try { a.currentTime = 0; } catch {}
    piperQueueRef.current.length = 0;
    piperPlayingRef.current = false;
  }

  // ==== STT (SpeechRecognition) — streaming parcial/final + UI estable + recError ====
const recRef = useRef(null);
const sttDesiredRef = useRef(false);   // intención del usuario
const sttAccumRef = useRef("");        // acumulado de resultados finales
const recStartingRef = useRef(false);  // evita start() duplicados
const recBackoffRef = useRef(250);     // backoff exponencial (máx 5s)
const restartTimerRef = useRef(null);

// auto-send en cuanto llegue la transcripción
const autoSendAfterSttRef = useRef(false);


// ==== STT (MediaRecorder -> backend) ====
const recorderRef = useRef(null);
const streamRef = useRef(null);
const [isRecording, setIsRecording] = useState(false);
const [recSupported, setRecSupported] = useState(true);
const [recError, setRecError] = useState("");   // ya lo usabas en el footer

// IDs / flags
const sttSessionIdRef = useRef(null);
const pendingSendRef = useRef(false);
const sttSeqRef = useRef(0);
const lastPartialRef = useRef({ t: 0, text: "" });
const PARTIAL_DEBOUNCE_MS = 150;
const PARTIAL_MIN_CHARS = 6;

// === VAD simple (silence auto-stop) ===
const vadRef = useRef({
  ctx: null, src: null, analyser: null, raf: 0,
  lastSpeech: 0, startedAt: 0,
  silentMs: 0, hasSpeech: false
});

// === VAD robusto (no cortar a mitad) + visualizador ===
const VAD = {
  SILENCE_MS: 1600,
  MIN_MS: 1000,
  NOISE_WARMUP_MS: 300,
  NOISE_ALPHA: 0.05,
  RMS_ALPHA: 0.2,
  HYST_MULT: 3.2,
  BASE_THRESH: 0.012,
  GRACE_MS: 300,
  PREROLL_MS: 400,
  MIN_CONSEC_SIL_FRAMES: 6,
  MIN_VOICE_FRAMES: 4,       // NUEVO: exigir voz real antes de permitir el corte
  HARD_MAX_MS: 45_000,
  DT_CLAMP_MS: 100,          // NUEVO: clampa dt para evitar saltos
  VOICE_HYST: 1.05           // NUEVO: pequeña histéresis sobre dyn (5%)
};

const vadStateRef = useRef({
  ctx: null, src: null, analyser: null, raf: 0,
  startedAt: 0, lastSpeechAt: 0, lastTickAt: 0,
  noiseFloor: 0.01, rmsSmooth: 0, hasSpeech: false,
  voiceFrames: 0,             // NUEVO
  silentMs: 0, silentFrames: 0, pendingStopAt: 0,
  zcrSmooth: 0                // opcional
}); // (opcional) cortar a los 30s sí o sí

// util: Zero-Crossing Rate simple
function computeZCR(buf) {
  let z = 0;
  for (let i = 1; i < buf.length; i++) {
    const a = buf[i - 1], b = buf[i];
    if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) z++;
  }
  return z / buf.length; // 0–1 aprox
}

const noiseRef = useRef({ floor: 0.01 });    // estimación de ruido (EMA)
const isRecordingRef = useRef(false);
useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);

async function startSTT() {
  try { stopAllAudio(); } catch {}
  setRecError("");
  if (!recSupported) { setRecError("STT unsupported."); return; }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  streamRef.current = stream;

  const sessionId = crypto.randomUUID();
  sttSessionIdRef.current = sessionId;
  const lang = (navigator.language || "en-US");
  const mimePreferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus" : "");

  autoSendAfterSttRef.current = true;
  pendingSendRef.current = true;

  if (connected) {
    sendJson({ v:1, type:"stt_start", t:Date.now(), data:{ sessionId, lang, mime: mimePreferred || "audio/webm" } });
  }

  // limpiar buffer
  recChunksRef.current = [];

  const rec = new MediaRecorder(stream, mimePreferred ? { mimeType: mimePreferred } : undefined);
  recorderRef.current = rec;
  setIsRecording(true);

  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunksRef.current.push(ev.data); };

  rec.onstop = async () => {
    try {
      if (!connected || !sttSessionIdRef.current) return;
      const mime = rec.mimeType || mimePreferred || "audio/webm";
      const merged = new Blob(recChunksRef.current, { type: mime });
      recChunksRef.current = [];

      const b64 = await blobToBase64(merged);
      await sendJson({ v:1, type:"stt_audio", t:Date.now(), data:{ sessionId: sttSessionIdRef.current, b64 } });
      await sendJson({ v:1, type:"stt_end", t:Date.now(), data:{ sessionId: sttSessionIdRef.current } });
    } catch (e) {
      setRecError("Failed to finalize audio.");
    }
  };

  rec.onerror = (e) => {
    setRecError(e?.error?.message || e?.name || "Recorder error.");
    setIsRecording(false);
  };

  rec.start(); // blob único al parar

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try { await ctx.resume(); } catch {}
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0; // nos vale raw time-domain
  src.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  const now = performance.now();

  vadStateRef.current = {
    ctx, src, analyser, raf: 0,
    startedAt: now, lastSpeechAt: now, lastTickAt: now,
    noiseFloor: 0.01, rmsSmooth: 0, hasSpeech: false,
    voiceFrames: 0,
    silentMs: 0, silentFrames: 0, pendingStopAt: 0,
    zcrSmooth: 0
  };

  const cnv = vadCanvasRef.current;
  const g = cnv ? cnv.getContext("2d") : null;

  const draw = (rms, dyn, state, info = "") => {
    if (!g) return;
    const W = cnv.width, H = cnv.height;
    g.clearRect(0,0,W,H);
    // barra RMS
    const xr = Math.min(1, rms * 8); // escala visual
    g.fillStyle = "#2dd4bf";
    g.fillRect(0, 0, xr * W, H/2);

    // línea umbral
    const xt = Math.min(1, dyn * 8);
    g.fillStyle = "#ef4444";
    g.fillRect(xt * W, H/2, 2, H/2);

    // estado
    g.fillStyle = "#ddd";
    g.font = "12px monospace";
    g.fillText(`${state}  rms:${rms.toFixed(3)} thr:${dyn.toFixed(3)} ${info}`, 6, H/2 - 4);
  };

  const tick = () => {
    const t = performance.now();
    let dt = Math.max(0, t - vadStateRef.current.lastTickAt);
    vadStateRef.current.lastTickAt = t;
    // 👇 evita sumas de silencio por saltos de rAF/tab no activo
    dt = Math.min(dt, VAD.DT_CLAMP_MS);

    analyser.getFloatTimeDomainData(buf);

    // RMS instantáneo
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v*v; }
    const rms = Math.sqrt(sum / buf.length);

    // RMS suavizado
    const rmsSmooth = vadStateRef.current.rmsSmooth === 0
      ? rms
      : (1 - VAD.RMS_ALPHA) * vadStateRef.current.rmsSmooth + VAD.RMS_ALPHA * rms;
    vadStateRef.current.rmsSmooth = rmsSmooth;

    // ZCR (opcional, también suavizamos)
    const zcr = computeZCR(buf);
    vadStateRef.current.zcrSmooth = vadStateRef.current.zcrSmooth === 0
      ? zcr : 0.8 * vadStateRef.current.zcrSmooth + 0.2 * zcr;

    // Calibración ruido (warmup)
    const aliveMs = t - vadStateRef.current.startedAt;
    const alphaNoise = aliveMs < VAD.NOISE_WARMUP_MS ? 0.2 : VAD.NOISE_ALPHA;
    vadStateRef.current.noiseFloor =
      (1 - alphaNoise) * vadStateRef.current.noiseFloor + alphaNoise * rms;

    const dyn = Math.max(VAD.BASE_THRESH, vadStateRef.current.noiseFloor * VAD.HYST_MULT);
    const voiced = rmsSmooth > (dyn * VAD.VOICE_HYST); // 👈 pequeña histéresis

    let stateTxt = "SILENCE";
    if (voiced) {
      stateTxt = "VOICE";
      vadStateRef.current.hasSpeech = true;
      vadStateRef.current.voiceFrames += 1;                // 👈 contamos frames de voz
      vadStateRef.current.lastSpeechAt = t;
      vadStateRef.current.silentMs = 0;
      vadStateRef.current.silentFrames = 0;
      vadStateRef.current.pendingStopAt = 0;
    } else {
      // sólo acumulamos silencio si YA hubo voz suficiente
      if (vadStateRef.current.hasSpeech && vadStateRef.current.voiceFrames >= VAD.MIN_VOICE_FRAMES && aliveMs > VAD.MIN_MS) {
        // zcr-gate opcional: si zcr es muy alto, puede ser fricativas/susurros → no sumar tanto silencio
        const zcrGate = vadStateRef.current.zcrSmooth > 0.2 ? 0.5 : 1.0; // rebaja acumulación si hay mucha actividad
        vadStateRef.current.silentMs += dt * zcrGate;
        vadStateRef.current.silentFrames += 1;
      }
    }

    const longSilence = (
      vadStateRef.current.silentMs >= VAD.SILENCE_MS &&
      vadStateRef.current.silentFrames >= VAD.MIN_CONSEC_SIL_FRAMES
    );
    const hardMax = aliveMs >= VAD.HARD_MAX_MS;

    if (isRecordingRef.current && (longSilence || hardMax)) {
      stateTxt = "ARMING";
      if (vadStateRef.current.pendingStopAt === 0) {
        vadStateRef.current.pendingStopAt = t + VAD.GRACE_MS;
      }
      const timeLeft = Math.max(0, vadStateRef.current.pendingStopAt - t);
      draw(rmsSmooth, dyn, stateTxt, `t- ${timeLeft|0} ms`);
      // log reducido
      if (t - lastLogAtRef.current > 300) {
        lastLogAtRef.current = t;
        console.debug("[VAD]", {
          rms: +rmsSmooth.toFixed(4),
          thr: +dyn.toFixed(4),
          zcr: +vadStateRef.current.zcrSmooth.toFixed(3),
          voiceFrames: vadStateRef.current.voiceFrames,
          silentMs: (vadStateRef.current.silentMs|0),
          silentFrames: vadStateRef.current.silentFrames,
          arming: true, timeLeft: timeLeft|0
        });
      }
      if (t >= vadStateRef.current.pendingStopAt) {
        setTimeout(() => {
          if (isRecordingRef.current) stopSTT({ sendAsMessage: true });
        }, VAD.PREROLL_MS);
        return;
      }
    } else {
      draw(rmsSmooth, dyn, stateTxt);
      if (t - lastLogAtRef.current > 300) {
        lastLogAtRef.current = t;
        console.debug("[VAD]", {
          rms: +rmsSmooth.toFixed(4),
          thr: +dyn.toFixed(4),
          zcr: +vadStateRef.current.zcrSmooth.toFixed(3),
          voiceFrames: vadStateRef.current.voiceFrames,
          silentMs: (vadStateRef.current.silentMs|0),
          silentFrames: vadStateRef.current.silentFrames,
          voiced
        });
      }
    }

    vadStateRef.current.raf = requestAnimationFrame(tick);
  };

  vadStateRef.current.raf = requestAnimationFrame(tick);
}

function stopSTT({ sendAsMessage = true } = {}) {
  try { vadStateRef.current.raf && cancelAnimationFrame(vadStateRef.current.raf); } catch {}
  try { vadStateRef.current.ctx && vadStateRef.current.ctx.close(); } catch {}
  vadStateRef.current = {
    ctx: null, src: null, analyser: null, raf: 0,
    startedAt: 0, lastSpeechAt: 0, lastTickAt: 0,
    noiseFloor: 0.01, rmsSmooth: 0, hasSpeech: false,
    voiceFrames: 0,
    silentMs: 0, silentFrames: 0, pendingStopAt: 0,
    zcrSmooth: 0
  };

  pendingSendRef.current = !!sendAsMessage;

  try { recorderRef.current?.stop(); } catch {}
  try { streamRef.current?.getTracks?.().forEach(t => t.stop()); } catch {}
  setIsRecording(false);

  if (!connected || !sttSessionIdRef.current) {
    setRecError("WS not connected.");
  }
}


// ==== Wake word: "Taylor" -> auto start STT ====
const WAKE_WORD = "taylor";
const wakeRef = useRef(null);
const wakeDesiredRef = useRef(true);
const wakeBackoffRef = useRef(500);
const wakeRestartTimerRef = useRef(null);
const [wakeOn, setWakeOn] = useState(true); // toggle opcional en la UI

useEffect(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  const SGL = window.SpeechGrammarList || window.webkitSpeechGrammarList;

  const startWake = () => {
    if (!wakeDesiredRef.current || isRecording) return;

    // cierra instancia previa si la hubiera
    try { wakeRef.current?.stop(); } catch {}

    const w = new SR();
    w.lang = "en-US";
    w.continuous = true;
    w.interimResults = true;
    w.maxAlternatives = 1;

    // gramática (opcional). Algunos navegadores la ignoran, pero no molesta.
    if (SGL) {
      const g = new SGL();
      g.addFromString('#JSGF V1.0; grammar hot; public <hot> = taylor ;', 1);
      try { w.grammars = g; } catch {}
    }

    w.onstart = () => { wakeBackoffRef.current = 500; };

    w.onend = () => {
      if (wakeDesiredRef.current && !isRecording) {
        const delay = wakeBackoffRef.current;
        wakeBackoffRef.current = Math.min(delay * 2, 5000);
        clearTimeout(wakeRestartTimerRef.current);
        wakeRestartTimerRef.current = setTimeout(startWake, delay);
      }
    };

    w.onerror = () => w.onend();

    w.onresult = (ev) => {
      let chunk = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        chunk += (res[0]?.transcript || "") + " ";
      }
      const text = chunk.toLowerCase();
    
      // Evita auto-disparos por TTS/Piper
      const speaking =
        (typeof window !== "undefined" && "speechSynthesis" in window && window.speechSynthesis.speaking)
        || piperPlayingRef.current;
    
      if (!speaking && text.includes(WAKE_WORD) && !isRecording) {
        try { w.stop(); } catch {}
        speak("Yes?");
        startSTT();
      }
    };
    

    wakeRef.current = w;
    try { w.start(); } catch {}
  };

  if (wakeOn && !isRecording) {
    wakeDesiredRef.current = true;
    startWake();
  } else {
    wakeDesiredRef.current = false;
    try { wakeRef.current?.stop(); } catch {}
  }

  return () => {
    wakeDesiredRef.current = false;
    try { wakeRef.current?.stop(); } catch {}
    clearTimeout(wakeRestartTimerRef.current);
  };
}, [wakeOn, isRecording]);


// Botón mic (si ya lo tienes, deja esto igual)
function handleMic1() {
  if (!recSupported) { alert("STT not supported in this browser."); return; }
  if (isRecording) stopSTT({ sendAsMessage: true }); else startSTT();
  if (connected) sendJson({ v:1, type:"user_mic_toggle", msgId: crypto.randomUUID(), t: Date.now(), data: { on: !isRecording }});
}

  // ==== local chunker for web TTS fallback (unchanged) ====
  const localChunkRef = useRef({ buf: "", lastTs: 0 });
  const SENTENCE_GAP_MS = 380;
  const SENTENCE_RE = /([\.!?…]+)(\s+|$)/;

  // Autoscroll
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  // Load voices (some browsers expose voices asynchronously)
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const onVoices = () => window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", onVoices);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", onVoices);
  }, []);


  const handleSend = useCallback(async (textOverride) => {
    const text = (typeof textOverride === "string" ? textOverride : input).trim();
    if (!text || sending) return;
  
    const userMsg = { id: crypto.randomUUID(), role: "user", text };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setSending(true);
  
    if (connected) {
      const turnId = crypto.randomUUID();
      const msgId = crypto.randomUUID();
      currentTurnIdRef.current = turnId;
      hadTtsErrorRef.current = false;
      ttsModeRef.current = "piper"; // synth via Piper
  
      sendJson({
        v: 1,
        type: "user_text",
        turnId,
        msgId,
        t: Date.now(),
        data: { text, tts: true, voice: "en_US-ryan-high" },
      });
    } else {
      ttsModeRef.current = "web";
      try {
        const maybeReply = await onSend?.(text, messages.concat(userMsg));
        const replyText =
          typeof maybeReply === "string" && maybeReply.length > 0
            ? maybeReply
            : "Got your message. (Simulated reply; connect WS/onSend)";
        const assistantMsg = { id: crypto.randomUUID(), role: "assistant", text: replyText };
        setMessages(prev => [...prev, assistantMsg]);
        if (ttsModeRef.current === "web") {
          replyText.split(/(?<=[\.!?…])\s+/).forEach(s => s && speak(s.trim()));
        }
      } catch (e) {
        const errMsg = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Oops, there was an error sending. Try again.",
        };
        setMessages(prev => [...prev, errMsg]);
        console.error(e);
      } finally {
        setSending(false);
      }
    }
  }, [connected, sendJson, onSend, messages, input, sending]);

  // WS handler
  useEffect(() => {
    const off = onMessage((m) => {
      switch (m.type) {
        case "llm_token": {
          if (!currentAssistantIdRef.current) {
            const id = crypto.randomUUID();
            currentAssistantIdRef.current = id;
            setMessages(prev => [...prev, { id, role: "assistant", text: "" }]);
          }
          setMessages(prev =>
            prev.map(msg =>
              msg.id === currentAssistantIdRef.current
                ? { ...msg, text: msg.text + m.data.text }
                : msg
            )
          );

          const now = Date.now();
          const ch = localChunkRef.current;
          ch.buf += m.data.text;
          const gap = ch.lastTs ? now - ch.lastTs : 0;
          ch.lastTs = now;

          const match = ch.buf.match(SENTENCE_RE);
          const longPause = gap > SENTENCE_GAP_MS;

          if (ttsModeRef.current === 'web' && (match || longPause)) {
            const cutIdx = match ? (match.index + match[0].length) : ch.buf.length;
            const sentence = ch.buf.slice(0, cutIdx).trim();
            ch.buf = ch.buf.slice(cutIdx);
            if (sentence) speak(sentence);
          }
          break;
        }

        

        case "sentence": {
          const s = m.data?.text?.trim();
          if (s) {
            localChunkRef.current.buf = "";
            if (ttsModeRef.current === 'web') speak(s);
          }
          break;
        }
        case "done": {
          const tail = localChunkRef.current.buf.trim();
          localChunkRef.current.buf = "";
          if (tail && ttsModeRef.current === 'web') speak(tail);
          currentAssistantIdRef.current = null;
          currentTurnIdRef.current = null;
          setSending(false);
          break;
        }
        case "error": {
          stopAllAudio();
          setMessages(prev => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", text: `Error: ${m.data?.message || "unknown"}` }
          ]);
          setSending(false);
          break;
        }
        case "tts_chunk": {
          const b64 = m.data?.audioB64;
          if (b64) enqueuePiper(b64);
          break;
        }

        case "tts_levels": {
          const { levels, winMs } = msg.data;
          console.log("tts" + levels)
      
          // Reproduce la envolvente en paralelo al audio
          let i = 0;
          const timer = setInterval(() => {
            if (i < levels.length) {
              const level = levels[i++];
              window.dispatchEvent(
                new CustomEvent("app:speaking", { detail: { level } })
              );
            } else {
              clearInterval(timer);
              // apagar al final
              window.dispatchEvent(
                new CustomEvent("app:speaking", { detail: { level: 0 } })
              );
            }
          }, winMs);
      
          break;
        }

        case "stt_result": {
          const text = m.data?.text?.trim?.() || "";
          if (text) {
            setInput(text); // reflejo en textarea por si el usuario quiere editar la próxima
            const shouldAutoSend = autoSendAfterSttRef.current || pendingSendRef.current;
        
            if (shouldAutoSend) {
              autoSendAfterSttRef.current = false;
              pendingSendRef.current = false;
              setIsRecording(false);
              handleSend(text); // ✅ envía YA con el texto transcrito (sin depender del estado)
            }
          } else {
            setRecError("Empty transcript.");
            autoSendAfterSttRef.current = false;
            pendingSendRef.current = false;
          }
          break;
        }
        
        
        case "stt_error": {
          const msg = m.data?.message || "Transcription error.";
          setRecError(msg);
          autoSendAfterSttRef.current = false;   // 
          pendingSendRef.current = false;        // 
          break;
        }
        
        

        case "tts_error": {
          hadTtsErrorRef.current = true;
          ttsModeRef.current = 'web';
          const s = m.data?.text?.trim?.() || "";
          if (s) speak(s);
          break;
        }
        default:
          break;
      }
    });
    return off;
  }, [onMessage, handleSend]);

  
  

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleMic() {
    toggleMic();
  }
  function handleVideo() {
    if (!connected) return console.log("Webcam click (no WS)");
    sendJson({ v: 1, type: "user_cam_toggle", msgId: crypto.randomUUID(), t: Date.now(), data: { on: true }});
  }
  // <canvas ref={vadCanvasRef} width={320} height={60} style={{ width: 320, height: 60, background: "#111", borderRadius: 8 }} />
  // cleanup on unmount
  useEffect(() => {
    return () => {
      try { recorderRef.current?.state === 'recording' && recorderRef.current.stop(); } catch {}
      try { streamRef.current?.getTracks?.().forEach(t => t.stop()); } catch {}
    };
  }, []);

  return (
    
    <div className="h-full flex flex-col">
      {/* Messages */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3">
        {messages.map((m) => (
          <ChatBubble key={m.id} text={m.text} isUser={m.role === "user"} />
        ))}
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 p-2">
        <div className="relative bg-white border border-gray-200 rounded-xl shadow-sm px-2 py-2 overflow-hidden">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isRecording ? "Recording… (tap ▶ to stop)" : "Write a message..."}
            className="block w-full min-w-0 resize-none outline-none bg-transparent px-2 py-2 pr-40 min-h-[40px] max-h-40"
            disabled={isRecording}
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            <button
              type="button"
              onClick={handleMic1}
              className={`p-2 rounded-md active:scale-95 transition ${isRecording ? "bg-red-100 text-red-600" : "hover:bg-gray-100"}`}
              aria-label="Mic"
              title={isRecording ? "Stop" : "Record"}
            >
              <MicIcon />
            </button>
            <button
              type="button"
              onClick={handleVideo}
              className="p-2 rounded-md hover:bg-gray-100 active:scale-95 transition"
              aria-label="Webcam (soon)"
              title="Webcam (soon)"
            >
              <VideoIcon />
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={sending || !input.trim() || isRecording}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition whitespace-nowrap
                ${sending || !input.trim() || isRecording
                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                  : "bg-blue-600 text-white border-blue-600 hover:bg-blue-700 active:scale-95"
                }`}
              aria-label="Send"
            >
              <SendIcon />
              <span className="hidden sm:inline">Send</span>
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between mt-1 px-1">
          <p className="text-xs text-gray-400">
            {connected ? "WS connected" : "WS disconnected (fallback onSend)"} {isRecording && " · 🎙️ Recording..."}
            {recError && <span className="text-red-500"> · {recError}</span>}
          </p>
          <button
            type="button"
            onClick={stopAllAudio}
            className="text-xs text-gray-500 hover:text-gray-700 underline"
            title="Mute voice"
          >
            Mute
          </button>
          <button
            type="button"
            onClick={() => setWakeOn(v => !v)}
            className="text-xs text-gray-500 hover:text-gray-700 underline ml-2"
            title="Wake word"
          >
            Wake: {wakeOn ? "On" : "Off"} (Taylor)
          </button>
        </div>
      </div>
    </div>
  );
}
