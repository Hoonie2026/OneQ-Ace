/**
 * shared/pack-schema.json을 그대로 읽어 검사하는 작은 JSON Schema 해석기.
 *
 * ajv 같은 라이브러리는 검사 코드를 런타임에 생성(new Function)하므로 앱의 CSP(script-src 'self')에
 * 막힌다. 그래서 스키마에 실제로 쓰는 키워드만 직접 해석한다. 스키마에 새 키워드를 쓰면 여기에 추가할 것.
 * 지원: $ref(#/$defs/..), type, const, enum, pattern, minimum, maximum, minLength,
 *       minItems, maxItems, items, prefixItems, uniqueItems, required, properties, additionalProperties
 * 무시: format, description, title, $id, $schema (Python 쪽도 format은 검사하지 않음)
 */

export type Schema = { [k: string]: unknown };

const SUPPORTED = new Set([
  '$ref', '$defs', '$schema', '$id', 'title', 'description', 'format',
  'type', 'const', 'enum', 'pattern', 'minimum', 'maximum', 'minLength',
  'minItems', 'maxItems', 'items', 'prefixItems', 'uniqueItems',
  'required', 'properties', 'additionalProperties',
]);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateSchema(root: Schema, schema: Schema, value: unknown, path = ''): string[] {
  const errs: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED.has(k)) throw new Error(`miniSchema: 지원하지 않는 키워드 ${k}`);
  }
  if (typeof schema.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const defs = root.$defs as Record<string, Schema> | undefined;
    if (!m || !defs || !defs[m[1]]) throw new Error(`miniSchema: 해석할 수 없는 $ref ${schema.$ref}`);
    errs.push(...validateSchema(root, defs[m[1]], value, path));
  }
  const at = path || '/';
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeMatches(value, t))) {
      errs.push(`${at}: 형식 ${types.join('|')} 필요(현재 ${typeOf(value)})`);
      return errs;
    }
  }
  if ('const' in schema && !deepEqual(value, schema.const)) errs.push(`${at}: ${JSON.stringify(schema.const)} 이어야 함`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errs.push(`${at}: 허용 값 ${JSON.stringify(schema.enum)} 아님`);
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${at}: 패턴 불일치`);
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) errs.push(`${at}: 너무 짧음`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errs.push(`${at}: ${schema.minimum} 이상이어야 함`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errs.push(`${at}: ${schema.maximum} 이하이어야 함`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push(`${at}: 원소 ${schema.minItems}개 이상 필요`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errs.push(`${at}: 원소 ${schema.maxItems}개 이하`);
    if (schema.uniqueItems === true) {
      const s = new Set(value.map((v) => JSON.stringify(v)));
      if (s.size !== value.length) errs.push(`${at}: 중복 원소`);
    }
    const prefix = Array.isArray(schema.prefixItems) ? (schema.prefixItems as Schema[]) : [];
    value.forEach((v, i) => {
      if (i < prefix.length) errs.push(...validateSchema(root, prefix[i], v, `${path}/${i}`));
      else if (schema.items === false) errs.push(`${path}/${i}: 허용되지 않는 원소`);
      else if (schema.items && typeof schema.items === 'object') errs.push(...validateSchema(root, schema.items as Schema, v, `${path}/${i}`));
    });
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in obj)) errs.push(`${at}: 필수 필드 ${r} 없음`);
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errs.push(...validateSchema(root, props[k], v, `${path}/${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}/${k}: 정의되지 않은 필드`);
    }
  }
  return errs;
}
