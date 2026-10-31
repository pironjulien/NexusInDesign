"use strict";

const indesign = require("indesign");
const uxp = require("uxp");
const { app } = indesign;
const { entrypoints, storage } = uxp;
const { createCommandRegistry, executeCommand } = require("./commands");
const { CommandError, assertSafeJson } = require("./validation");
const {
  bytesToHex,
  canonicalCommand,
  importHmacKey,
  resolveCryptoApi,
  signHmacHex,
  utf8Encode,
  verifyHmacHex
} = require("./security-crypto");

const PLUGIN_ID = "fr.pironjulien.indesign.mcp";
const PLUGIN_VERSION = "3.2.2";
const BRIDGE_URL = "ws://127.0.0.1:33171";
const SECRET_KEY = "indesign-mcp-shared-secret-v1";
const PAIR_WINDOW_MS = 5 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 5000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const NONCE_TTL_MS = 15 * 60 * 1000;
const cryptoApi = resolveCryptoApi();

const commandRegistry = createCommandRegistry(app, indesign, uxp, require);

let socket = null;
let reconnectTimer = null;
let connectionTimer = null;
let reconnectAttempt = 0;
let sharedSecret = null;
let hmacKey = null;
let authenticated = false;
let sessionChallenge = null;
let pendingAuthChallenge = null;
let pairing = null;
let pendingPairingCode = null;
let lastPairingClipboardTrigger = null;
let commandRunning = false;
let sessionGeneration = 0;
let initializationReady = false;
let disposed = false;
const commandQueue = [];
const usedNonces = new Map();

const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const statusDotEl = document.getElementById("statusDot");
const pairingCodeEl = document.getElementById("pairingCode");
const pairButton = document.getElementById("pairButton");
const pastePairButton = document.getElementById("pastePairButton");
const reconnectButton = document.getElementById("reconnectButton");
const resetButton = document.getElementById("resetButton");

function asciiDecode(input) {
  let output = "";
  for (let i = 0; i < input.length; i += 1) output += String.fromCharCode(input[i]);
  return output;
}

function audit(eventName) {
  // Journal minimal volontaire : aucun argument, chemin, texte ou resultat metier.
  console.log("[InDesign MCP] " + eventName);
}

function normalizePairingCode(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/[\s-]/g, "");
  return /^[A-F0-9]{16}$/.test(normalized) ? normalized : null;
}

function normalizedPairingCode() {
  const value = pairingCodeEl && typeof pairingCodeEl.value === "string" ? pairingCodeEl.value : "";
  return normalizePairingCode(value);
}

function updateControls() {
  pairButton.disabled = !initializationReady || authenticated || !normalizedPairingCode();
  pastePairButton.disabled = !initializationReady || authenticated;
  resetButton.disabled = !sharedSecret;
}

function setStatus(state, title, detail) {
  statusEl.textContent = title;
  detailEl.textContent = detail;
  statusDotEl.className = "dot" + (state ? " " + state : "");
  updateControls();
}

function connectionErrorDetail(error, fallback) {
  const message = error && typeof error.message === "string" ? error.message.trim() : "";
  if (!message) return fallback;
  return (fallback + " " + message).slice(0, 240);
}

function randomNonce() {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new CommandError("CRYPTO_UNAVAILABLE", "Web Crypto est indisponible dans cette version UXP");
  }
  const bytes = new Uint8Array(24);
  cryptoApi.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sign(message) {
  if (!hmacKey) throw new CommandError("PAIRING_REQUIRED", "Extension non appairee");
  return signHmacHex(hmacKey, message);
}

async function verify(message, proof) {
  if (!hmacKey) return false;
  return verifyHmacHex(hmacKey, message, proof);
}

async function loadSecret() {
  try {
    const stored = await storage.secureStorage.getItem(SECRET_KEY);
    if (stored && stored.length >= 32) {
      sharedSecret = asciiDecode(stored);
      hmacKey = await importHmacKey(sharedSecret, cryptoApi);
      return true;
    }
  } catch (_) {
    sharedSecret = null;
    hmacKey = null;
    throw new CommandError("SECURE_STORAGE_UNAVAILABLE", "Le stockage securise UXP n'est pas disponible");
  }
  return false;
}

async function storeSecret(secret) {
  if (typeof secret !== "string" || secret.length < 43 || secret.length > 512 || !/^[A-Za-z0-9+/_=-]+$/.test(secret)) {
    throw new CommandError("PAIR_SECRET_INVALID", "Secret d'appairage invalide");
  }
  const key = await importHmacKey(secret, cryptoApi);
  await storage.secureStorage.setItem(SECRET_KEY, utf8Encode(secret));
  sharedSecret = secret;
  hmacKey = key;
}

async function clearSecret() {
  try { await storage.secureStorage.removeItem(SECRET_KEY); } catch (_) {}
  sharedSecret = null;
  hmacKey = null;
  authenticated = false;
  sessionChallenge = null;
  pendingAuthChallenge = null;
  pairing = null;
  pendingPairingCode = null;
  if (pairingCodeEl) pairingCodeEl.value = "";
  updateControls();
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new CommandError("BRIDGE_DISCONNECTED", "Bridge deconnecte");
  socket.send(JSON.stringify(payload));
}

function safeSend(payload) {
  try { send(payload); } catch (_) {}
}

function pruneNonces() {
  const threshold = Date.now() - NONCE_TTL_MS;
  for (const [nonce, timestamp] of usedNonces.entries()) if (timestamp < threshold) usedNonces.delete(nonce);
}

async function authenticateChallenge(message) {
  if (pendingPairingCode) {
    sendPairRequest();
    return;
  }
  if (!sharedSecret || !hmacKey) {
    setStatus("waiting", "Appairage requis", "Saisissez le code temporaire donné par Codex.");
    safeSend({ type: "pairing_required", pluginId: PLUGIN_ID, version: PLUGIN_VERSION });
    return;
  }
  const nonce = typeof message.nonce === "string" ? message.nonce : "";
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(nonce)) throw new CommandError("AUTH_CHALLENGE_INVALID", "Challenge d'authentification invalide");
  const pluginNonce = randomNonce();
  pendingAuthChallenge = { bridgeNonce: nonce, pluginNonce };
  const proof = await sign("plugin:" + nonce + ":" + pluginNonce + ":" + PLUGIN_ID + ":" + PLUGIN_VERSION);
  send({ type: "auth_proof", pluginId: PLUGIN_ID, version: PLUGIN_VERSION, nonce, pluginNonce, proof });
  setStatus("waiting", "Authentification", "Verification mutuelle avec le bridge local.");
}

async function completeAuthentication(message) {
  if (!pendingAuthChallenge) throw new CommandError("AUTH_STATE_INVALID", "Aucun challenge en attente");
  if (message.nonce !== pendingAuthChallenge.bridgeNonce || message.pluginNonce !== pendingAuthChallenge.pluginNonce) {
    throw new CommandError("AUTH_NONCE_MISMATCH", "Le challenge ne correspond pas");
  }
  const valid = await verify(
    "bridge:" + pendingAuthChallenge.bridgeNonce + ":" + pendingAuthChallenge.pluginNonce + ":" + PLUGIN_ID + ":" + PLUGIN_VERSION,
    message.proof
  );
  if (!valid) throw new CommandError("AUTH_FAILED", "Preuve du bridge invalide");
  authenticated = true;
  sessionGeneration += 1;
  sessionChallenge = pendingAuthChallenge.bridgeNonce + ":" + pendingAuthChallenge.pluginNonce;
  pendingAuthChallenge = null;
  usedNonces.clear();
  reconnectAttempt = 0;
  setStatus("connected", "Connecte et authentifie", "InDesign est pret a recevoir des commandes securisees.");
  audit("session_authenticated");
  send({ type: "ready", pluginId: PLUGIN_ID, version: PLUGIN_VERSION, commands: Object.keys(commandRegistry).sort() });
}

async function acceptPairSecret(message) {
  if (!pairing || Date.now() > pairing.expiresAt) throw new CommandError("PAIRING_NOT_REQUESTED", "Appairage non demande depuis le panneau");
  if (message.pairingNonce !== pairing.nonce) throw new CommandError("PAIR_NONCE_MISMATCH", "Reponse d'appairage invalide");
  await storeSecret(message.secret);
  pairing = null;
  pendingPairingCode = null;
  if (pairingCodeEl) pairingCodeEl.value = "";
  safeSend({ type: "pair_stored", pluginId: PLUGIN_ID, version: PLUGIN_VERSION });
  setStatus("waiting", "Appairage enregistre", "Reconnexion securisee en cours.");
  audit("pairing_completed");
  setTimeout(forceReconnect, 150);
}

async function verifyCommandMessage(message) {
  if (!authenticated || !sessionChallenge) throw new CommandError("UNAUTHENTICATED", "Session non authentifiee");
  if (typeof message.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(message.id)) throw new CommandError("INVALID_MESSAGE", "Identifiant de commande invalide");
  if (typeof message.command !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(message.command)) throw new CommandError("INVALID_MESSAGE", "Nom de commande invalide");
  if (typeof message.nonce !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(message.nonce)) throw new CommandError("INVALID_MESSAGE", "Nonce de commande invalide");
  if (message.expectedStateToken !== undefined && (typeof message.expectedStateToken !== "string" || !/^[a-f0-9]{16}$/.test(message.expectedStateToken))) {
    throw new CommandError("INVALID_MESSAGE", "Jeton d’état de commande invalide");
  }
  assertSafeJson(message.args || {});
  pruneNonces();
  if (usedNonces.has(message.nonce)) throw new CommandError("REPLAY_DETECTED", "Commande deja recue");
  const valid = await verify(canonicalCommand(message, sessionChallenge), message.proof);
  if (!valid) throw new CommandError("COMMAND_SIGNATURE_INVALID", "Signature de commande invalide");
  usedNonces.set(message.nonce, Date.now());
}

async function drainCommandQueue() {
  if (commandRunning || commandQueue.length === 0) return;
  commandRunning = true;
  const message = commandQueue.shift();
  const generation = message.__sessionGeneration;
  try {
    const result = await executeCommand(commandRegistry, app, message.command, message.args || {}, {
      documentId: message.documentId,
      expectedRevision: message.expectedRevision,
      expectedStateToken: message.expectedStateToken
    });
    if (authenticated && generation === sessionGeneration) {
      safeSend({ type: "result", id: message.id, command: message.command, result });
    }
    audit("command_completed:" + message.command);
  } catch (error) {
    const code = error && error.code ? error.code : "INDESIGN_ERROR";
    const requiresInspection = Boolean(error && (error.requiresInspection === true || error.details && error.details.requiresInspection === true));
    const documentStates = Array.isArray(error && error.documentStates)
      ? error.documentStates
      : Array.isArray(error && error.details && error.details.documentStates) ? error.details.documentStates : undefined;
    const response = {
      type: "error",
      id: message.id,
      command: message.command,
      error: {
        code,
        message: error && error.message ? String(error.message).slice(0, 1000) : "Erreur InDesign",
        details: error && error.details ? error.details : undefined,
        requiresInspection,
        documentStates
      }
    };
    if (authenticated && generation === sessionGeneration) safeSend(response);
    audit("command_failed:" + message.command + ":" + code);
  } finally {
    commandRunning = false;
    if (commandQueue.length) setTimeout(drainCommandQueue, 0);
  }
}

async function enqueueCommand(message) {
  await verifyCommandMessage(message);
  if (commandQueue.length >= 100) throw new CommandError("QUEUE_FULL", "File de commandes saturee");
  Object.defineProperty(message, "__sessionGeneration", { value: sessionGeneration, enumerable: false });
  commandQueue.push(message);
  drainCommandQueue();
}

async function handleMessage(raw) {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) throw new CommandError("MESSAGE_TOO_LARGE", "Message invalide ou trop volumineux");
  let message;
  try { message = JSON.parse(raw); } catch (_) { throw new CommandError("INVALID_JSON", "Message JSON invalide"); }
  assertSafeJson(message);
  if (!message || typeof message.type !== "string") throw new CommandError("INVALID_MESSAGE", "Type de message manquant");

  if (message.type === "pairing_clipboard_ready") return acceptPairingClipboardSignal(message);
  if (message.type === "pair_secret") return acceptPairSecret(message);
  if (message.type === "auth_challenge") return authenticateChallenge(message);
  if (message.type === "auth_ok") return completeAuthentication(message);
  if (message.type === "command") return enqueueCommand(message);
  if (message.type === "ping") return safeSend({ type: "pong", id: message.id || null, authenticated });
  throw new CommandError("UNKNOWN_MESSAGE_TYPE", "Type de message inconnu");
}

function scheduleReconnect() {
  if (disposed || reconnectTimer !== null) return;
  const base = Math.min(30000, 1000 * Math.pow(1.7, reconnectAttempt));
  const delay = Math.round(base * (0.85 + Math.random() * 0.3));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToBridge();
  }, delay);
}

function clearConnectionTimer() {
  if (connectionTimer === null) return;
  clearTimeout(connectionTimer);
  connectionTimer = null;
}

function handleSocketDisconnect(currentSocket, statusState, statusTitle, statusDetail, auditEvent) {
  if (socket !== currentSocket) return;
  clearConnectionTimer();
  socket = null;
  authenticated = false;
  sessionGeneration += 1;
  sessionChallenge = null;
  pendingAuthChallenge = null;
  commandQueue.splice(0, commandQueue.length);
  setStatus(statusState, statusTitle, statusDetail);
  audit(auditEvent);
  scheduleReconnect();
}

function connectToBridge() {
  if (disposed) return;
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  authenticated = false;
  sessionGeneration += 1;
  sessionChallenge = null;
  pendingAuthChallenge = null;
  setStatus("waiting", "Connexion locale", "Recherche du bridge sur ce poste.");
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (error) {
    socket = null;
    setStatus(
      "error",
      "Bridge indisponible",
      connectionErrorDetail(error, "Nouvelle tentative automatique.")
    );
    scheduleReconnect();
    return;
  }

  const currentSocket = socket;
  connectionTimer = setTimeout(() => {
    if (socket !== currentSocket || currentSocket.readyState === WebSocket.OPEN) return;
    try { currentSocket.close(1000, "connection timeout"); } catch (_) {}
    handleSocketDisconnect(
      currentSocket,
      "error",
      "Bridge indisponible",
      "Nouvelle tentative automatique.",
      "socket_connection_timeout"
    );
  }, CONNECTION_TIMEOUT_MS);
  currentSocket.onopen = () => {
    if (socket !== currentSocket) return;
    clearConnectionTimer();
    audit("socket_connected");
    setStatus("waiting", sharedSecret ? "Bridge detecte" : "Appairage requis", sharedSecret ? "En attente du challenge d'authentification." : "Saisissez le code temporaire donné par Codex.");
  };

  currentSocket.onmessage = (event) => {
    if (socket !== currentSocket) return;
    Promise.resolve(handleMessage(event.data)).catch((error) => {
      const code = error && error.code ? error.code : "PROTOCOL_ERROR";
      safeSend({ type: "protocol_error", error: { code, message: error && error.message ? String(error.message).slice(0, 500) : "Erreur de protocole" } });
      audit("protocol_error:" + code);
    });
  };

  currentSocket.onerror = () => {
    if (socket !== currentSocket) return;
    // Certaines versions UXP n'emettent pas toujours `close` apres l'echec
    // d'une connexion locale. Finaliser ici la deconnexion garantit que la
    // boucle automatique repart meme si le bridge etait encore en demarrage.
    try { currentSocket.close(1000, "connection error"); } catch (_) {}
    handleSocketDisconnect(
      currentSocket,
      "error",
      "Erreur de connexion",
      "Le bridge local ne repond pas. Nouvelle tentative automatique.",
      "socket_error"
    );
  };

  currentSocket.onclose = () => {
    handleSocketDisconnect(
      currentSocket,
      "waiting",
      "Deconnecte",
      "Nouvelle tentative automatique.",
      "socket_disconnected"
    );
  };
}

function forceReconnect() {
  if (disposed) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearConnectionTimer();
  const current = socket;
  socket = null;
  authenticated = false;
  sessionGeneration += 1;
  sessionChallenge = null;
  pendingAuthChallenge = null;
  if (current) {
    try { current.close(1000, "reconnect"); } catch (_) {}
  }
  setTimeout(connectToBridge, 100);
}

function sendPairRequest() {
  if (!pendingPairingCode) throw new CommandError("PAIRING_CODE_REQUIRED", "Code d'appairage temporaire requis");
  const pairingCode = pendingPairingCode;
  const nonce = randomNonce();
  pairing = { nonce, expiresAt: Date.now() + PAIR_WINDOW_MS };
  send({ type: "pair_request", pluginId: PLUGIN_ID, version: PLUGIN_VERSION, pairingNonce: nonce, pairingCode });
  pendingPairingCode = null;
  if (pairingCodeEl) pairingCodeEl.value = "";
  setStatus("waiting", "Appairage en cours", "Le code temporaire est vérifié localement.");
  audit("pairing_requested");
}

async function startPairing(pairingCodeOverride) {
  const pairingCode = pairingCodeOverride === undefined
    ? normalizedPairingCode()
    : normalizePairingCode(pairingCodeOverride);
  if (!pairingCode) throw new CommandError("PAIRING_CODE_INVALID", "Code d'appairage temporaire invalide");
  pendingPairingCode = pairingCode;
  if (socket && socket.readyState === WebSocket.OPEN && !pendingAuthChallenge) {
    sendPairRequest();
    return;
  }
  setStatus("waiting", "Connexion locale", "Le code sera envoyé à la prochaine connexion au bridge.");
  forceReconnect();
}

async function readPairingCodeFromClipboard() {
  const clipboard = typeof navigator === "object" && navigator ? navigator.clipboard : null;
  if (!clipboard) throw new CommandError("CLIPBOARD_UNAVAILABLE", "Le presse-papiers UXP n'est pas disponible");

  let text = null;
  let getContentError = null;
  if (typeof clipboard.getContent === "function") {
    try {
      const content = await clipboard.getContent();
      if (typeof content === "string") text = content;
      else if (content && typeof content["text/plain"] === "string") text = content["text/plain"];
    } catch (error) {
      getContentError = error;
    }
  }
  if (text === null && typeof clipboard.readText === "function") {
    try {
      text = await clipboard.readText();
    } catch (error) {
      throw new CommandError("CLIPBOARD_READ_FAILED", "Lecture du presse-papiers impossible");
    }
  }
  if (text === null && getContentError) {
    throw new CommandError("CLIPBOARD_READ_FAILED", "Lecture du presse-papiers impossible");
  }

  const normalized = normalizePairingCode(text);
  if (!normalized) throw new CommandError("PAIRING_CODE_INVALID", "Le presse-papiers ne contient pas un code d'appairage valide");
  return normalized;
}

async function pasteAndStartPairing() {
  const pairingCode = await readPairingCodeFromClipboard();
  await startPairing(pairingCode);
}

async function acceptPairingClipboardSignal(message) {
  if (!initializationReady) throw new CommandError("PAIRING_NOT_READY", "Initialisation UXP incomplète");
  if (authenticated) throw new CommandError("PAIRING_ALREADY_AUTHENTICATED", "La session est déjà authentifiée");
  const trigger = typeof message.trigger === "string" ? message.trigger : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(trigger)) {
    throw new CommandError("PAIRING_CLIPBOARD_SIGNAL_INVALID", "Signal de presse-papiers invalide");
  }
  if (trigger === lastPairingClipboardTrigger) return;
  const expiresAt = typeof message.pairingExpiresAt === "string" ? Date.parse(message.pairingExpiresAt) : NaN;
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + PAIR_WINDOW_MS + 10000) {
    throw new CommandError("PAIRING_CLIPBOARD_SIGNAL_EXPIRED", "Fenêtre de presse-papiers invalide");
  }
  lastPairingClipboardTrigger = trigger;
  try {
    const pairingCode = await readPairingCodeFromClipboard();
    await startPairing(pairingCode);
    audit("automatic_clipboard_pairing_requested");
  } catch (error) {
    const code = error && error.code ? error.code : "CLIPBOARD_PAIRING_ERROR";
    setStatus("error", "Appairage automatique impossible", "Le presse-papiers ne contient pas le code temporaire attendu.");
    audit("automatic_clipboard_pairing_failed:" + code);
  }
}

pairButton.addEventListener("click", () => {
  startPairing().catch((error) => {
    const code = error && error.code ? error.code : "PAIRING_ERROR";
    setStatus("error", "Echec de l'appairage", "La demande n'a pas abouti.");
    audit("pairing_failed:" + code);
  });
});

pairingCodeEl.addEventListener("input", updateControls);

pastePairButton.addEventListener("click", () => {
  pasteAndStartPairing().catch((error) => {
    const code = error && error.code ? error.code : "CLIPBOARD_PAIRING_ERROR";
    setStatus("error", "Appairage impossible", "Copiez le code temporaire donné par Codex puis réessayez.");
    audit("clipboard_pairing_failed:" + code);
  });
});

reconnectButton.addEventListener("click", forceReconnect);

resetButton.addEventListener("click", () => {
  clearSecret().then(() => {
    audit("pairing_cleared");
    forceReconnect();
  });
});

// Le module est charge par InDesign avant l'ouverture du panneau sur les versions
// recentes. Le panneau et le chargement automatique partagent la même promesse :
// aucune socket ne peut recevoir un challenge avant la lecture de secureStorage.
const initializationPromise = loadSecret().then(() => {
  initializationReady = true;
  setStatus("waiting", sharedSecret ? "Extension appairee" : "Appairage requis", "Connexion locale en cours.");
  return true;
}).catch(() => {
  initializationReady = false;
  setStatus("error", "Initialisation impossible", "Le stockage securise UXP n'est pas disponible.");
  return false;
});

entrypoints.setup({
  panels: {
    indesignMcpPanel: {
      show() {
        disposed = false;
        void initializationPromise.then((ready) => { if (ready) connectToBridge(); });
      },
      hide() {},
      destroy() {
        disposed = true;
        if (reconnectTimer !== null) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        clearConnectionTimer();
        const currentSocket = socket;
        socket = null;
        authenticated = false;
        sessionGeneration += 1;
        sessionChallenge = null;
        pendingAuthChallenge = null;
        commandQueue.splice(0, commandQueue.length);
        if (currentSocket) {
          try { currentSocket.close(1000, "plugin disposed"); } catch (_) {}
        }
      }
    }
  }
});

void initializationPromise.then((ready) => { if (ready) connectToBridge(); });
