/**
 * Fail-safe ownership + cleanup for Goal-created temporary paths.
 * Never deletes unmarked user files or the workspace root.
 */
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseMkdirPaths, parseWorktreeAddPath, } from './goal-facts.js';
import { pathsEqual } from './paths.js';
const RELEASE_NOTES = /(?:^|[/\\])release-notes-v[^/\\]+\.md$/i;
const RELEASE_VERIFY = /(?:^|[/\\])_release-verify(?:[/\\]|$)/i;
const TARBALL = /(?:^|[/\\])[^/\\]+\.tgz$/i;
export function normalizeWorkspacePath(path) {
    return resolve(path);
}
/** Absolute path if `path` is inside `workspace` and is not the workspace root. */
export function resolveInsideWorkspace(path, workspace) {
    const root = normalizeWorkspacePath(workspace);
    const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (pathsEqual(abs, root))
        return undefined;
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
        return undefined;
    if (rel.split(sep).includes('..'))
        return undefined;
    return abs;
}
export function isTempPattern(path) {
    return RELEASE_NOTES.test(path) || RELEASE_VERIFY.test(path) || TARBALL.test(path);
}
export function isSafeToDelete(resource, workspace) {
    if (resource.temporary !== true || resource.created_by_goal !== true)
        return false;
    if (resource.path === '' || resource.session_id === '' || resource.goal_id === '')
        return false;
    return resolveInsideWorkspace(resource.path, workspace) !== undefined;
}
function record(seen, path, kind, sessionId, goalId, seq, workspace) {
    const abs = resolveInsideWorkspace(path, workspace);
    if (abs === undefined)
        return;
    if (!isTempPattern(abs) && kind !== 'worktree')
        return;
    if (seen.has(abs))
        return;
    seen.set(abs, {
        path: abs,
        kind,
        session_id: sessionId,
        goal_id: goalId,
        created_by_goal: true,
        temporary: true,
        seq,
    });
}
function tarballFromText(text) {
    if (text === undefined)
        return undefined;
    const match = text.match(/(?:^|[\s/\\])([^\s/\\]+\.tgz)\b/i);
    return match?.[1];
}
/** Reconstruct goal-owned temps from structured tool facts / write paths. */
export function discoverTempResources(input) {
    const seen = new Map();
    const workspace = input.workspacePath;
    for (const fact of input.facts.tools) {
        if (!fact.ok)
            continue;
        if (fact.kinds.includes('git_worktree_add') && fact.command !== undefined) {
            const path = parseWorktreeAddPath(fact.command);
            if (path !== undefined)
                record(seen, path, 'worktree', input.sessionId, input.goalId, fact.seq, workspace);
        }
        if (fact.kinds.includes('npm_pack')) {
            const tarball = tarballFromText(fact.resultText) ?? tarballFromText(fact.command);
            if (tarball !== undefined)
                record(seen, tarball, 'file', input.sessionId, input.goalId, fact.seq, workspace);
        }
        if (fact.command !== undefined) {
            for (const path of parseMkdirPaths(fact.command)) {
                if (RELEASE_VERIFY.test(path)) {
                    record(seen, path, 'directory', input.sessionId, input.goalId, fact.seq, workspace);
                }
            }
        }
        if (fact.filePath !== undefined && isTempPattern(fact.filePath)) {
            const kind = RELEASE_VERIFY.test(fact.filePath) && !RELEASE_NOTES.test(fact.filePath) && !TARBALL.test(fact.filePath)
                ? 'directory'
                : 'file';
            record(seen, fact.filePath, kind, input.sessionId, input.goalId, fact.seq, workspace);
        }
    }
    return [...seen.values()];
}
function defaultIo() {
    return {
        exists: (path) => existsSync(path),
        remove: (path) => {
            rmSync(path, { recursive: true, force: true });
        },
        removeWorktree: (path, workspacePath) => {
            spawnSync('git', ['worktree', 'remove', '--force', path], {
                cwd: workspacePath,
                encoding: 'utf8',
                timeout: 15_000,
                windowsHide: true,
            });
        },
    };
}
/**
 * Delete only resources that pass the fail-safe checks.
 * Cleanup errors become warnings; they do not throw.
 */
export function cleanupTempResources(resources, workspacePath, io = defaultIo()) {
    const removed = [];
    const warnings = [];
    for (const resource of resources) {
        if (!isSafeToDelete(resource, workspacePath))
            continue;
        const abs = resolveInsideWorkspace(resource.path, workspacePath);
        if (abs === undefined)
            continue;
        try {
            if (resource.kind === 'worktree' && io.removeWorktree !== undefined) {
                io.removeWorktree(abs, normalizeWorkspacePath(workspacePath));
            }
            if (io.exists(abs))
                io.remove(abs);
            removed.push(abs);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`${abs}: ${message}`);
        }
    }
    return { removed, warnings };
}
