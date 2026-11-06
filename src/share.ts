// Move the whole tracker state between devices: a JSON file or a QR code.
// The QR carries the same snapshot, deflate-compressed and base64url-encoded
// ("c1:" prefix). Everything is client side; no upload anywhere.
export type Dose = { id: string; name: string; volume: number; mg: number; at: number };
export type SnapDose = { name: string; volume: number; mg: number; at: number };
export type Snapshot = {
  app: "caffeine-tracker";
  v: 1;
  halfLife: number;
  horizon: number;
  doses: SnapDose[];
};

const APP = "caffeine-tracker";
// QR version 40 / level L holds 2953 bytes; stay well inside that.
const MAX_QR_CHARS = 2400;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str: string): Uint8Array {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// both directions share the "deflate-raw" format name; only the stream class flips
async function pipe(bytes: Uint8Array, compress: boolean) {
  const Ctor = compress
    ? (globalThis as any).CompressionStream
    : (globalThis as any).DecompressionStream;
  if (!Ctor) return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
      new Ctor("deflate-raw")
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export function snapshot(doses: Dose[], halfLife: number, horizon: number): Snapshot {
  return {
    app: APP,
    v: 1,
    halfLife,
    horizon,
    doses: doses.map((d) => ({
      name: d.name,
      volume: d.volume,
      mg: d.mg,
      // second precision keeps the QR small; nothing here needs milliseconds
      at: Math.round(d.at / 1000) * 1000,
    })),
  };
}

export function snapshotJson(snap: Snapshot): string {
  return JSON.stringify(snap, null, 2) + "\n";
}

function sanitize(input: unknown): Snapshot | null {
  if (!input || typeof input !== "object") return null;
  const o = input as any;
  if (o.app !== APP || Number(o.v) !== 1 || !Array.isArray(o.doses)) return null;
  const doses: SnapDose[] = [];
  for (const d of o.doses) {
    const name = String(d?.name ?? "").trim().slice(0, 40);
    const volume = Number(d?.volume);
    const mg = Number(d?.mg);
    const at = Number(d?.at);
    if (!name || !(volume > 0) || !(mg > 0) || !(at > 0)) continue;
    doses.push({ name, volume, mg, at });
  }
  const halfLife = Math.min(8, Math.max(3, Number(o.halfLife) || 5));
  return { app: APP, v: 1, halfLife, horizon: Number(o.horizon) === 24 ? 24 : 12, doses };
}

export function parseJson(text: string): Snapshot | null {
  try {
    return sanitize(JSON.parse(text));
  } catch {
    return null;
  }
}

// QR text: "c1:<base64url deflate>" when the browser can compress, else "j:<base64url json>"
export async function packQr(snap: Snapshot): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(snap));
  const z = await pipe(raw, true);
  return z ? "c1:" + b64url(z) : "j:" + b64url(raw);
}

export async function unpackQr(text: string): Promise<Snapshot | null> {
  const t = text.trim();
  if (t.startsWith("{")) return parseJson(t);
  if (t.startsWith("j:")) {
    try {
      return sanitize(JSON.parse(new TextDecoder().decode(fromB64url(t.slice(2)))));
    } catch {
      return null;
    }
  }
  if (t.startsWith("c1:")) {
    const z = fromB64url(t.slice(3));
    const raw = await pipe(z, false);
    if (!raw) return null;
    try {
      return sanitize(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      return null;
    }
  }
  return null;
}

export async function qrSvg(text: string): Promise<string | null> {
  if (text.length > MAX_QR_CHARS) return null;
  try {
    // only downloaded when someone asks for a qr code
    const { default: qrcode } = await import("qrcode-generator");
    const qr = qrcode(0, "L");
    qr.addData(text, "Byte");
    qr.make();
    // margin is measured in viewBox units (cellSize: 4 -> 16 = the 4-module quiet zone)
    return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  } catch {
    return null;
  }
}

// merge never drops a local drink: same drink (name + size + mg + second) counts once
export function mergeDoses(
  current: Dose[],
  incoming: SnapDose[],
  uid: () => string
): { doses: Dose[]; added: number } {
  const seen = new Set(current.map((d) => key(d)));
  const out = [...current];
  let added = 0;
  for (const d of incoming) {
    const k = key(d);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: uid(), name: d.name, volume: d.volume, mg: d.mg, at: d.at });
    added++;
  }
  out.sort((a, b) => a.at - b.at);
  return { doses: out, added };
}

function key(d: { name: string; volume: number; mg: number; at: number }) {
  return `${d.name}|${d.volume}|${d.mg.toFixed(1)}|${Math.round(d.at / 1000)}`;
}

export function downloadJson(snap: Snapshot, when = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  const name = `caffeine-${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}.json`;
  const url = URL.createObjectURL(new Blob([snapshotJson(snap)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return name;
}
