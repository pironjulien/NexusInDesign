"use strict";

/**
 * Validation centralisee des messages et arguments exposes au bridge.
 * La generation de code reste reservee a execute_uxp, apres authentification,
 * signature, controle anti-rejeu et sauvegarde de securite.
 */

class CommandError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.details = details || undefined;
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assert(condition, code, message, details) {
  if (!condition) throw new CommandError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSafeJson(value, depth, state) {
  const currentDepth = depth || 0;
  const currentState = state || { nodes: 0 };
  currentState.nodes += 1;
  assert(currentDepth <= 12, "INVALID_ARGS", "Structure d'arguments trop profonde");
  assert(currentState.nodes <= 10000, "INVALID_ARGS", "Structure d'arguments trop volumineuse");

  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number") {
      assert(Number.isFinite(value), "INVALID_ARGS", "Nombre non fini interdit");
    }
    if (typeof value === "string") {
      assert(value.length <= 2000000, "INVALID_ARGS", "Chaine trop volumineuse");
      assert(value.indexOf("\u0000") === -1, "INVALID_ARGS", "Caractere nul interdit");
    }
    return;
  }

  if (Array.isArray(value)) {
    assert(value.length <= 10000, "INVALID_ARGS", "Tableau trop volumineux");
    for (let i = 0; i < value.length; i += 1) {
      assertSafeJson(value[i], currentDepth + 1, currentState);
    }
    return;
  }

  assert(isPlainObject(value), "INVALID_ARGS", "Objet JSON simple attendu");
  const keys = Object.keys(value);
  assert(keys.length <= 1000, "INVALID_ARGS", "Objet trop volumineux");
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    assert(!FORBIDDEN_KEYS.has(key), "INVALID_ARGS", "Cle interdite");
    assertSafeJson(value[key], currentDepth + 1, currentState);
  }
}

function object(value, name) {
  const label = name || "arguments";
  assert(isPlainObject(value), "INVALID_ARGS", label + " doit etre un objet");
  assertSafeJson(value);
  return value;
}

function string(value, name, options) {
  const opts = options || {};
  assert(typeof value === "string", "INVALID_ARGS", name + " doit etre une chaine");
  const trimmed = opts.trim === false ? value : value.trim();
  const min = opts.min === undefined ? 1 : opts.min;
  const max = opts.max === undefined ? 500 : opts.max;
  assert(trimmed.length >= min && trimmed.length <= max, "INVALID_ARGS", name + " a une longueur invalide");
  assert(trimmed.indexOf("\u0000") === -1, "INVALID_ARGS", name + " contient un caractere interdit");
  if (opts.pattern) assert(opts.pattern.test(trimmed), "INVALID_ARGS", name + " a un format invalide");
  return trimmed;
}

function optionalString(value, name, options) {
  if (value === undefined || value === null) return undefined;
  return string(value, name, options);
}

function number(value, name, options) {
  const opts = options || {};
  assert(typeof value === "number" && Number.isFinite(value), "INVALID_ARGS", name + " doit etre un nombre fini");
  if (opts.integer) assert(Number.isInteger(value), "INVALID_ARGS", name + " doit etre un entier");
  if (opts.min !== undefined) assert(value >= opts.min, "INVALID_ARGS", name + " est trop petit");
  if (opts.max !== undefined) assert(value <= opts.max, "INVALID_ARGS", name + " est trop grand");
  return value;
}

function optionalNumber(value, name, options) {
  if (value === undefined || value === null) return undefined;
  return number(value, name, options);
}

function boolean(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  assert(typeof value === "boolean", "INVALID_ARGS", name + " doit etre un booleen");
  return value;
}

function oneOf(value, name, allowed, fallback) {
  const actual = value === undefined && fallback !== undefined ? fallback : value;
  assert(typeof actual === "string" && allowed.includes(actual), "INVALID_ARGS", name + " est invalide", { allowed });
  return actual;
}

function id(value, name) {
  return number(value, name, { integer: true, min: 1, max: Number.MAX_SAFE_INTEGER });
}

function optionalId(value, name) {
  if (value === undefined || value === null) return undefined;
  return id(value, name);
}

function bounds(value, name) {
  const label = name || "bounds";
  assert(Array.isArray(value) && value.length === 4, "INVALID_ARGS", label + " doit contenir [haut, gauche, bas, droite]");
  const result = value.map((entry, index) => number(entry, label + "[" + index + "]", { min: -100000, max: 100000 }));
  assert(result[2] > result[0] && result[3] > result[1], "INVALID_ARGS", label + " doit definir une surface positive");
  return result;
}

function absolutePath(value, name, extensions) {
  const result = string(value, name, { min: 3, max: 1024, trim: true });
  assert(!/^\\\\/.test(result), "PATH_NOT_ALLOWED", "Les chemins reseau UNC sont interdits");
  assert(!/^[a-z]+:\/\//i.test(result), "PATH_NOT_ALLOWED", "Les URL sont interdites");
  assert(/^[A-Za-z]:[\\/]/.test(result), "PATH_NOT_ALLOWED", name + " doit etre un chemin Windows absolu");
  const segments = result.replace(/\\/g, "/").split("/");
  assert(!segments.includes(".."), "PATH_NOT_ALLOWED", "Les segments de remontee sont interdits");
  assert(!/[<>|?*]/.test(result.slice(3)), "PATH_NOT_ALLOWED", "Le chemin contient des caracteres interdits");
  if (extensions && extensions.length) {
    const lower = result.toLowerCase();
    assert(extensions.some((ext) => lower.endsWith(ext)), "INVALID_ARGS", "Extension de fichier interdite", { extensions });
  }
  return result;
}

function pageIds(value, name) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 1000, "INVALID_ARGS", name + " doit etre un tableau non vide");
  return value.map((entry, index) => id(entry, name + "[" + index + "]"));
}

module.exports = {
  CommandError,
  assert,
  assertSafeJson,
  object,
  string,
  optionalString,
  number,
  optionalNumber,
  boolean,
  oneOf,
  id,
  optionalId,
  bounds,
  absolutePath,
  pageIds
};
