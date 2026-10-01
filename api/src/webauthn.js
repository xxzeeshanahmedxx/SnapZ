/* Minimal WebAuthn verification for Cloudflare Workers.
   No dependencies — just WebCrypto. Supports ES256 (-7) and RS256 (-257),
   which covers every platform authenticator in practice (Touch ID, Face ID,
   Android fingerprint, Windows Hello). */

export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => Uint8Array.from(
  atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/* ---------------- tiny CBOR decoder (enough for WebAuthn) ---------------- */
function cbor(buf, pos = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  function read(p) {
    const b = buf[p++], major = b >> 5, info = b & 31;
    let len = info;
    if (info === 24) { len = buf[p]; p += 1; }
    else if (info === 25) { len = dv.getUint16(p); p += 2; }
    else if (info === 26) { len = dv.getUint32(p); p += 4; }
    else if (info === 27) { len = Number(dv.getBigUint64(p)); p += 8; }

    switch (major) {
      case 0: return [len, p];
      case 1: return [-1 - len, p];
      case 2: return [buf.slice(p, p + len), p + len];
      case 3: return [new TextDecoder().decode(buf.slice(p, p + len)), p + len];
      case 4: { const a = []; for (let i = 0; i < len; i++) { const [v, np] = read(p); a.push(v); p = np; } return [a, p]; }
      case 5: { const m = new Map(); for (let i = 0; i < len; i++) {
                 const [k, p1] = read(p); const [v, p2] = read(p1); m.set(k, v); p = p2; } return [m, p]; }
      case 7:
        if (info === 20) return [false, p];
        if (info === 21) return [true, p];
        if (info === 22) return [null, p];
        return [undefined, p];
      default: throw new Error('cbor: unsupported major ' + major);
    }
  }
  return read(pos);
}

/* ---------------- authenticatorData ---------------- */
export function parseAuthData(ad) {
  const dv = new DataView(ad.buffer, ad.byteOffset, ad.byteLength);
  const rpIdHash = ad.slice(0, 32);
  const flags = ad[32];
  const counter = dv.getUint32(33);
  const out = {
    rpIdHash, flags, counter,
    up: !!(flags & 0x01),          // user present
    uv: !!(flags & 0x04),          // user VERIFIED — biometric/PIN was checked
    at: !!(flags & 0x40)
  };
  if (out.at) {
    let p = 37 + 16;                                   // skip AAGUID
    const idLen = dv.getUint16(p); p += 2;
    out.credId = ad.slice(p, p + idLen); p += idLen;
    const [cose] = cbor(ad.slice(p));
    out.cose = cose;
  }
  return out;
}

/* ---------------- COSE → CryptoKey ---------------- */
export async function importCose(cose) {
  const alg = cose.get(3);
  if (alg === -7) {                                    // ES256 / P-256
    const jwk = { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)), ext: true };
    return { alg, key: await crypto.subtle.importKey('jwk', jwk,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) };
  }
  if (alg === -257) {                                  // RS256
    const jwk = { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)), ext: true };
    return { alg, key: await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']) };
  }
  throw new Error('unsupported algorithm ' + alg);
}

/* DER ECDSA signature → raw r||s that WebCrypto expects */
function derToRaw(sig) {
  let p = 0;
  if (sig[p++] !== 0x30) throw new Error('bad DER');
  if (sig[p] & 0x80) p += 1 + (sig[p] & 0x7f); else p += 1;
  const rd = () => {
    if (sig[p++] !== 0x02) throw new Error('bad DER int');
    const len = sig[p++]; let v = sig.slice(p, p + len); p += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
  };
  const r = rd(), s = rd();
  const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32); return raw;
}

const sha256 = async d => new Uint8Array(await crypto.subtle.digest('SHA-256', d));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ---------------- clientDataJSON checks ---------------- */
export function checkClientData(json, expectedType, expectedChallenge, origins) {
  const c = JSON.parse(new TextDecoder().decode(json));
  if (c.type !== expectedType) throw new Error('wrong type');
  if (c.challenge !== expectedChallenge) throw new Error('challenge mismatch');
  if (!origins.includes(c.origin)) throw new Error('bad origin: ' + c.origin);
  return c;
}

/* ---------------- registration ---------------- */
export async function verifyRegistration({ attestationObject, clientDataJSON, challenge, origins, rpId }) {
  checkClientData(clientDataJSON, 'webauthn.create', challenge, origins);
  const [att] = cbor(attestationObject);
  const ad = parseAuthData(att.get('authData'));
  if (!eq(ad.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) throw new Error('rpId mismatch');
  if (!ad.up) throw new Error('user not present');
  if (!ad.at || !ad.cose) throw new Error('no credential');
  const { alg } = await importCose(ad.cose);
  return {
    id: b64u(ad.credId),
    pubkey: b64u(encodeCose(ad.cose)),
    alg,
    counter: ad.counter,
    uv: ad.uv
  };
}

/* re-encode the COSE map so we can store and re-import it later */
function encodeCose(map) {
  /* only the fields we need, in canonical order */
  const parts = [];
  const int = (n) => {
    if (n >= 0 && n < 24) return [n];
    if (n < 0 && n > -25) return [0x20 | (-1 - n)];
    if (n >= 0) return [0x18, n];
    return [0x38, -1 - n];
  };
  const bstr = (b) => {
    const len = b.length;
    const head = len < 24 ? [0x40 | len] : len < 256 ? [0x58, len] : [0x59, len >> 8, len & 255];
    return [...head, ...b];
  };
  const entries = [...map.entries()];
  parts.push(0xa0 | entries.length);
  for (const [k, v] of entries) {
    parts.push(...int(k));
    if (v instanceof Uint8Array) parts.push(...bstr(v));
    else parts.push(...int(v));
  }
  return new Uint8Array(parts);
}
export function decodeCose(bytes) { return cbor(bytes)[0]; }

/* ---------------- authentication ---------------- */
export async function verifyAssertion({ authenticatorData, clientDataJSON, signature,
                                        challenge, origins, rpId, pubkey, storedCounter }) {
  checkClientData(clientDataJSON, 'webauthn.get', challenge, origins);
  const ad = parseAuthData(authenticatorData);
  if (!eq(ad.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) throw new Error('rpId mismatch');
  if (!ad.up) throw new Error('user not present');
  if (!ad.uv) throw new Error('biometric/PIN not verified');   // we REQUIRE this

  const { alg, key } = await importCose(decodeCose(unb64u(pubkey)));
  const signed = new Uint8Array([...authenticatorData, ...(await sha256(clientDataJSON))]);
  const sig = alg === -7 ? derToRaw(signature) : signature;
  const algo = alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const ok = await crypto.subtle.verify(algo, key, sig, signed);
  if (!ok) throw new Error('bad signature');

  /* clone detection: counters must advance (0 means the authenticator doesn't use them) */
  if (ad.counter !== 0 && storedCounter !== 0 && ad.counter <= storedCounter)
    throw new Error('counter replay');

  return { counter: ad.counter };
}
