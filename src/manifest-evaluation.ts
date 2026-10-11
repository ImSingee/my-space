export const MANIFEST_RESULT = '[[hatch-manifest]]';
// Execute before author code; retain the intrinsics needed for data extraction.
export const MANIFEST_SERIALIZER = String.raw`
const __hatchSerialize = (() => {
  const stringify = JSON.stringify;
  const descriptors = Object.getOwnPropertyDescriptors;
  const prototype = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  const create = Object.create;
  const isArray = Array.isArray;
  const keys = Reflect.ownKeys;
  const finite = Number.isFinite;
  const emit = console.log.bind(console);
  return (value) => {
    const ancestors = new Set();
    function copy(item, location) {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
      if (typeof item === 'number' && finite(item)) return item;
      if (typeof item !== 'object') throw new Error(location + ': expected JSON data');
      if (ancestors.has(item)) throw new Error(location + ': circular reference');
      const array = isArray(item);
      const proto = prototype(item);
      if (array ? proto !== arrayPrototype : proto !== objectPrototype && proto !== null) throw new Error(location + ': expected a plain JSON object');
      ancestors.add(item);
      const output = array ? [] : create(null);
      const props = descriptors(item);
      for (const key of keys(props)) {
        if (array && key === 'length') continue;
        const prop = props[key];
        if (typeof key !== 'string' || !prop.enumerable || !('value' in prop)) throw new Error(location + ': unsupported property');
        if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error(location + ': unsupported array property');
        output[key] = copy(prop.value, location + '.' + key);
      }
      if (array && keys(output).length - 1 !== item.length) throw new Error(location + ': sparse arrays are not JSON data');
      ancestors.delete(item);
      return output;
    }
    if (!value || typeof value !== 'object' || isArray(value)) throw new Error('manifest.ts must default-export a plain object');
    emit('${MANIFEST_RESULT}' + stringify(copy(value, 'manifest')));
  };
})();
`;
