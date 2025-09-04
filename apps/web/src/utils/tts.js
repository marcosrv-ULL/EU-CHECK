// TTS simple con Web Speech API (gratis, en el navegador)
export function speak(text, opts = {}) {
    if (!("speechSynthesis" in window)) return;
    const {
      rate = 1.05,  // un pelín más rápido para ritmo de panel
      pitch = 1.0,
      volume = 1.0,
      voiceName = null, // p.ej. "Google español"
    } = opts;
  
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.pitch = pitch;
    u.volume = volume;
  
    // opcional: escoger voz por nombre
    if (voiceName) {
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find(v => v.name === voiceName);
      if (v) u.voice = v;
    }
    window.speechSynthesis.speak(u);
  }
  
  export function stopSpeech() {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
  }
  