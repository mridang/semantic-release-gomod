/**
 * @file Small type guards and readers for untrusted, unknown values.
 */

/**
 * Whether a value is a plain object: not null and not an array.
 * @param value - Value to check.
 * @returns True for objects with string keys.
 * @example
 * isRecord({ name: 'gomod' }); // true
 * isRecord(['a']); // false
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an own string property of an untrusted object; inherited members are
 * ignored.
 * @param record - The object.
 * @param key - Property name.
 * @returns The value when it is a string, otherwise undefined.
 * @example
 * stringAt({ code: 'ENOENT' }, 'code'); // 'ENOENT'
 * stringAt({ code: 404 }, 'code'); // undefined
 */
export function stringAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}
