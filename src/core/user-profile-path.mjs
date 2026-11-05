import os from 'node:os';
import path from 'node:path';

export function userProfilePath(...parts) {
  const root = os.homedir();
  if (!root || !path.isAbsolute(root)) throw new Error('USER_PROFILE_UNAVAILABLE');
  for (const part of parts) {
    if (typeof part !== 'string' || !part || path.isAbsolute(part) || /^[A-Za-z]:/.test(part) || part.split(/[\\/]/).includes('..')) {
      throw new Error('INVALID_USER_PROFILE_PATH_PART');
    }
  }
  return path.join(root, ...parts);
}
