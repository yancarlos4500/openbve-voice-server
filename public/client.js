const state = {
  ws: null,
  localStream: null,
  localTrack: null,
  audioCtx: null,
  masterOutput: null,
  radioStaticBuffer: null,
  radioStaticLoading: false,
  radioStaticSource: null,
  radioStaticGain: null,
  radioNoiseGain: null,
  radioNoiseCrackleGain: null,
  radioNoiseFlutterDepth: null,
  blockingToneGain: null,
  selfId: null,
  selfName: "",
  peers: new Map(),
  currentHolderId: null,
  currentQueue: [],
  activeSpeakerId: null,
  activeChannel: null,
  lastRxActive: false,
  lastEotAt: 0,
  lastRogerAt: 0,
  rogerBeepBuffer: null,
  rogerBeepLoading: false,
  txGranted: false,
  isPttPressed: false,
  powerMode: "off",
  micAnalyserNode: null,
  micAnalyserSourceNode: null,
  micVisualizerAnimationId: null,
  cleanMonitorEnabled: false,
  serverProbeTimerId: null,
  serverProbeInFlight: false,
  selectedMicDeviceId: "",
  selectedOutputDeviceId: "",
  pttKeyCode: "Space"
};

const stunConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const FIXED_CHANNEL = "operations";
const SETTINGS_STORAGE_KEY = "openbve-radio-settings-v1";
const authToken = new URLSearchParams(window.location.search).get("token") || "";
let authCheckInFlight = null;

function withAuthQuery(path) {
  if (!authToken) {
    return path;
  }

  const urlObj = new URL(path, window.location.href);
  if (!urlObj.searchParams.get("token")) {
    urlObj.searchParams.set("token", authToken);
  }

  return `${urlObj.pathname}${urlObj.search}${urlObj.hash}`;
}

async function ensureAuthenticated() {
  if (authCheckInFlight) {
    return authCheckInFlight;
  }

  authCheckInFlight = (async () => {
    try {
      const statusResponse = await fetch(withAuthQuery("/auth/status"), {
        method: "GET",
        cache: "no-store"
      });

      if (statusResponse.status === 404) {
        // Backward compatibility with older server builds.
        return true;
      }

      if (!statusResponse.ok) {
        return false;
      }

      const statusPayload = await statusResponse.json().catch(() => null);
      if (!statusPayload || statusPayload.enabled === false || statusPayload.authenticated === true) {
        return true;
      }

      const password = window.prompt("Enter radio access password");
      if (!password) {
        setStatus("Authentication required");
        return false;
      }

      const loginResponse = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });

      if (!loginResponse.ok) {
        setStatus("Authentication failed");
        return false;
      }

      return true;
    } catch (_err) {
      return false;
    } finally {
      authCheckInFlight = null;
    }
  })();

  return authCheckInFlight;
}

const roleEl = document.getElementById("role");
const lineEl = document.getElementById("line");
const trainIdEl = document.getElementById("trainId");
const joinBtn = document.getElementById("joinBtn");
const pttBtn = document.getElementById("pttBtn");
const cleanCheckBtn = document.getElementById("cleanCheckBtn");
const radioFrameEl = document.getElementById("radioFrame");
const serverStatusEl = document.getElementById("serverStatus");
const userStatusEl = document.getElementById("userStatus");
const statusEl = document.getElementById("status");
const channelStateEl = document.getElementById("channelState");
const peersEl = document.getElementById("peers");
const opsTabBtnEl = document.getElementById("opsTabBtn");
const settingsTabBtnEl = document.getElementById("settingsTabBtn");
const opsPanelEl = document.getElementById("opsPanel");
const settingsPanelEl = document.getElementById("settingsPanel");
const micSelectEl = document.getElementById("micSelect");
const outputSelectEl = document.getElementById("outputSelect");
const pttKeyCaptureEl = document.getElementById("pttKeyCapture");

function setPowerState(mode) {
  if (!radioFrameEl) {
    return;
  }

  state.powerMode = mode;
  radioFrameEl.classList.remove("power-off", "power-connecting", "power-on");
  radioFrameEl.classList.add(`power-${mode}`);

  if (joinBtn) {
    if (mode === "on") {
      joinBtn.textContent = "Disconnect";
    } else if (mode === "connecting") {
      joinBtn.textContent = "Connecting...";
    } else {
      joinBtn.textContent = "Connect";
    }
  }
}

function updateCleanCheckButton() {
  if (!cleanCheckBtn) {
    return;
  }

  cleanCheckBtn.textContent = state.cleanMonitorEnabled ? "Audio Filter: Off" : "Audio Filter: On";
  cleanCheckBtn.classList.toggle("active", state.cleanMonitorEnabled);
}

function routePeerAudio(peer, isActiveSpeaker) {
  if (!peer || !peer.audio) {
    return;
  }

  // Half-duplex behavior: while transmitting, do not monitor inbound audio.
  if (state.isPttPressed) {
    peer.audio.muted = true;
    peer.audio.volume = 0;
    if (peer.peerGainNode) {
      peer.peerGainNode.gain.value = 0;
    }
    return;
  }

  if (!isActiveSpeaker) {
    peer.audio.muted = true;
    peer.audio.volume = 0;
    if (peer.peerGainNode) {
      peer.peerGainNode.gain.value = 0;
    }
    return;
  }

  if (state.cleanMonitorEnabled) {
    peer.audio.muted = false;
    peer.audio.volume = 1.0;
    if (peer.peerGainNode) {
      peer.peerGainNode.gain.value = 0;
    }
    return;
  }

  peer.audio.muted = true;
  peer.audio.volume = 0;
  if (peer.peerGainNode) {
    peer.peerGainNode.gain.value = 1.0;
  }
}

function applyCurrentMonitorRouting() {
  for (const [peerId, peer] of state.peers.entries()) {
    const isActiveSpeaker = Boolean(state.activeSpeakerId && peerId === state.activeSpeakerId);
    routePeerAudio(peer, isActiveSpeaker);
  }
}

function setServerStatus(message) {
  serverStatusEl.textContent = message;
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mic: state.selectedMicDeviceId || "",
        output: state.selectedOutputDeviceId || "",
        pttKey: state.pttKeyCode || "Space"
      })
    );
  } catch (_err) {
    // Ignore storage failures in private/restricted contexts.
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") {
      return;
    }

    state.selectedMicDeviceId = typeof saved.mic === "string" ? saved.mic : "";
    state.selectedOutputDeviceId = typeof saved.output === "string" ? saved.output : "";
    state.pttKeyCode = typeof saved.pttKey === "string" ? saved.pttKey : "Space";
  } catch (_err) {
    // Ignore malformed setting payloads.
  }
}

async function probeServerStatus() {
  if (state.serverProbeInFlight) {
    return;
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    setServerStatus("Server: online (connected)");
    return;
  }

  state.serverProbeInFlight = true;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(withAuthQuery("/api/rooms"), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });

    if (response.ok) {
      setServerStatus("Server: online");
    } else if (response.status === 401) {
      setServerStatus("Server: auth required");
    } else {
      setServerStatus("Server: offline");
    }
  } catch (_err) {
    setServerStatus("Server: offline");
  } finally {
    window.clearTimeout(timeoutId);
    state.serverProbeInFlight = false;
  }
}

function startServerStatusProbe() {
  if (state.serverProbeTimerId) {
    window.clearInterval(state.serverProbeTimerId);
  }

  probeServerStatus();
  state.serverProbeTimerId = window.setInterval(() => {
    probeServerStatus();
  }, 8000);
}

function setUserStatus(message) {
  userStatusEl.textContent = message;
}

function setActiveTab(showSettings) {
  if (!opsTabBtnEl || !settingsTabBtnEl || !opsPanelEl || !settingsPanelEl) {
    return;
  }

  opsTabBtnEl.classList.toggle("active", !showSettings);
  settingsTabBtnEl.classList.toggle("active", showSettings);
  opsTabBtnEl.setAttribute("aria-selected", String(!showSettings));
  settingsTabBtnEl.setAttribute("aria-selected", String(showSettings));

  opsPanelEl.classList.toggle("active", !showSettings);
  settingsPanelEl.classList.toggle("active", showSettings);
  opsPanelEl.hidden = showSettings;
  settingsPanelEl.hidden = !showSettings;
}

async function applyAudioOutputSink(audioElement) {
  if (!audioElement) {
    return;
  }

  if (typeof audioElement.setSinkId !== "function") {
    return;
  }

  try {
    await audioElement.setSinkId(state.selectedOutputDeviceId || "");
  } catch (_err) {
    setStatus("Output device switch blocked by browser/device policy");
  }
}

async function applyAudioContextOutputSink() {
  if (!state.audioCtx || typeof state.audioCtx.setSinkId !== "function") {
    return false;
  }

  try {
    await state.audioCtx.setSinkId(state.selectedOutputDeviceId || "default");
    return true;
  } catch (_err) {
    return false;
  }
}

async function applyOutputDeviceToPeers() {
  const contextSinkApplied = await applyAudioContextOutputSink();

  for (const peer of state.peers.values()) {
    await applyAudioOutputSink(peer.audio);
  }

  if (!contextSinkApplied && state.audioCtx) {
    setStatus("Output switch may be limited by your browser for radio FX audio");
  }
}

async function populateDeviceSelectors() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    if (micSelectEl) {
      const selected = state.selectedMicDeviceId;
      micSelectEl.innerHTML = '<option value="">Default microphone</option>';
      let micIndex = 1;
      for (const device of devices) {
        if (device.kind !== "audioinput") {
          continue;
        }
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${micIndex}`;
        micSelectEl.appendChild(option);
        micIndex += 1;
      }
      micSelectEl.value = selected;
    }

    if (outputSelectEl) {
      const selected = state.selectedOutputDeviceId;
      outputSelectEl.innerHTML = '<option value="">Default output</option>';
      let outIndex = 1;
      for (const device of devices) {
        if (device.kind !== "audiooutput") {
          continue;
        }
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Headset/Speaker ${outIndex}`;
        outputSelectEl.appendChild(option);
        outIndex += 1;
      }
      outputSelectEl.value = selected;
    }
  } catch (_err) {
    // Ignore enumeration errors when browser blocks device labels pre-permission.
  }
}

async function switchMicrophone(deviceId) {
  state.selectedMicDeviceId = deviceId || "";
  saveSettings();

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    const rawStream = await getMicrophoneStream();
    const newStream = createBoostedMicrophoneStream(rawStream);
    const newTrack = newStream.getAudioTracks()[0];

    if (!newTrack) {
      return;
    }

    for (const peer of state.peers.values()) {
      const sender = peer.pc.getSenders().find((item) => item.track && item.track.kind === "audio");
      if (sender) {
        await sender.replaceTrack(newTrack);
      }
    }

    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        track.stop();
      }
    }

    state.localStream = newStream;
    state.localTrack = newTrack;
    state.localTrack.enabled = state.txGranted;
    setStatus("Microphone updated");
  } catch (_err) {
    setStatus("Failed to switch microphone");
  }
}

function unlockRemoteAudio() {
  for (const peer of state.peers.values()) {
    if (!peer.audio || !peer.audio.srcObject) {
      continue;
    }

    peer.audio.play().catch(() => {
      // Some mobile browsers still require repeated user gestures.
    });
  }
}

function getParticipantStatus(userId) {
  if (state.currentHolderId === userId) {
    return "TX";
  }

  const queuePosition = state.currentQueue.indexOf(userId);
  if (queuePosition >= 0) {
    return `Q${queuePosition + 1}`;
  }

  return "RX";
}

function updateSelfStatus() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setUserStatus("User: offline");
    return;
  }

  if (!state.selfId) {
    setUserStatus("User: joining...");
    return;
  }

  if (state.txGranted) {
    setUserStatus("User: transmitting");
    return;
  }

  const queuePosition = state.currentQueue.indexOf(state.selfId);
  if (queuePosition >= 0) {
    setUserStatus(`User: queued (#${queuePosition + 1})`);
    return;
  }

  setUserStatus("User: listening");
}

function createLoopingNoiseBuffer(ctx, seconds = 2) {
  const frameCount = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
  const channel = buffer.getChannelData(0);

  for (let i = 0; i < frameCount; i += 1) {
    channel[i] = Math.random() * 2 - 1;
  }

  return buffer;
}

function createCrackleBuffer(ctx, seconds = 1.5) {
  const frameCount = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
  const channel = buffer.getChannelData(0);

  for (let i = 0; i < frameCount; i += 1) {
    channel[i] = 0;

    if (Math.random() < 0.0009) {
      const pulse = (Math.random() * 2 - 1) * 0.7;
      channel[i] = pulse;

      // Give each impulse a short decay tail to mimic bursty RF crackle.
      if (i + 1 < frameCount) {
        channel[i + 1] += pulse * 0.5;
      }
      if (i + 2 < frameCount) {
        channel[i + 2] += pulse * 0.25;
      }
    }
  }

  return buffer;
}

function createWalkieDistortionCurve(amount = 100) {
  const size = 44100;
  const curve = new Float32Array(size);

  for (let i = 0; i < size; i += 1) {
    const x = (i * 2) / size - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }

  return curve;
}

// Hard tanh saturation — sounds like an overdriven RF stage
function createRadioSaturationCurve(drive = 260) {
  const size = 512;
  const curve = new Float32Array(size);
  const k = drive / 100;
  for (let i = 0; i < size; i++) {
    const x = (i * 2) / size - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k); // normalised to ±1
  }
  return curve;
}

async function loadRogerBeepSample() {
  if (!state.audioCtx || state.rogerBeepBuffer || state.rogerBeepLoading) {
    return;
  }

  state.rogerBeepLoading = true;
  try {
    const response = await fetch(withAuthQuery("radiobeep.wav"), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load roger beep: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const decoded = await state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
    state.rogerBeepBuffer = decoded;
  } catch (_err) {
    // Keep synthetic fallback when external beep file is unavailable.
  } finally {
    state.rogerBeepLoading = false;
  }
}

function ensureRadioStaticSource() {
  if (!state.audioCtx || !state.radioStaticBuffer || !state.radioStaticGain || state.radioStaticSource) {
    return;
  }

  const source = state.audioCtx.createBufferSource();
  source.buffer = state.radioStaticBuffer;
  source.loop = true;
  source.connect(state.radioStaticGain);
  source.start();
  source.onended = () => {
    if (state.radioStaticSource === source) {
      state.radioStaticSource = null;
    }
  };
  state.radioStaticSource = source;
}

async function loadRadioStaticSample() {
  if (!state.audioCtx || state.radioStaticBuffer || state.radioStaticLoading) {
    return;
  }

  state.radioStaticLoading = true;
  try {
    const response = await fetch(withAuthQuery("radiostatic.wav"), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load radio static: HTTP ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const decoded = await state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
    state.radioStaticBuffer = decoded;
    ensureRadioStaticSource();
    if (state.lastRxActive) {
      // If RX is already active, switch to sample static immediately.
      updateNoiseLevel(true);
    }
  } catch (_err) {
    // Keep synthetic static fallback when external sample is unavailable.
  } finally {
    state.radioStaticLoading = false;
  }
}

function initAudioEngine() {
  if (state.audioCtx) {
    if (state.audioCtx.state === "suspended") {
      state.audioCtx.resume().catch(() => {});
    }
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    return;
  }

  const ctx = new AudioCtx();
  const masterGain = ctx.createGain();
  masterGain.gain.value = 1.0;
  masterGain.connect(ctx.destination);

  const hissSource = ctx.createBufferSource();
  hissSource.buffer = createLoopingNoiseBuffer(ctx, 2.5);
  hissSource.loop = true;

  const crackleSource = ctx.createBufferSource();
  crackleSource.buffer = createCrackleBuffer(ctx, 1.6);
  crackleSource.loop = true;

  const noiseHighpass = ctx.createBiquadFilter();
  noiseHighpass.type = "highpass";
  noiseHighpass.frequency.value = 1750;

  const noiseLowpass = ctx.createBiquadFilter();
  noiseLowpass.type = "lowpass";
  noiseLowpass.frequency.value = 3900;

  const noisePresence = ctx.createBiquadFilter();
  noisePresence.type = "peaking";
  noisePresence.frequency.value = 2650;
  noisePresence.Q.value = 1.3;
  noisePresence.gain.value = 4.2;

  const crackleHighpass = ctx.createBiquadFilter();
  crackleHighpass.type = "highpass";
  crackleHighpass.frequency.value = 2500;

  const crackleLowpass = ctx.createBiquadFilter();
  crackleLowpass.type = "lowpass";
  crackleLowpass.frequency.value = 6200;

  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;

  const crackleGain = ctx.createGain();
  crackleGain.gain.value = 0;

  const radioStaticGain = ctx.createGain();
  radioStaticGain.gain.value = 0;

  const blockingToneGain = ctx.createGain();
  blockingToneGain.gain.value = 0;

  const blockOscA = ctx.createOscillator();
  blockOscA.type = "sine";
  blockOscA.frequency.value = 910;

  const blockOscB = ctx.createOscillator();
  blockOscB.type = "square";
  blockOscB.frequency.value = 1280;

  const blockWobble = ctx.createOscillator();
  blockWobble.type = "triangle";
  blockWobble.frequency.value = 19;

  const blockWobbleDepth = ctx.createGain();
  blockWobbleDepth.gain.value = 10;

  const noiseFlutter = ctx.createOscillator();
  noiseFlutter.type = "triangle";
  noiseFlutter.frequency.value = 5.2;

  const noiseFlutterDepth = ctx.createGain();
  noiseFlutterDepth.gain.value = 0;

  hissSource.connect(noiseHighpass);
  noiseHighpass.connect(noiseLowpass);
  noiseLowpass.connect(noisePresence);
  noisePresence.connect(noiseGain);

  crackleSource.connect(crackleHighpass);
  crackleHighpass.connect(crackleLowpass);
  crackleLowpass.connect(crackleGain);

  noiseFlutter.connect(noiseFlutterDepth);
  noiseFlutterDepth.connect(noiseGain.gain);

  blockWobble.connect(blockWobbleDepth);
  blockWobbleDepth.connect(blockOscA.frequency);
  blockWobbleDepth.connect(blockOscB.frequency);

  blockOscA.connect(blockingToneGain);
  blockOscB.connect(blockingToneGain);

  noiseGain.connect(masterGain);
  crackleGain.connect(masterGain);
  radioStaticGain.connect(masterGain);
  blockingToneGain.connect(masterGain);

  hissSource.start();
  crackleSource.start();
  noiseFlutter.start();
  blockOscA.start();
  blockOscB.start();
  blockWobble.start();

  state.audioCtx = ctx;
  state.masterOutput = masterGain;
  state.radioStaticGain = radioStaticGain;
  state.radioNoiseGain = noiseGain;
  state.radioNoiseCrackleGain = crackleGain;
  state.radioNoiseFlutterDepth = noiseFlutterDepth;
  state.blockingToneGain = blockingToneGain;

  if (state.selectedOutputDeviceId) {
    applyAudioContextOutputSink();
  }

  loadRogerBeepSample().catch(() => {
    // Ignore lazy load failures and keep fallback tone.
  });
  loadRadioStaticSample().catch(() => {
    // Ignore lazy load failures and keep fallback static.
  });
}

function updateNoiseLevel(active) {
  if (!state.audioCtx || !state.radioNoiseGain || !state.radioNoiseCrackleGain || !state.radioNoiseFlutterDepth) {
    return;
  }

  const now = state.audioCtx.currentTime;
  state.radioNoiseGain.gain.cancelScheduledValues(now);
  state.radioNoiseCrackleGain.gain.cancelScheduledValues(now);
  state.radioNoiseFlutterDepth.gain.cancelScheduledValues(now);
  if (state.radioStaticGain) {
    state.radioStaticGain.gain.cancelScheduledValues(now);
  }

  const hasExternalStatic = Boolean(state.radioStaticBuffer && state.radioStaticGain);
  if (hasExternalStatic) {
    ensureRadioStaticSource();
  }

  if (!active) {
    if (state.radioStaticGain) {
      state.radioStaticGain.gain.setValueAtTime(0, now);
    }
    state.radioNoiseGain.gain.setValueAtTime(0, now);
    state.radioNoiseCrackleGain.gain.setValueAtTime(0, now);
    state.radioNoiseFlutterDepth.gain.setValueAtTime(0, now);
    return;
  }

  if (hasExternalStatic && state.radioStaticGain) {
    state.radioStaticGain.gain.setValueAtTime(0.11, now);
    state.radioNoiseGain.gain.setValueAtTime(0, now);
    state.radioNoiseCrackleGain.gain.setValueAtTime(0, now);
    state.radioNoiseFlutterDepth.gain.setValueAtTime(0, now);
    return;
  }

  state.radioNoiseGain.gain.setValueAtTime(0.0065, now);
  state.radioNoiseCrackleGain.gain.setValueAtTime(0.0055, now);
  state.radioNoiseFlutterDepth.gain.setValueAtTime(0.0008, now);
}

function cutNoiseNow() {
  if (!state.audioCtx || !state.radioNoiseGain) {
    return;
  }

  const now = state.audioCtx.currentTime;
  if (state.radioStaticGain) {
    state.radioStaticGain.gain.cancelScheduledValues(now);
    state.radioStaticGain.gain.setValueAtTime(0, now);
  }
  state.radioNoiseGain.gain.cancelScheduledValues(now);
  state.radioNoiseGain.gain.setValueAtTime(0, now);

  if (state.radioNoiseCrackleGain) {
    state.radioNoiseCrackleGain.gain.cancelScheduledValues(now);
    state.radioNoiseCrackleGain.gain.setValueAtTime(0, now);
  }

  if (state.radioNoiseFlutterDepth) {
    state.radioNoiseFlutterDepth.gain.cancelScheduledValues(now);
    state.radioNoiseFlutterDepth.gain.setValueAtTime(0, now);
  }
}

// Squelch open: short decaying noise burst (the gate-open "pop") when RX begins
function playSquelchOpen() {
  if (!state.audioCtx || !state.masterOutput) return;
  const ctx = state.audioCtx;
  const out = state.masterOutput;
  const now = ctx.currentTime;

  const sampleCount = Math.floor(ctx.sampleRate * 0.014);
  const buf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    ch[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleCount * 0.28));
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1900;
  bp.Q.value = 0.55;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, now);
  g.gain.linearRampToValueAtTime(0, now + 0.014);

  src.connect(bp);
  bp.connect(g);
  g.connect(out);
  src.start(now);
}

// Squelch close: noise burst then sharp cut — classic squelch tail
function playSquelchClose() {
  if (!state.audioCtx) return;
  const ctx = state.audioCtx;
  const now = ctx.currentTime;
  const sg = state.radioStaticGain;
  const ng = state.radioNoiseGain;
  const cg = state.radioNoiseCrackleGain;
  const fd = state.radioNoiseFlutterDepth;

  if (sg) sg.gain.cancelScheduledValues(now);
  ng.gain.cancelScheduledValues(now);
  if (cg) cg.gain.cancelScheduledValues(now);
  if (fd) fd.gain.cancelScheduledValues(now);

  // Instant burst
  if (sg) sg.gain.setValueAtTime(0.19, now);
  ng.gain.setValueAtTime(0.12, now);
  if (cg) cg.gain.setValueAtTime(0.09, now);
  if (fd) fd.gain.setValueAtTime(0, now);

  // Hold ~75 ms then cut sharply over 12 ms
  const holdEnd = now + 0.075;
  if (sg) {
    sg.gain.setValueAtTime(0.19, holdEnd);
    sg.gain.linearRampToValueAtTime(0, holdEnd + 0.012);
  }
  ng.gain.setValueAtTime(0.12, holdEnd);
  ng.gain.linearRampToValueAtTime(0, holdEnd + 0.012);
  if (cg) {
    cg.gain.setValueAtTime(0.09, holdEnd);
    cg.gain.linearRampToValueAtTime(0, holdEnd + 0.012);
  }
}

function shouldPlayBlockingTone() {
  const hasContention = Boolean(state.currentHolderId) && state.currentQueue.length > 0;
  const hasActiveRx = Boolean(state.activeSpeakerId);
  const selfIsHolder = Boolean(state.selfId) && state.selfId === state.currentHolderId;
  const selfIsQueued = Boolean(state.selfId) && state.currentQueue.includes(state.selfId);
  const selfIsTransmitting = state.txGranted || state.isPttPressed;
  return hasContention && hasActiveRx && !selfIsHolder && !selfIsQueued && !selfIsTransmitting;
}

function syncBlockingTone() {
  if (!state.audioCtx || !state.blockingToneGain) {
    return;
  }

  const now = state.audioCtx.currentTime;
  const active = shouldPlayBlockingTone();
  state.blockingToneGain.gain.cancelScheduledValues(now);
  state.blockingToneGain.gain.setTargetAtTime(active ? 0.013 : 0, now, 0.03);
}

function playRogerBeep() {
  if (!state.audioCtx) {
    return;
  }

  const ctx = state.audioCtx;
  const out = state.masterOutput || ctx.destination;
  const now = ctx.currentTime;

  if (now - state.lastRogerAt < 0.14) {
    return;
  }
  state.lastRogerAt = now;

  if (state.rogerBeepBuffer) {
    const sampleSource = ctx.createBufferSource();
    sampleSource.buffer = state.rogerBeepBuffer;

    const sampleGain = ctx.createGain();
    sampleGain.gain.setValueAtTime(0.95, now);

    sampleSource.connect(sampleGain);
    sampleGain.connect(out);
    sampleSource.start(now);

    setTimeout(() => {
      try {
        sampleGain.disconnect();
      } catch (_err) {
        // Ignore sample beep cleanup race conditions.
      }
    }, 400);
    return;
  }

  if (!state.rogerBeepLoading) {
    loadRogerBeepSample().catch(() => {
      // Ignore lazy load failures and keep fallback tone.
    });
  }

  const beepOsc = ctx.createOscillator();
  beepOsc.type = "sine";
  beepOsc.frequency.setValueAtTime(1880, now);
  beepOsc.frequency.setValueAtTime(1450, now + 0.05);

  const beepBandpass = ctx.createBiquadFilter();
  beepBandpass.type = "bandpass";
  beepBandpass.frequency.value = 1650;
  beepBandpass.Q.value = 1.2;

  const beepGain = ctx.createGain();
  beepGain.gain.setValueAtTime(0.0001, now);
  beepGain.gain.exponentialRampToValueAtTime(0.085, now + 0.002);
  beepGain.gain.exponentialRampToValueAtTime(0.065, now + 0.05);
  beepGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

  beepOsc.connect(beepBandpass);
  beepBandpass.connect(beepGain);
  beepGain.connect(out);

  beepOsc.start(now);
  beepOsc.stop(now + 0.112);

  setTimeout(() => {
    try {
      beepBandpass.disconnect();
      beepGain.disconnect();
    } catch (_err) {
      // Ignore beep cleanup race conditions.
    }
  }, 170);
}

function playEndTransmissionTail() {
  if (!state.audioCtx) {
    return;
  }

  const ctx = state.audioCtx;
  const out = state.masterOutput || ctx.destination;
  const now = ctx.currentTime;

  if (now - state.lastEotAt < 0.18) {
    return;
  }
  state.lastEotAt = now;

  playRogerBeep();

  const tailMix = ctx.createGain();
  tailMix.gain.setValueAtTime(0.0001, now);
  tailMix.gain.exponentialRampToValueAtTime(0.1, now + 0.004);
  tailMix.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
  tailMix.connect(out);

  const burst = ctx.createBufferSource();
  burst.buffer = createCrackleBuffer(ctx, 0.12);

  const burstHighpass = ctx.createBiquadFilter();
  burstHighpass.type = "highpass";
  burstHighpass.frequency.value = 1700;

  const burstLowpass = ctx.createBiquadFilter();
  burstLowpass.type = "lowpass";
  burstLowpass.frequency.value = 5000;

  const burstGain = ctx.createGain();
  burstGain.gain.setValueAtTime(0.0001, now);
  burstGain.gain.exponentialRampToValueAtTime(0.32, now + 0.006);
  burstGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

  const chirp = ctx.createOscillator();
  chirp.type = "triangle";
  chirp.frequency.setValueAtTime(1450, now);
  chirp.frequency.exponentialRampToValueAtTime(900, now + 0.1);

  const chirpGain = ctx.createGain();
  chirpGain.gain.setValueAtTime(0.0001, now);
  chirpGain.gain.exponentialRampToValueAtTime(0.018, now + 0.004);
  chirpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);

  burst.connect(burstHighpass);
  burstHighpass.connect(burstLowpass);
  burstLowpass.connect(burstGain);
  burstGain.connect(tailMix);

  chirp.connect(chirpGain);
  chirpGain.connect(tailMix);

  burst.start(now);
  burst.stop(now + 0.12);
  chirp.start(now);
  chirp.stop(now + 0.11);

  setTimeout(() => {
    try {
      tailMix.disconnect();
      burstGain.disconnect();
      chirpGain.disconnect();
      burstHighpass.disconnect();
      burstLowpass.disconnect();
    } catch (_err) {
      // Ignore tail cleanup race conditions.
    }
  }, 160);
}

function playPttClick(isDown) {
  if (!state.audioCtx) {
    return;
  }

  const ctx = state.audioCtx;
  const out = state.masterOutput || ctx.destination;
  const now = ctx.currentTime;

  const clickMix = ctx.createGain();
  clickMix.gain.setValueAtTime(0.0001, now);
  clickMix.gain.exponentialRampToValueAtTime(isDown ? 0.038 : 0.03, now + 0.002);
  clickMix.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
  clickMix.connect(out);

  const clickOsc = ctx.createOscillator();
  clickOsc.type = "triangle";
  clickOsc.frequency.setValueAtTime(isDown ? 1750 : 1320, now);
  clickOsc.frequency.exponentialRampToValueAtTime(isDown ? 980 : 760, now + 0.028);

  const toneFilter = ctx.createBiquadFilter();
  toneFilter.type = "highpass";
  toneFilter.frequency.value = 580;

  const toneGain = ctx.createGain();
  toneGain.gain.setValueAtTime(0.0001, now);
  toneGain.gain.exponentialRampToValueAtTime(0.12, now + 0.0015);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.028);

  clickOsc.connect(toneFilter);
  toneFilter.connect(toneGain);
  toneGain.connect(clickMix);

  clickOsc.start(now);
  clickOsc.stop(now + 0.03);

  setTimeout(() => {
    try {
      clickMix.disconnect();
      toneFilter.disconnect();
      toneGain.disconnect();
    } catch (_err) {
      // Ignore click cleanup race conditions.
    }
  }, 80);
}

function connectPeerAudio(peer, stream) {
  if (!state.audioCtx) {
    return;
  }

  if (peer.sourceNode) {
    try {
      peer.sourceNode.disconnect();
    } catch (_err) {
      // Ignore stale graph disconnection errors from previous tracks.
    }
  }

  if (!peer.peerGainNode) {
    peer.peerGainNode = state.audioCtx.createGain();
    peer.peerGainNode.gain.value = 0;

    // ── Pre-amp: boost input into clipping stage ──────────────────────
    const preGain = state.audioCtx.createGain();
    preGain.gain.value = 3.5;

    // ── Stage 1: steep highpass × 2 (12 dB + 12 dB = 24 dB/oct) ──────
    const radioHighpass = state.audioCtx.createBiquadFilter();
    radioHighpass.type = "highpass";
    radioHighpass.frequency.value = 430;
    radioHighpass.Q.value = 0.85;

    const radioHighpass2 = state.audioCtx.createBiquadFilter();
    radioHighpass2.type = "highpass";
    radioHighpass2.frequency.value = 430;
    radioHighpass2.Q.value = 0.85;

    // ── Stage 2: tighter lowpass (radio bandwidth ≈ 300-2500 Hz) ──────
    const radioLowpass = state.audioCtx.createBiquadFilter();
    radioLowpass.type = "lowpass";
    radioLowpass.frequency.value = 2450;
    radioLowpass.Q.value = 1.1;

    // ── Stage 3: cut low-mid mud ───────────────────────────────────────
    const lowMidDip = state.audioCtx.createBiquadFilter();
    lowMidDip.type = "peaking";
    lowMidDip.frequency.value = 580;
    lowMidDip.Q.value = 1.5;
    lowMidDip.gain.value = -6;

    // ── Stage 4: presence boost (intelligibility) ──────────────────────
    const presencePeak = state.audioCtx.createBiquadFilter();
    presencePeak.type = "peaking";
    presencePeak.frequency.value = 1900;
    presencePeak.Q.value = 1.8;
    presencePeak.gain.value = 7;

    // ── Stage 5: speaker-box resonance (~1.1 kHz honk) ────────────────
    const boxResonance = state.audioCtx.createBiquadFilter();
    boxResonance.type = "peaking";
    boxResonance.frequency.value = 1100;
    boxResonance.Q.value = 3.2;
    boxResonance.gain.value = 4;

    // ── Stage 6: hard RF saturation ───────────────────────────────────
    const radioDrive = state.audioCtx.createWaveShaper();
    radioDrive.curve = createRadioSaturationCurve(260);
    radioDrive.oversample = "4x";

    // ── Stage 7: post-clip bandpass to clean out-of-band artifacts ────
    const postHP = state.audioCtx.createBiquadFilter();
    postHP.type = "highpass";
    postHP.frequency.value = 380;
    postHP.Q.value = 0.7;

    const postLP = state.audioCtx.createBiquadFilter();
    postLP.type = "lowpass";
    postLP.frequency.value = 2700;
    postLP.Q.value = 0.7;

    // ── Stage 8: brutal AGC (real radio limiter) ───────────────────────
    const radioCompressor = state.audioCtx.createDynamicsCompressor();
    radioCompressor.threshold.value = -20;
    radioCompressor.knee.value = 3;
    radioCompressor.ratio.value = 16;
    radioCompressor.attack.value = 0.001;
    radioCompressor.release.value = 0.055;

    const radioBoost = state.audioCtx.createGain();
    radioBoost.gain.value = 1.6;

    const rxAnalyser = state.audioCtx.createAnalyser();
    rxAnalyser.fftSize = 256;
    rxAnalyser.smoothingTimeConstant = 0.7;

    peer.peerGainNode.connect(preGain);
    preGain.connect(radioHighpass);
    radioHighpass.connect(radioHighpass2);
    radioHighpass2.connect(radioLowpass);
    radioLowpass.connect(lowMidDip);
    lowMidDip.connect(presencePeak);
    presencePeak.connect(boxResonance);
    boxResonance.connect(radioDrive);
    radioDrive.connect(postHP);
    postHP.connect(postLP);
    postLP.connect(radioCompressor);
    radioCompressor.connect(radioBoost);
    radioBoost.connect(rxAnalyser);
    rxAnalyser.connect(state.masterOutput || state.audioCtx.destination);

    peer.radioHighpass = radioHighpass;
    peer.radioLowpass = radioLowpass;
    peer.lowMidDip = lowMidDip;
    peer.presencePeak = presencePeak;
    peer.radioDrive = radioDrive;
    peer.radioCompressor = radioCompressor;
    peer.radioBoost = radioBoost;
    peer.rxAnalyserNode = rxAnalyser;
  }

  peer.sourceNode = state.audioCtx.createMediaStreamSource(stream);
  peer.sourceNode.connect(peer.peerGainNode);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function setChannelState(message) {
  channelStateEl.textContent = message;
}

function wsSend(type, payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.ws.send(JSON.stringify({ type, payload }));
}

function refreshPeerList() {
  peersEl.innerHTML = "";

  const entries = [...state.peers.entries()];
  const hasSelf = Boolean(state.selfId);

  if (!hasSelf && entries.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No peers connected yet";
    peersEl.appendChild(li);
    return;
  }

  if (hasSelf) {
    const selfLi = document.createElement("li");
    selfLi.textContent = `You (${state.selfName || state.selfId.slice(0, 8)}) | ${getParticipantStatus(state.selfId)}`;
    peersEl.appendChild(selfLi);
  }

  for (const [peerId, peer] of entries) {
    const li = document.createElement("li");
    li.textContent = `${peer.name || peerId} | ${peer.role || "operator"} | line ${peer.line || "?"} | ${getParticipantStatus(peerId)}`;
    peersEl.appendChild(li);
  }
}

function ensurePeer(peerInfo) {
  if (state.peers.has(peerInfo.id)) {
    const existing = state.peers.get(peerInfo.id);
    existing.name = peerInfo.name;
    existing.role = peerInfo.role;
    existing.line = peerInfo.line;
    return existing;
  }

  const pc = new RTCPeerConnection(stunConfig);

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      pc.addTrack(track, state.localStream);
    }
  }

  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.muted = true;
  audio.volume = 0;
  applyAudioOutputSink(audio);

  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0];
    audio.play().catch(() => {
      // Playback may need a user gesture on some browsers.
    });
    connectPeerAudio(peer, event.streams[0]);
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }

    wsSend("signal", {
      to: peerInfo.id,
      data: {
        candidate: event.candidate
      }
    });
  };

  const peer = {
    id: peerInfo.id,
    name: peerInfo.name,
    role: peerInfo.role,
    line: peerInfo.line,
    pc,
    audio,
    sourceNode: null,
    peerGainNode: null,
    radioHighpass: null,
    radioLowpass: null,
    lowMidDip: null,
    presencePeak: null,
    radioDrive: null,
    radioCompressor: null,
    radioBoost: null,
    rxAnalyserNode: null
  };

  state.peers.set(peerInfo.id, peer);
  refreshPeerList();
  return peer;
}

async function createOffer(peerInfo) {
  const peer = ensurePeer(peerInfo);
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);

  wsSend("signal", {
    to: peer.id,
    data: {
      description: peer.pc.localDescription
    }
  });
}

async function handleSignal(from, data) {
  const peer = ensurePeer({ id: from, name: from, role: "operator", line: "?" });

  if (data.description) {
    const desc = data.description;
    await peer.pc.setRemoteDescription(desc);

    if (desc.type === "offer") {
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      wsSend("signal", {
        to: from,
        data: {
          description: peer.pc.localDescription
        }
      });
    }
    return;
  }

  if (data.candidate) {
    await peer.pc.addIceCandidate(data.candidate);
  }
}

function applyTxState(payload) {
  state.activeSpeakerId = payload.active ? payload.speakerId : null;
  state.activeChannel = payload.active ? payload.channel : null;
  let isReceivingAudio = false;

  for (const [peerId, peer] of state.peers.entries()) {
    if (payload.active && peerId === payload.speakerId) {
      routePeerAudio(peer, true);
      isReceivingAudio = true;
    } else {
      routePeerAudio(peer, false);
    }
  }

  const startedTransmission = !state.lastRxActive && isReceivingAudio;
  const endedTransmission = state.lastRxActive && !isReceivingAudio && !state.txGranted;

  if (startedTransmission) {
    playSquelchOpen();
    updateNoiseLevel(true);
  } else if (endedTransmission) {
    playEndTransmissionTail();
    playSquelchClose(); // schedules noise burst+cut; skip updateNoiseLevel(false)
  } else {
    updateNoiseLevel(isReceivingAudio);
  }

  state.lastRxActive = isReceivingAudio;
  syncBlockingTone();

  if (!payload.active) {
    setChannelState("Channel idle");
    return;
  }

  setChannelState(`RX ${payload.channel.toUpperCase()} from ${payload.speakerId.slice(0, 8)}`);
}

function setTx(enabled) {
  state.txGranted = enabled;
  if (state.localTrack) {
    state.localTrack.enabled = enabled;
  }

  if (enabled) {
    pttBtn.classList.add("active");
    setStatus("Transmitting");
  } else {
    pttBtn.classList.remove("active");
    setStatus("Connected (listening)");
  }

  updateSelfStatus();
  syncBlockingTone();
}

function updatePresence() {
  wsSend("set-presence", {
    line: lineEl.value,
    trainId: trainIdEl.value
  });
}

async function getMicrophoneStream() {
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(state.selectedMicDeviceId ? { deviceId: { exact: state.selectedMicDeviceId } } : {})
    }
  };

  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (!state.selectedMicDeviceId) {
        throw err;
      }

      state.selectedMicDeviceId = "";
      if (micSelectEl) {
        micSelectEl.value = "";
      }
      saveSettings();
      setStatus("Selected microphone unavailable, using default mic");

      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    }
  }

  const legacyGetUserMedia =
    navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;

  if (typeof legacyGetUserMedia === "function") {
    return new Promise((resolve, reject) => {
      legacyGetUserMedia.call(navigator, constraints, resolve, reject);
    });
  }

  const host = String(location.hostname || "").toLowerCase();
  const isLikelyInsecure = !window.isSecureContext && host !== "localhost" && host !== "127.0.0.1";

  if (isLikelyInsecure) {
    throw new Error("Microphone requires HTTPS on phones. Open this app over HTTPS.");
  }

  throw new Error("Microphone API is not available on this browser.");
}

function createBoostedMicrophoneStream(rawStream) {
  // Mirror mic stream into an analyser so LCD can show local TX level.
  if (state.audioCtx && rawStream.getAudioTracks().length > 0) {
    if (state.micAnalyserSourceNode) {
      try {
        state.micAnalyserSourceNode.disconnect();
      } catch (_err) {
        // Ignore stale analyser source teardown errors.
      }
      state.micAnalyserSourceNode = null;
    }

    state.micAnalyserNode = state.audioCtx.createAnalyser();
    state.micAnalyserNode.fftSize = 256;
    state.micAnalyserNode.smoothingTimeConstant = 0.75;

    state.micAnalyserSourceNode = state.audioCtx.createMediaStreamSource(rawStream);
    state.micAnalyserSourceNode.connect(state.micAnalyserNode);
  }

  // Return the raw stream unmodified to preserve audio quality
  return rawStream;
}

function startMicVisualization() {
  if (state.micVisualizerAnimationId) {
    cancelAnimationFrame(state.micVisualizerAnimationId);
  }

  const canvas = document.getElementById("micCanvas");
  if (!canvas) return;

  function animateVisualizer() {
    drawMicVisualizer(canvas);
    state.micVisualizerAnimationId = requestAnimationFrame(animateVisualizer);
  }

  animateVisualizer();
}

function drawMicVisualizer(canvas) {
  if (!canvas) return;

  let analyser = null;
  const isReceiverRx = Boolean(
    state.lastRxActive &&
    state.activeSpeakerId &&
    state.selfId &&
    state.activeSpeakerId !== state.selfId &&
    !state.isPttPressed &&
    !state.txGranted
  );

  if (isReceiverRx) {
    const activePeer = state.peers.get(state.activeSpeakerId);
    if (activePeer && activePeer.rxAnalyserNode) {
      analyser = activePeer.rxAnalyserNode;
    }
  }

  if (!analyser && !isReceiverRx) {
    analyser = state.micAnalyserNode;
  }

  if (!analyser) return;

  const ctx = canvas.getContext("2d");
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  analyser.getByteFrequencyData(dataArray);

  const width = canvas.width;
  const height = canvas.height;

  // Calculate average level
  let sum = 0;
  for (let i = 0; i < bufferLength; i++) {
    sum += dataArray[i];
  }
  const average = sum / bufferLength;
  const level = Math.min(1.0, average / 255);

  // Clear canvas
  ctx.fillStyle = "#91a37e";
  ctx.fillRect(0, 0, width, height);

  // Draw bars with color grading
  const barWidth = width / bufferLength * 2.5;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const barHeight = (dataArray[i] / 255) * height;

    // LCD-styled color range: muted green -> olive -> deep amber
    let color;
    const normalizedHeight = barHeight / height;
    if (normalizedHeight < 0.42) {
      color = "#2b4d24";
    } else if (normalizedHeight < 0.76) {
      color = "#4c6a34";
    } else {
      color = "#6c6418";
    }

    ctx.fillStyle = color;
    ctx.fillRect(x, height - barHeight, barWidth, barHeight);

    x += barWidth;
  }

  // Draw level indicator at bottom
  const levelWidth = (width * level);
  const levelGradient = ctx.createLinearGradient(0, height - 4, levelWidth, height - 4);
  
  if (level < 0.42) {
    levelGradient.addColorStop(0, "#2b4d24");
    levelGradient.addColorStop(1, "#355a2b");
  } else if (level < 0.76) {
    levelGradient.addColorStop(0, "#355a2b");
    levelGradient.addColorStop(1, "#4f6f36");
  } else {
    levelGradient.addColorStop(0, "#4f6f36");
    levelGradient.addColorStop(1, "#6c6418");
  }

  ctx.fillStyle = levelGradient;
  ctx.fillRect(0, height - 3, levelWidth, 3);
}

async function join() {
  if (state.ws) {
    state.ws.close();
  }

  const authed = await ensureAuthenticated();
  if (!authed) {
    setPowerState("off");
    setServerStatus("Server: auth required");
    return;
  }

  setPowerState("connecting");

  initAudioEngine();
  const rawStream = await getMicrophoneStream();
  state.localStream = createBoostedMicrophoneStream(rawStream);
  state.localTrack = state.localStream.getAudioTracks()[0];
  state.localTrack.enabled = false;

  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  const wsBaseUrl = `${wsProtocol}://${location.host}`;
  const wsUrl = authToken ? `${wsBaseUrl}?token=${encodeURIComponent(authToken)}` : wsBaseUrl;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    setPowerState("on");
    setServerStatus("Server: online (connected)");
    setUserStatus("User: joining...");

    wsSend("join", {
      role: roleEl.value,
      line: lineEl.value,
      trainId: trainIdEl.value
    });

    setStatus("Joining room...");
  };

  state.ws.onclose = (event) => {
    setPowerState("off");
    setServerStatus("Server: checking...");
    const closeCode = event && typeof event.code === "number" ? event.code : 0;
    const closeReason = event && event.reason ? ` (${event.reason})` : "";
    setStatus(`Disconnected [${closeCode}]${closeReason}`);
    pttBtn.disabled = true;
    setTx(false);
    updateNoiseLevel(false);

    if (state.micVisualizerAnimationId) {
      cancelAnimationFrame(state.micVisualizerAnimationId);
      state.micVisualizerAnimationId = null;
    }
    if (state.micAnalyserSourceNode) {
      try {
        state.micAnalyserSourceNode.disconnect();
      } catch (_err) {
        // Ignore analyser cleanup errors.
      }
      state.micAnalyserSourceNode = null;
    }

    state.selfId = null;
    state.selfName = "";
    state.currentHolderId = null;
    state.currentQueue = [];
    state.activeSpeakerId = null;
    state.activeChannel = null;
    state.peers.clear();
    refreshPeerList();
    updateSelfStatus();
    syncBlockingTone();
    probeServerStatus();
  };

  state.ws.onerror = () => {
    setPowerState("off");
    setServerStatus("Server: checking...");
    setStatus("WebSocket handshake failed");
    syncBlockingTone();
    probeServerStatus();
  };

  state.ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "joined") {
      state.selfId = msg.payload.self.id;
      state.selfName = msg.payload.self.name || "";
      pttBtn.disabled = false;
      setStatus(`Connected as ${msg.payload.self.name}`);
      initAudioEngine();
      startMicVisualization();
      refreshPeerList();
      updateSelfStatus();

      for (const peerInfo of msg.payload.peers) {
        await createOffer(peerInfo);
      }

      return;
    }

    if (msg.type === "peer-joined") {
      ensurePeer(msg.payload);
      return;
    }

    if (msg.type === "peer-updated") {
      ensurePeer(msg.payload);
      refreshPeerList();
      return;
    }

    if (msg.type === "peer-left") {
      const peer = state.peers.get(msg.payload.id);
      if (peer) {
        peer.pc.close();
        if (peer.sourceNode) {
          try {
            peer.sourceNode.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.peerGainNode) {
          try {
            peer.peerGainNode.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.radioHighpass) {
          try {
            peer.radioHighpass.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.radioLowpass) {
          try {
            peer.radioLowpass.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.lowMidDip) {
          try {
            peer.lowMidDip.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.presencePeak) {
          try {
            peer.presencePeak.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.radioDrive) {
          try {
            peer.radioDrive.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.radioCompressor) {
          try {
            peer.radioCompressor.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.radioBoost) {
          try {
            peer.radioBoost.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
        if (peer.rxAnalyserNode) {
          try {
            peer.rxAnalyserNode.disconnect();
          } catch (_err) {
            // Ignore cleanup errors.
          }
        }
      }
      state.peers.delete(msg.payload.id);
      refreshPeerList();
      return;
    }

    if (msg.type === "signal") {
      await handleSignal(msg.payload.from, msg.payload.data);
      return;
    }

    if (msg.type === "ptt-granted") {
      setTx(true);
      setChannelState(`TX granted on ${msg.payload.channel}`);
      return;
    }

    if (msg.type === "ptt-queued") {
      setTx(false);
      setChannelState(`Queued on ${msg.payload.channel}, position ${msg.payload.position}`);
      setUserStatus(`User: queued (#${msg.payload.position})`);
      return;
    }

    if (msg.type === "ptt-released" || msg.type === "ptt-revoked") {
      setTx(false);
      cutNoiseNow();
      setChannelState(msg.type === "ptt-released" ? "TX released" : "TX revoked");
      return;
    }

    if (msg.type === "tx-state") {
      applyTxState(msg.payload);
      return;
    }

    if (msg.type === "channel-state") {
      state.currentHolderId = msg.payload.holderId || null;
      state.currentQueue = Array.isArray(msg.payload.queue) ? msg.payload.queue : [];
      refreshPeerList();
      updateSelfStatus();
      syncBlockingTone();
      return;
    }

    if (msg.type === "error") {
      setStatus(`Server error: ${msg.payload.message}`);
    }
  };
}

joinBtn.addEventListener("click", () => {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    setStatus("Disconnecting...");
    state.ws.close();
    return;
  }

  join().catch((err) => {
    setPowerState("off");
    setStatus(`Join failed: ${err.message}`);
  });
});

lineEl.addEventListener("change", updatePresence);
trainIdEl.addEventListener("change", updatePresence);

function muteAllPeers(muted) {
  for (const peer of state.peers.values()) {
    if (peer.peerGainNode) {
      peer.peerGainNode.gain.value = muted ? 0 : 1.0;
    }
    if (peer.audio) {
      peer.audio.muted = muted || !state.cleanMonitorEnabled;
      peer.audio.volume = muted ? 0 : 1.0;
    }
  }
}

function pttDown() {
  if (state.powerMode !== "on") {
    return;
  }

  if (state.isPttPressed) {
    return;
  }

  state.isPttPressed = true;
  initAudioEngine();
  unlockRemoteAudio();
  muteAllPeers(true);
  syncBlockingTone();
  playPttClick(true);
  wsSend("ptt-request", { channel: FIXED_CHANNEL });
}

function pttUp() {
  if (!state.isPttPressed) {
    return;
  }

  state.isPttPressed = false;
  wsSend("ptt-release", {});
  playRogerBeep();
  playPttClick(false);
  cutNoiseNow();
  applyCurrentMonitorRouting();
  syncBlockingTone();
}

function forcePttRelease() {
  if (!state.isPttPressed) {
    return;
  }

  pttUp();
}

pttBtn.addEventListener("mousedown", pttDown);
pttBtn.addEventListener("mouseup", pttUp);
pttBtn.addEventListener("mouseleave", pttUp);
pttBtn.addEventListener("touchstart", (event) => {
  event.preventDefault();
  pttDown();
}, { passive: false });
pttBtn.addEventListener("touchend", (event) => {
  event.preventDefault();
  pttUp();
}, { passive: false });
pttBtn.addEventListener("touchcancel", pttUp, { passive: true });
pttBtn.addEventListener("pointerdown", pttDown);
pttBtn.addEventListener("pointerup", pttUp);
pttBtn.addEventListener("pointercancel", pttUp);

window.addEventListener("keydown", (event) => {
  if (event.code === state.pttKeyCode) {
    if (event.repeat) {
      return;
    }
    event.preventDefault();
    initAudioEngine();
    pttDown();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === state.pttKeyCode) {
    event.preventDefault();
    pttUp();
  }
});

window.addEventListener("pointerdown", () => {
  initAudioEngine();
  unlockRemoteAudio();
});

window.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    forcePttRelease();
  }
});

window.addEventListener("blur", () => {
  forcePttRelease();
});

loadSettings();

if (cleanCheckBtn) {
  cleanCheckBtn.addEventListener("click", () => {
    state.cleanMonitorEnabled = !state.cleanMonitorEnabled;
    updateCleanCheckButton();
    applyCurrentMonitorRouting();
    setStatus(state.cleanMonitorEnabled ? "Audio filter bypassed" : "Audio filter enabled");
  });
}

if (opsTabBtnEl && settingsTabBtnEl) {
  opsTabBtnEl.addEventListener("click", () => setActiveTab(false));
  settingsTabBtnEl.addEventListener("click", async () => {
    setActiveTab(true);
    await populateDeviceSelectors();
  });
}

function friendlyKeyName(code) {
  const map = {
    Space: "Space", Enter: "Enter", Escape: "Escape", Tab: "Tab",
    Backspace: "Backspace", Delete: "Delete",
    ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
    ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
    AltLeft: "Left Alt", AltRight: "Right Alt",
    MetaLeft: "Left Win", MetaRight: "Right Win",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  };
  if (map[code]) return map[code];
  // KeyA → A, Digit1 → 1, Numpad0 → Num0, F1 → F1
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad(.+)$/.test(code)) return "Num" + code.slice(6);
  return code;
}

if (pttKeyCaptureEl) {
  pttKeyCaptureEl.textContent = friendlyKeyName(state.pttKeyCode);

  pttKeyCaptureEl.addEventListener("click", () => {
    if (pttKeyCaptureEl.classList.contains("capturing")) return;
    pttKeyCaptureEl.classList.add("capturing");
    pttKeyCaptureEl.textContent = "Press a key…";

    function onCapture(e) {
      e.preventDefault();
      e.stopPropagation();
      // Ignore bare modifier-only presses so user can combine
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      state.pttKeyCode = e.code;
      saveSettings();
      pttKeyCaptureEl.classList.remove("capturing");
      pttKeyCaptureEl.textContent = friendlyKeyName(e.code);
      setStatus(`PTT key set to ${friendlyKeyName(e.code)}`);
      window.removeEventListener("keydown", onCapture, true);
    }
    window.addEventListener("keydown", onCapture, true);
  });
}

if (micSelectEl) {
  micSelectEl.addEventListener("change", async () => {
    await switchMicrophone(micSelectEl.value || "");
  });
}

if (outputSelectEl) {
  outputSelectEl.addEventListener("change", async () => {
    state.selectedOutputDeviceId = outputSelectEl.value || "";
    saveSettings();
    await applyOutputDeviceToPeers();
    setStatus("Audio output updated");
  });
}

if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    populateDeviceSelectors();
  });
}

setActiveTab(false);
populateDeviceSelectors();

updateCleanCheckButton();
setPowerState("off");

setServerStatus("Server: checking...");
setUserStatus("User: offline");
startServerStatusProbe();

// ── Viewport fit: scale the radio to fill the screen without scroll ──
(function initViewportFit() {
  const wrapper = document.querySelector(".apx-wrapper");
  const titlePanel = document.querySelector(".title-panel");
  if (!wrapper) return;

  function fit() {
    // Reset to natural size so we can measure
    wrapper.style.zoom = "1";
    const naturalW = wrapper.offsetWidth;
    const naturalH = wrapper.offsetHeight;

    const titleH = titlePanel ? titlePanel.offsetHeight : 0;
    const shellPad = 10; // top padding + gap
    const availW = window.innerWidth * 0.97;
    const availH = window.innerHeight - titleH - shellPad;

    const scale = Math.min(availW / naturalW, availH / naturalH, 1);
    wrapper.style.zoom = String(Math.max(0.25, scale).toFixed(4));
  }

  window.addEventListener("resize", fit);
  if (document.readyState === "complete") {
    fit();
  } else {
    window.addEventListener("load", fit);
  }
})();
