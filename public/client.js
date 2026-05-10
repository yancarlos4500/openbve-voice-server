const state = {
  ws: null,
  localStream: null,
  localTrack: null,
  audioCtx: null,
  masterOutput: null,
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
  micAnalyserNode: null,
  micVisualizerAnimationId: null,
  cleanMonitorEnabled: false
};

const stunConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const FIXED_CHANNEL = "operations";

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

function setPowerState(mode) {
  if (!radioFrameEl) {
    return;
  }

  radioFrameEl.classList.remove("power-off", "power-connecting", "power-on");
  radioFrameEl.classList.add(`power-${mode}`);

  if (joinBtn) {
    if (mode === "on") {
      joinBtn.textContent = "Connected";
    } else if (mode === "connecting") {
      joinBtn.textContent = "Connecting...";
    } else {
      joinBtn.textContent = "Power + Join";
    }
  }
}

function updateCleanCheckButton() {
  if (!cleanCheckBtn) {
    return;
  }

  cleanCheckBtn.textContent = state.cleanMonitorEnabled ? "Clean Check: On" : "Clean Check: Off";
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

function setUserStatus(message) {
  userStatusEl.textContent = message;
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

async function loadRogerBeepSample() {
  if (!state.audioCtx || state.rogerBeepBuffer || state.rogerBeepLoading) {
    return;
  }

  state.rogerBeepLoading = true;
  try {
    const response = await fetch("radiobeep.wav", { cache: "no-store" });
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
  blockingToneGain.connect(masterGain);

  hissSource.start();
  crackleSource.start();
  noiseFlutter.start();
  blockOscA.start();
  blockOscB.start();
  blockWobble.start();

  state.audioCtx = ctx;
  state.masterOutput = masterGain;
  state.radioNoiseGain = noiseGain;
  state.radioNoiseCrackleGain = crackleGain;
  state.radioNoiseFlutterDepth = noiseFlutterDepth;
  state.blockingToneGain = blockingToneGain;

  loadRogerBeepSample().catch(() => {
    // Ignore lazy load failures and keep fallback tone.
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

  if (!active) {
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

    const radioHighpass = state.audioCtx.createBiquadFilter();
    radioHighpass.type = "highpass";
    radioHighpass.frequency.value = 360;

    const radioLowpass = state.audioCtx.createBiquadFilter();
    radioLowpass.type = "lowpass";
    radioLowpass.frequency.value = 2850;

    const lowMidDip = state.audioCtx.createBiquadFilter();
    lowMidDip.type = "peaking";
    lowMidDip.frequency.value = 650;
    lowMidDip.Q.value = 1.1;
    lowMidDip.gain.value = -3.4;

    const presencePeak = state.audioCtx.createBiquadFilter();
    presencePeak.type = "peaking";
    presencePeak.frequency.value = 1950;
    presencePeak.Q.value = 1.4;
    presencePeak.gain.value = 5.8;

    const radioDrive = state.audioCtx.createWaveShaper();
    radioDrive.curve = createWalkieDistortionCurve(46);
    radioDrive.oversample = "4x";

    const radioCompressor = state.audioCtx.createDynamicsCompressor();
    radioCompressor.threshold.value = -26;
    radioCompressor.knee.value = 10;
    radioCompressor.ratio.value = 6;
    radioCompressor.attack.value = 0.002;
    radioCompressor.release.value = 0.12;

    const radioBoost = state.audioCtx.createGain();
    radioBoost.gain.value = 1.2;

    peer.peerGainNode.connect(radioHighpass);
    radioHighpass.connect(radioLowpass);
    radioLowpass.connect(lowMidDip);
    lowMidDip.connect(presencePeak);
    presencePeak.connect(radioDrive);
    radioDrive.connect(radioCompressor);
    radioCompressor.connect(radioBoost);
    radioBoost.connect(state.masterOutput || state.audioCtx.destination);

    peer.radioHighpass = radioHighpass;
    peer.radioLowpass = radioLowpass;
    peer.lowMidDip = lowMidDip;
    peer.presencePeak = presencePeak;
    peer.radioDrive = radioDrive;
    peer.radioCompressor = radioCompressor;
    peer.radioBoost = radioBoost;
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
    radioBoost: null
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

  const endedTransmission = state.lastRxActive && !isReceivingAudio && !state.txGranted;
  if (endedTransmission) {
    playEndTransmissionTail();
  }

  state.lastRxActive = isReceivingAudio;
  updateNoiseLevel(isReceivingAudio);
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
      autoGainControl: true
    }
  };

  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
    return navigator.mediaDevices.getUserMedia(constraints);
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
  // Store reference for visualization only - don't break the audio chain
  if (state.audioCtx && rawStream.getTracks().length > 0) {
    state.micAnalyserNode = state.audioCtx.createAnalyser();
    state.micAnalyserNode.fftSize = 256;
    // Note: We can't easily analyze local stream, so visualization will be minimal
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
  if (!state.micAnalyserNode || !canvas) return;

  const ctx = canvas.getContext("2d");
  const analyser = state.micAnalyserNode;
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
  ctx.fillStyle = "#0a0e13";
  ctx.fillRect(0, 0, width, height);

  // Draw bars with color grading
  const barWidth = width / bufferLength * 2.5;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    const barHeight = (dataArray[i] / 255) * height;

    // Color gradient: green (good) -> yellow (medium) -> red (loud)
    let color;
    const normalizedHeight = barHeight / height;
    if (normalizedHeight < 0.4) {
      // Green area (quiet)
      color = "#3f9b66";
    } else if (normalizedHeight < 0.7) {
      // Yellow area (medium)
      color = "#f8cf3a";
    } else {
      // Red area (loud)
      color = "#be3843";
    }

    ctx.fillStyle = color;
    ctx.fillRect(x, height - barHeight, barWidth, barHeight);

    x += barWidth;
  }

  // Draw level indicator at bottom
  const levelWidth = (width * level);
  const levelGradient = ctx.createLinearGradient(0, height - 4, levelWidth, height - 4);
  
  if (level < 0.4) {
    levelGradient.addColorStop(0, "#3f9b66");
    levelGradient.addColorStop(1, "#3f9b66");
  } else if (level < 0.7) {
    levelGradient.addColorStop(0, "#3f9b66");
    levelGradient.addColorStop(1, "#f8cf3a");
  } else {
    levelGradient.addColorStop(0, "#f8cf3a");
    levelGradient.addColorStop(1, "#be3843");
  }

  ctx.fillStyle = levelGradient;
  ctx.fillRect(0, height - 3, levelWidth, 3);
}

async function join() {
  if (state.ws) {
    state.ws.close();
  }

  setPowerState("connecting");

  initAudioEngine();
  const rawStream = await getMicrophoneStream();
  state.localStream = createBoostedMicrophoneStream(rawStream);
  state.localTrack = state.localStream.getAudioTracks()[0];
  state.localTrack.enabled = false;

  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${location.host}`;
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    setPowerState("on");
    setServerStatus("Server: connected");
    setUserStatus("User: joining...");

    wsSend("join", {
      role: roleEl.value,
      line: lineEl.value,
      trainId: trainIdEl.value
    });

    setStatus("Joining room...");
  };

  state.ws.onclose = () => {
    setPowerState("off");
    setServerStatus("Server: disconnected");
    setStatus("Disconnected");
    pttBtn.disabled = true;
    setTx(false);
    updateNoiseLevel(false);

    if (state.micVisualizerAnimationId) {
      cancelAnimationFrame(state.micVisualizerAnimationId);
      state.micVisualizerAnimationId = null;
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
  };

  state.ws.onerror = () => {
    setPowerState("off");
    setServerStatus("Server: connection error");
    syncBlockingTone();
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
  if (event.code === "Space") {
    event.preventDefault();
    initAudioEngine();
    pttDown();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "Space") {
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

if (cleanCheckBtn) {
  cleanCheckBtn.addEventListener("click", () => {
    state.cleanMonitorEnabled = !state.cleanMonitorEnabled;
    updateCleanCheckButton();
    applyCurrentMonitorRouting();
    setStatus(state.cleanMonitorEnabled ? "Clean monitor enabled" : "Radio FX monitor enabled");
  });
}

updateCleanCheckButton();
setPowerState("off");

setServerStatus("Server: disconnected");
setUserStatus("User: offline");
