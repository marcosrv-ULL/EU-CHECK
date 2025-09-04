import { useEffect, useRef, useState } from "react";

/**
 * Nivel de audio suavizado [0..1]
 * - Si tu backend/frontend emite: window.dispatchEvent(new CustomEvent("app:speaking", { detail: { level } }))
 *   lo usará directamente.
 * - Si no, intenta capturar micro (fallback) para calcular RMS.
 */
export function useAudioLevel({ smoothing = 0.15, fallbackMic = true } = {}) {
  const [level, setLevel] = useState(0);
  const targetRef = useRef(0);
  const rafRef = useRef(0);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const dataRef = useRef(null);
  const sourceRef = useRef(null);

  // ----- Eventos de la app (preferente)
  useEffect(() => {
    const onSpeaking = (e) => {
      const v = Math.max(0, Math.min(1, +e?.detail?.level ?? 0));
      targetRef.current = v;
    };
    window.addEventListener("app:speaking", onSpeaking);
    return () => window.removeEventListener("app:speaking", onSpeaking);
  }, []);

  // ----- Fallback mic
  useEffect(() => {
    let stopped = false;

    async function setupMic() {
      if (!fallbackMic) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.7;
        const src = ctx.createMediaStreamSource(stream);
        src.connect(analyser);

        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        dataRef.current = new Uint8Array(analyser.fftSize);
        sourceRef.current = src;
      } catch (e) {
        // Silencioso si el user no da permiso; se quedará con eventos o nivel 0
      }
    }

    setupMic();
    return () => {
      stopped = true;
      try {
        sourceRef.current?.disconnect?.();
        analyserRef.current?.disconnect?.();
        audioCtxRef.current?.close?.();
      } catch {}
    };
  }, [fallbackMic]);

  // ----- Loop de suavizado + lectura mic
  useEffect(() => {
    function tick() {
      // Si hay mic activo y no recibimos eventos, calcula RMS
      const analyser = analyserRef.current;
      if (analyser && targetRef.current < 0.001) {
        const buf = dataRef.current;
        analyser.getByteTimeDomainData(buf);
        // RMS normalizado ~ [0..1]
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length); // ~0..1
        // Un poco de ganancia suave
        targetRef.current = Math.min(1, rms * 2.2);
      }

      // Suavizado exponencial
      setLevel((prev) => prev + (targetRef.current - prev) * smoothing);
      rafRef.current = requestAnimationFrame(tick);

      // dentro del loop de tick en useAudioLevel
        window.dispatchEvent(
            new CustomEvent("app:speaking", { detail: { level } })
        );
  
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [smoothing]);

  return level;
}
