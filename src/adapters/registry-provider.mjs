import { createAdapters } from './index.mjs';

/**
 * Deep freezes an object and its nested properties.
 *
 * @param {object} obj
 * @returns {object}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    try {
      const val = obj[key];
      if (val !== null && typeof val === 'object') {
        deepFreeze(val);
      }
    } catch (_) {}
  }
  return obj;
}

/**
 * Factory for registered adapter provider.
 * Returns callable provider(op, serviceId) with provider.release(operationId).
 * Caches adapters by operation ID (op.id or op.operationId).
 * Builds createAdapters({ definitions: op.registrySnapshot?.services, ...options }).
 * Legacy ops without registrySnapshot fallback to default 2 legacy adapters.
 */
export function createRegisteredAdapterProvider(options = {}) {
  const cache = new Map();
  const frozenOptions = Object.freeze({ ...options });

  const provider = async (op, serviceId) => {
    if (op && typeof op === 'object') {
      if (op.registrySnapshot && typeof op.registrySnapshot === 'object') {
        deepFreeze(op.registrySnapshot);
      }
      deepFreeze(op);
    }

    const opId = op?.id || op?.operationId;
    let adapters;
    if (opId && cache.has(opId)) {
      adapters = cache.get(opId);
    } else {
      const rawDefinitions = op?.registrySnapshot?.services;
      let definitions;
      if (Array.isArray(rawDefinitions)) {
        try {
          definitions = deepFreeze(structuredClone(rawDefinitions));
        } catch (_) {
          try {
            definitions = deepFreeze(JSON.parse(JSON.stringify(rawDefinitions)));
          } catch (_) {
            definitions = deepFreeze(rawDefinitions.map((d) => ({ ...d })));
          }
        }
      }

      if (Array.isArray(definitions)) {
        adapters = createAdapters({
          ...options,
          definitions
        });
      } else {
        adapters = createAdapters({
          ...options
        });
      }
      if (adapters && typeof adapters === 'object') {
        Object.freeze(adapters);
      }
      if (opId) {
        cache.set(opId, adapters);
      }
    }
    return adapters?.[serviceId];
  };

  provider.release = (operationId) => {
    if (operationId) {
      cache.delete(operationId);
    }
  };

  provider.clear = () => {
    cache.clear();
  };

  provider.has = (operationId) => {
    return cache.has(operationId);
  };

  Object.defineProperty(provider, 'size', {
    get: () => cache.size,
    enumerable: true
  });

  provider.options = frozenOptions;
  provider.vault = options.vault || null;
  provider.store = options.store || null;
  provider.dataDir = options.dataDir || null;
  provider.security = options.security || null;

  return provider;
}
