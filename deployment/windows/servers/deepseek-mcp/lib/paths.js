import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
/**
 * Shared path comparison for workspace matching and containment checks.
 * Identity only — does not resolve relative segments.
 */
export function normalizePath(path) {
    const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
}
export function pathsEqual(left, right) {
    return normalizePath(left) === normalizePath(right);
}
/** Resolve a tool path against a workspace and prove it does not escape it. */
export function isPathInsideWorkspace(path, workspace) {
    if (path.trim() === '' || workspace.trim() === '')
        return false;
    const root = resolve(workspace);
    const candidate = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (!isContainedPath(candidate, root))
        return false;
    if (!existsSync(root))
        return true;
    try {
        const realRoot = realpathSync.native(root);
        const realCandidate = realpathSync.native(nearestExistingPath(candidate));
        return isContainedPath(realCandidate, realRoot);
    }
    catch {
        return false;
    }
}
function nearestExistingPath(path) {
    let current = path;
    while (!existsSync(current)) {
        const parent = dirname(current);
        if (pathsEqual(parent, current))
            return current;
        current = parent;
    }
    return current;
}
function isContainedPath(candidate, root) {
    if (pathsEqual(candidate, root))
        return true;
    const rel = relative(root, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
