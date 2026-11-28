import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import {
  configFilePath,
  loadConfig,
  readiness,
  saveConfig,
  toolchainPaths,
} from './config-store.js';
import type { KbConfig, KbConfigOverrides, ToolchainPaths } from './config-store.js';
import { cancelJob, loadQueue, pruneQueue, queueSummary, recoverQueue, saveQueue } from './job-queue.js';
import { createVault, parseTemplate, planRegistration } from './kb-init.js';
import { appendFeedback, markFeedbackDone, readFeedback } from './vault-feedback.js';
import { ITEMS_PATH, parseItems, selectHot, summarizeMemory } from './vault-memory.js';
import { readVaultSchema, schemaTemplate, writeVaultSchema } from './vault-schema.js';

/**
 * JSON API for the knowledge-base settings page that DSH embeds in its own
 * settings UI. The page is served from the DSH web origin, so it talks to these
 * routes with relative fetch() calls and never needs the MCP tool surface.
 *
 * Every route answers JSON: successes carry ok:true, failures carry
 * {ok:false, error:{code, message}} so the client can branch on the code.
 */
export const SETTINGS_ROUTE_PREFIX = '/api/v1/aikb';

export interface SettingsApiDeps {
  /** Config overrides coming from the plugin config, i.e. the live defaults. */
  readonly overrides: () => KbConfigOverrides;
  /** Whether this installation may write; a read-only API still answers reads. */
  readonly allowWrites: () => boolean;
  /** Resolve a vault address (id or path, may be empty = active vault) to a root dir. */
  readonly vaultFor: (address: string) => string;
  /** Directory holding the durable job queue. */
  readonly jobsDir: () => string;
}

export interface SettingsApiRequest {
  readonly method: string;
  /** Pathname with the settings prefix ALREADY stripped; '' means the prefix itself. */
  readonly pathname: string;
  readonly search: string;
  readonly body: string;
}

export interface SettingsApiResult {
  readonly status: number;
  readonly body: unknown;
}

type JsonObject = Record<string, unknown>;

interface SettingsVaultView {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly booksDir?: string;
  readonly active: boolean;
  readonly exists: boolean;
}

interface ConfigPayload {
  readonly configPath: string;
  readonly revision: string;
  readonly config: KbConfig;
  readonly activeVault: string;
  readonly vaults: readonly SettingsVaultView[];
  readonly readiness: { readonly ok: boolean; readonly missing: readonly string[] };
  readonly missing: readonly string[];
  readonly warnings: readonly string[];
  readonly sources: readonly string[];
  readonly toolchain: ToolchainPaths;
}

type ParsedBody = { readonly ok: true; readonly value: JsonObject } | { readonly ok: false; readonly result: SettingsApiResult };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function failure(status: number, code: string, message: string, extra?: JsonObject): SettingsApiResult {
  const body: JsonObject = { ok: false, error: { code, message } };
  if (extra !== undefined) Object.assign(body, extra);
  return { status, body };
}

function success(payload: JsonObject): SettingsApiResult {
  return { status: 200, body: { ok: true, ...payload } };
}

/** Store errors are 'kb.x.y: detail'; the code is already reported, keep the detail. */
function codeOf(text: string, fallback: string): string {
  const head = text.slice(0, Math.max(0, text.indexOf(': ')));
  return /^kb\.[a-z0-9.-]+$/.test(head) ? head : fallback;
}

function jsonBody(req: SettingsApiRequest): ParsedBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body === '' ? '{}' : req.body);
  } catch {
    return { ok: false, result: failure(400, 'kb.api.bad-json', 'The request body is not valid JSON.') };
  }
  return { ok: true, value: isObject(parsed) ? parsed : {} };
}

function expectedRevision(body: JsonObject): string | undefined {
  const value = body.expectRevision;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function saveOptions(body: JsonObject, deps: SettingsApiDeps): { expectRevision?: string; overrides: KbConfigOverrides } {
  const expectRevision = expectedRevision(body);
  return expectRevision === undefined
    ? { overrides: deps.overrides() }
    : { expectRevision, overrides: deps.overrides() };
}

const PATCH_STRINGS = [
  'activeVault',
  'packDir',
  'toolchainDir',
  'promoteDir',
  'pythonPath',
  'pythonLibPath',
  'pythonMirror',
] as const;

const PATCH_BOOLEANS = ['allowWrites', 'ocrEnabled', 'embedEnabled', 'embedOnIngest', 'rerankEnabled'] as const;

/**
 * Copy only the documented settings fields, exactly like scripts/kb-ui.mjs.
 * The page must not be able to smuggle arbitrary config keys into the file.
 */
function pickPatch(raw: JsonObject): Partial<KbConfig> {
  const patch: Record<string, unknown> = {};
  if (Array.isArray(raw.vaults)) {
    patch.vaults = raw.vaults.filter(isObject).map((entry) => {
      const booksDir = asText(entry.booksDir).trim();
      return {
        id: asText(entry.id).trim(),
        name: asText(entry.name).trim(),
        dir: asText(entry.dir).trim(),
        ...(booksDir === '' ? {} : { booksDir }),
      };
    });
  }
  for (const key of PATCH_STRINGS) {
    const value = raw[key];
    if (typeof value === 'string') patch[key] = value;
  }
  for (const key of PATCH_BOOLEANS) {
    const value = raw[key];
    if (typeof value === 'boolean') patch[key] = value;
  }
  if (typeof raw.ocrWorkers === 'number' && Number.isFinite(raw.ocrWorkers)) patch.ocrWorkers = raw.ocrWorkers;
  // The whitelist above is the only thing crossing this boundary, so the cast is
  // safe: every key written is a documented KbConfig field with its own type.
  return patch as Partial<KbConfig>;
}

function vaultViews(config: KbConfig): SettingsVaultView[] {
  return config.vaults.map((vault) => ({
    id: vault.id,
    name: vault.name,
    dir: vault.dir,
    ...(vault.booksDir === undefined ? {} : { booksDir: vault.booksDir }),
    active: vault.id === config.activeVault,
    // The page greys out missing directories, so probe the disk for every vault.
    exists: existsSync(vault.dir),
  }));
}

function configPayload(deps: SettingsApiDeps): SettingsApiResult {
  const loaded = loadConfig(deps.overrides());
  const missing = readiness(loaded.config);
  const payload: ConfigPayload = {
    configPath: configFilePath(),
    revision: loaded.revision,
    config: loaded.config,
    activeVault: loaded.config.activeVault,
    vaults: vaultViews(loaded.config),
    readiness: { ok: missing.length === 0, missing },
    missing: loaded.missing,
    warnings: loaded.warnings,
    sources: loaded.sources,
    toolchain: toolchainPaths(loaded.config),
  };
  return success({ ...payload });
}

function saveConfigRoute(req: SettingsApiRequest, deps: SettingsApiDeps): SettingsApiResult {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const patch = pickPatch(isObject(body.patch) ? body.patch : {});
  const result = saveConfig(patch, saveOptions(body, deps));
  if (result.ok) return configPayload(deps);
  if (result.error !== undefined && result.error.startsWith('kb.config.stale')) {
    return failure(409, 'kb.config.stale', result.error);
  }
  if (result.problems.length > 0) {
    return failure(400, 'kb.config.invalid', 'the settings did not validate', { problems: result.problems });
  }
  const error = result.error ?? 'kb.config.save-failed: the settings could not be saved';
  return failure(400, codeOf(error, 'kb.config.save-failed'), error);
}

async function schemaReadRoute(url: URL, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const root = deps.vaultFor(url.searchParams.get('address') ?? '');
  const sheet = await readVaultSchema(root);
  return success({
    path: sheet.path,
    exists: sheet.exists,
    bytes: sheet.bytes,
    updatedAt: sheet.updatedAt,
    text: sheet.text,
    // The template is named after the vault, so a fresh sheet reads as that vault.
    template: schemaTemplate(nodePath.basename(root)),
    allowWrites: deps.allowWrites(),
  });
}

async function schemaWriteRoute(req: SettingsApiRequest, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const root = deps.vaultFor(asText(parsed.value.address));
  const result = await writeVaultSchema(root, asText(parsed.value.text), { allowWrites: deps.allowWrites() });
  if (result.ok) return success({ path: result.path, bytes: result.bytes });
  const error = result.error ?? { code: 'kb.schema.write-failed', message: 'The sheet could not be written.' };
  return failure(error.code === 'kb.schema.read-only' ? 403 : 400, error.code, error.message);
}

function vaultInitRoute(req: SettingsApiRequest, deps: SettingsApiDeps): SettingsApiResult {
  // Creating a vault writes a directory tree, so it needs the same gate as edits.
  if (!deps.allowWrites()) {
    return failure(403, 'kb.init.read-only', 'Writes are disabled: enable allowWrites before creating a vault.');
  }
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const dir = asText(body.dir);
  const name = asText(body.name).trim();
  const created = createVault({
    dir,
    ...(name === '' ? {} : { name }),
    template: parseTemplate(typeof body.template === 'string' ? body.template : undefined),
    allowWrites: true,
  });
  if (!created.ok || created.vault === undefined) {
    const error = created.error ?? { code: 'kb.init.write-failed', message: 'The vault could not be created.' };
    return failure(error.code === 'kb.init.not-empty' ? 409 : 400, error.code, error.message);
  }
  const loaded = loadConfig(deps.overrides());
  const plan = planRegistration(loaded, {
    dir: created.vault.dir,
    name: created.vault.name,
    activate: body.activate !== false,
  });
  const saved = saveConfig(plan.patch, { expectRevision: plan.revision, overrides: deps.overrides() });
  if (!saved.ok) {
    const error = saved.error ?? 'kb.init.register-failed: the new vault could not be registered';
    return failure(409, 'kb.init.register-failed', error);
  }
  return success({
    vault: created.vault,
    registered: {
      id: plan.entry.id,
      name: plan.entry.name,
      active: plan.patch.activeVault === plan.entry.id,
      alreadyRegistered: plan.alreadyRegistered,
    },
    revision: saved.revision,
  });
}

function vaultsRoute(deps: SettingsApiDeps): SettingsApiResult {
  const loaded = loadConfig(deps.overrides());
  return success({ activeVault: loaded.config.activeVault, vaults: vaultViews(loaded.config) });
}

/** The settings page shows what the agent remembers; editing stays in the kb_memory tool. */
async function memoryRoute(deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const root = deps.vaultFor('');
  const file = nodePath.join(root, ITEMS_PATH.split('/').join(nodePath.sep));
  let items: ReturnType<typeof parseItems> = [];
  try {
    items = parseItems(await readFile(file, 'utf8'));
  } catch {
    items = [];
  }
  const counts = summarizeMemory(items);
  const hot = selectHot(items, { budgetTokens: 400, now: new Date().toISOString() });
  return success({
    path: ITEMS_PATH,
    total: counts.total,
    byKind: counts.byKind,
    byStatus: counts.byStatus,
    hot: hot.hot.map((item) => ({ id: item.id, kind: item.kind, subject: item.subject, statement: item.statement })),
    tokens: hot.tokens,
    recent: counts.recent.map((item) => ({
      id: item.id,
      kind: item.kind,
      subject: item.subject,
      statement: item.statement,
      status: item.status,
    })),
  });
}

function vaultActiveRoute(req: SettingsApiRequest, deps: SettingsApiDeps): SettingsApiResult {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const wanted = asText(body.id);
  const loaded = loadConfig(deps.overrides());
  if (!loaded.config.vaults.some((vault) => vault.id === wanted)) {
    return failure(400, 'kb.config.unknown-vault', wanted === '' ? 'No vault id was given.' : 'No vault has the id "' + wanted + '".');
  }
  const result = saveConfig({ activeVault: wanted }, saveOptions(body, deps));
  if (result.ok) return success({ revision: result.revision, activeVault: wanted });
  if (result.error !== undefined && result.error.startsWith('kb.config.stale')) {
    return failure(409, 'kb.config.stale', result.error);
  }
  if (result.problems.length > 0) {
    return failure(400, 'kb.config.invalid', 'the settings did not validate', { problems: result.problems });
  }
  const error = result.error ?? 'kb.config.save-failed: the active vault could not be saved';
  return failure(400, codeOf(error, 'kb.config.save-failed'), error);
}

async function jobsRoute(deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const loaded = await loadQueue(deps.jobsDir());
  return success({
    path: loaded.path,
    warnings: loaded.warnings,
    summary: queueSummary(loaded.queue),
    // The page shows recent work only; the queue file keeps the full history.
    jobs: loaded.queue.jobs.slice(-100),
  });
}

function queueWriteFailure(saved: { error?: { code: string; message: string } }): SettingsApiResult {
  const error = saved.error ?? { code: 'kb.job.write-failed', message: 'The job queue could not be written.' };
  return failure(500, error.code, error.message);
}

async function jobCancelRoute(req: SettingsApiRequest, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const loaded = await loadQueue(deps.jobsDir());
  const cancelled = cancelJob(loaded.queue, asText(parsed.value.id));
  if (cancelled.job === undefined) {
    return failure(404, 'kb.job.unknown', 'No queued job has that id.');
  }
  const saved = await saveQueue(cancelled.queue, deps.jobsDir());
  if (!saved.ok) return queueWriteFailure(saved);
  return success({ summary: queueSummary(cancelled.queue), jobs: cancelled.queue.jobs.slice(-100) });
}

async function jobRecoverRoute(deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const loaded = await loadQueue(deps.jobsDir());
  const recovered = recoverQueue(loaded.queue);
  const saved = await saveQueue(recovered.queue, deps.jobsDir());
  if (!saved.ok) return queueWriteFailure(saved);
  return success({ summary: queueSummary(recovered.queue) });
}

async function jobPruneRoute(req: SettingsApiRequest, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const keepDone = parsed.value.keepDone;
  const loaded = await loadQueue(deps.jobsDir());
  const pruned = pruneQueue(
    loaded.queue,
    typeof keepDone === 'number' && Number.isFinite(keepDone) ? { keepDone } : {},
  );
  const saved = await saveQueue(pruned.queue, deps.jobsDir());
  if (!saved.ok) return queueWriteFailure(saved);
  return success({ summary: queueSummary(pruned.queue) });
}

async function feedbackReadRoute(url: URL, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const report = await readFeedback(deps.vaultFor(url.searchParams.get('address') ?? ''));
  return success({ path: report.path, exists: report.exists, rows: report.rows, allowWrites: deps.allowWrites() });
}

async function feedbackAppendRoute(req: SettingsApiRequest, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const root = deps.vaultFor(asText(body.address));
  const written = await appendFeedback(root, { note: asText(body.path), text: asText(body.text) }, { allowWrites: deps.allowWrites() });
  if (!written.ok) {
    const error = written.error ?? { code: 'kb.feedback.write-failed', message: 'The feedback note could not be written.' };
    return failure(error.code === 'kb.feedback.read-only' ? 403 : 400, error.code, error.message);
  }
  // Re-read after the append so the caller gets the parsed row (and its index),
  // not a client-side guess at how the note was laid out on disk.
  let rows = (await readFeedback(root)).rows;
  if (written.index !== undefined && rows.length <= written.index) rows = (await readFeedback(root)).rows;
  return success({ path: written.path, index: written.index, rows });
}

async function feedbackDoneRoute(req: SettingsApiRequest, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const parsed = jsonBody(req);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const rawIndex = body.index;
  const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : -1;
  const root = deps.vaultFor(asText(body.address));
  const marked = await markFeedbackDone(root, index, { allowWrites: deps.allowWrites() });
  if (!marked.ok) {
    const error = marked.error ?? { code: 'kb.feedback.write-failed', message: 'The feedback note could not be written.' };
    const status = error.code === 'kb.feedback.read-only' ? 403 : error.code === 'kb.feedback.missing-index' ? 404 : 400;
    return failure(status, error.code, error.message);
  }
  return success({ rows: (await readFeedback(root)).rows });
}

export async function handleSettingsApi(req: SettingsApiRequest, deps: SettingsApiDeps): Promise<SettingsApiResult> {
  const pathname = req.pathname === '' ? '/' : req.pathname;
  const method = (req.method === '' ? 'GET' : req.method).toUpperCase();
  let url: URL;
  try {
    url = new URL('http://local' + pathname + (req.search ?? ''));
  } catch {
    return failure(400, 'kb.api.bad-path', 'The request path is not a valid URL path.');
  }
  try {
    if (method === 'GET') {
      if (pathname === '/config') return configPayload(deps);
      if (pathname === '/schema') return await schemaReadRoute(url, deps);
      if (pathname === '/vaults') return vaultsRoute(deps);
    if (pathname === '/memory') return await memoryRoute(deps);
      if (pathname === '/jobs') return await jobsRoute(deps);
      if (pathname === '/feedback') return await feedbackReadRoute(url, deps);
    } else if (method === 'POST') {
      if (pathname === '/config') return saveConfigRoute(req, deps);
      if (pathname === '/schema') return await schemaWriteRoute(req, deps);
      if (pathname === '/vault/init') return vaultInitRoute(req, deps);
      if (pathname === '/vault/active') return vaultActiveRoute(req, deps);
      if (pathname === '/jobs/cancel') return await jobCancelRoute(req, deps);
      if (pathname === '/jobs/recover') return await jobRecoverRoute(deps);
      if (pathname === '/jobs/prune') return await jobPruneRoute(req, deps);
      if (pathname === '/feedback') return await feedbackAppendRoute(req, deps);
      if (pathname === '/feedback/done') return await feedbackDoneRoute(req, deps);
    }
  } catch (error) {
    // A broken vault path or a failed read must still answer JSON, never hang the page.
    return failure(500, 'kb.api.failed', error instanceof Error ? error.message : String(error));
  }
  return failure(404, 'kb.api.not-found', 'No route matches ' + method + ' ' + pathname + '.');
}
