import fs from "fs/promises";
import path from "path";
import AdmZip from "adm-zip";
import { v4 as uuidv4 } from "uuid";
import type { ClientInfo } from "../types";
import { logger } from "../logger";
import { encodeMessage, type PluginManifest } from "../protocol";

export type PluginState = {
  enabled: Record<string, boolean>;
  lastError: Record<string, string>;
};

export async function loadPluginStateFromDisk(pluginStatePath: string): Promise<PluginState> {
  try {
    const raw = await fs.readFile(pluginStatePath, "utf-8");
    const parsed = JSON.parse(raw) as { enabled?: Record<string, boolean>; lastError?: Record<string, string> };
    return {
      enabled: parsed.enabled || {},
      lastError: parsed.lastError || {},
    };
  } catch {
    return { enabled: {}, lastError: {} };
  }
}

export async function savePluginStateToDisk(
  pluginRoot: string,
  pluginStatePath: string,
  pluginState: PluginState,
): Promise<void> {
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(pluginStatePath, JSON.stringify(pluginState, null, 2));
}

export async function ensurePluginExtracted(
  pluginRoot: string,
  pluginId: string,
  sanitizePluginId: (name: string) => string,
): Promise<void> {
  const safeId = sanitizePluginId(pluginId);
  const zipPath = path.join(pluginRoot, `${safeId}.zip`);
  const pluginDir = path.join(pluginRoot, safeId);
  const manifestPath = path.join(pluginDir, "manifest.json");

  let zipStat: any = null;
  try {
    zipStat = await fs.stat(zipPath);
  } catch {
    zipStat = null;
  }

  let manifestStat: any = null;
  try {
    manifestStat = await fs.stat(manifestPath);
  } catch {
    manifestStat = null;
  }

  if (!zipStat) {
    if (manifestStat) return;
    throw new Error(`Plugin bundle not found: ${safeId}`);
  }

  if (manifestStat && manifestStat.mtimeMs >= zipStat.mtimeMs) {
    return;
  }

  await fs.mkdir(pluginDir, { recursive: true });
  const assetsDir = path.join(pluginDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  let htmlEntry: Buffer | null = null;
  let cssEntry: Buffer | null = null;
  let jsEntry: Buffer | null = null;
  const nativeBinaries: Map<string, Buffer> = new Map();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.entryName);
    const lower = base.toLowerCase();
    if (lower.endsWith(".so") || lower.endsWith(".dll") || lower.endsWith(".dylib")) {
      nativeBinaries.set(base, entry.getData());
    } else if (lower.endsWith(".html")) {
      htmlEntry = entry.getData();
    } else if (lower.endsWith(".css")) {
      cssEntry = entry.getData();
    } else if (lower.endsWith(".js")) {
      jsEntry = entry.getData();
    }
  }

  const hasNative = nativeBinaries.size > 0;
  if (!hasNative) {
    throw new Error(`Invalid plugin bundle: ${safeId} (no native binaries found)`);
  }
  if (!htmlEntry || !cssEntry || !jsEntry) {
    throw new Error(`Invalid plugin bundle: ${safeId} (missing .html, .css, or .js)`);
  }

  const binariesMap: Record<string, string> = {};
  for (const [filename, data] of nativeBinaries) {
    await fs.writeFile(path.join(pluginDir, filename), data);
    const platformKey = derivePlatformKey(filename);
    if (platformKey) {
      binariesMap[platformKey] = filename;
    }
  }

  await fs.writeFile(path.join(assetsDir, `${safeId}.html`), htmlEntry);
  await fs.writeFile(path.join(assetsDir, `${safeId}.css`), cssEntry);
  await fs.writeFile(path.join(assetsDir, `${safeId}.js`), jsEntry);

  const manifest: PluginManifest = {
    id: safeId,
    name: safeId,
    version: "1.0.0",
    binaries: binariesMap,
    entry: `${safeId}.html`,
    assets: {
      html: `${safeId}.html`,
      css: `${safeId}.css`,
      js: `${safeId}.js`,
    },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

export async function syncPluginBundles(
  pluginRoot: string,
  ensureExtracted: (pluginId: string) => Promise<void>,
): Promise<void> {
  await fs.mkdir(pluginRoot, { recursive: true });
  const entries = await fs.readdir(pluginRoot, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".zip")) {
      const pluginId = ent.name.slice(0, -4);
      try {
        await ensureExtracted(pluginId);
      } catch (err) {
        logger.warn(`[plugin] failed to extract ${pluginId}: ${(err as Error).message}`);
      }
    }
  }
}

export async function listPluginManifests(
  pluginRoot: string,
  pluginState: PluginState,
  saveState: () => Promise<void>,
  ensureExtracted: (pluginId: string) => Promise<void>,
): Promise<PluginManifest[]> {
  try {
    await syncPluginBundles(pluginRoot, ensureExtracted);
    const entries = await fs.readdir(pluginRoot, { withFileTypes: true });
    const manifests: PluginManifest[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const manifestPath = path.join(pluginRoot, ent.name, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as PluginManifest;
        const id = manifest.id || ent.name;
        const name = manifest.name || ent.name;
        if (pluginState.enabled[id] === undefined) {
          pluginState.enabled[id] = true;
        }
        manifests.push({ ...manifest, id, name });
      } catch {}
    }
    await saveState();
    return manifests;
  } catch {
    return [];
  }
}

export async function loadPluginBundle(
  pluginRoot: string,
  pluginId: string,
  ensureExtracted: (pluginId: string) => Promise<void>,
  clientOS?: string,
  clientArch?: string,
): Promise<{ manifest: PluginManifest; binary: Uint8Array }> {
  await ensureExtracted(pluginId);
  const dir = path.join(pluginRoot, pluginId);
  const manifestPath = path.join(dir, "manifest.json");
  const rawManifest = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(rawManifest) as PluginManifest;
  manifest.id = manifest.id || pluginId;
  manifest.name = manifest.name || pluginId;

  let binaryPath: string | null = null;

  if (manifest.binaries && clientOS && clientArch) {
    const key = `${clientOS}-${clientArch}`;
    const filename = manifest.binaries[key];
    if (filename) {
      const candidate = path.join(dir, filename);
      try {
        await fs.access(candidate);
        binaryPath = candidate;
      } catch {}
    }
  }

  if (!binaryPath) {
    const files = await fs.readdir(dir);
    const found = files.find(
      (f) =>
        f.toLowerCase().endsWith(".so") ||
        f.toLowerCase().endsWith(".dll") ||
        f.toLowerCase().endsWith(".dylib"),
    );
    if (!found) throw new Error(`No plugin binary found for ${pluginId} (${clientOS}-${clientArch})`);
    binaryPath = path.join(dir, found);
  }

  const binary = new Uint8Array(await fs.readFile(binaryPath));
  return { manifest, binary };
}

export function sendPluginBundle(
  target: ClientInfo,
  bundle: { manifest: PluginManifest; binary: Uint8Array },
): void {
  const chunkSize = 16 * 1024;
  const data = bundle.binary;
  const totalChunks = Math.ceil(data.length / chunkSize);
  const initPayload = {
    manifest: bundle.manifest,
    size: data.length,
    chunks: totalChunks,
  };
  target.ws.send(
    encodeMessage({
      type: "command",
      commandType: "plugin_load_init",
      id: uuidv4(),
      payload: initPayload,
    }),
  );

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, data.length);
    const chunk = data.slice(start, end);
    target.ws.send(
      encodeMessage({
        type: "command",
        commandType: "plugin_load_chunk",
        id: uuidv4(),
        payload: { pluginId: bundle.manifest.id, index: i, data: chunk },
      }),
    );
  }

  target.ws.send(
    encodeMessage({
      type: "command",
      commandType: "plugin_load_finish",
      id: uuidv4(),
      payload: { pluginId: bundle.manifest.id },
    }),
  );
}

function derivePlatformKey(filename: string): string {
  const match = filename.match(/-(linux|darwin|windows|freebsd)-(amd64|arm64|arm|386)\.(so|dll|dylib)$/i);
  if (match) {
    return `${match[1].toLowerCase()}-${match[2].toLowerCase()}`;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".dll")) return "windows-amd64";
  if (lower.endsWith(".dylib")) return "darwin-amd64";
  if (lower.endsWith(".so")) return "linux-amd64";
  return "";
}
