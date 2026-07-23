const CRAFT_DISPLAY_NAME_KEY = '_displayName';
const CRAFT_INTENT_KEY = '_intent';

const CRAFT_DISPLAY_NAME_SCHEMA = {
  type: 'string',
  description: 'Craft UI metadata: human-friendly action name for display only.',
};

const CRAFT_INTENT_SCHEMA = {
  type: 'string',
  description: 'Craft UI metadata: concise tool-call intent for display only.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneWithDescriptors<T extends object>(value: T): T {
  const clone = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
  return clone;
}

/**
 * 返回一个接受 Craft 根级元数据字段的 Pi 工具 schema。
 *
 * Pi 在 Craft 的 pre-tool-use 钩子剥除 `_displayName` / `_intent` 之前就会校验工具参数。
 * Pi 内置工具常用带 `additionalProperties: false` 的严格 schema，因此我们在适配器边界
 * 把这些字段加为可选的根级属性。未知 schema 形状原样返回；如果 Pi 后续也定义了同名
 * 元数据属性，以 Pi 的为准。
 */
export function allowCraftMetadataProperties<T>(schema: T): T {
  if (!isRecord(schema)) return schema;

  const properties = schema.properties;
  if (!isRecord(properties)) return schema;

  const nextSchema = cloneWithDescriptors(schema);
  const nextProperties = cloneWithDescriptors(properties);

  if (!(CRAFT_DISPLAY_NAME_KEY in nextProperties)) {
    nextProperties[CRAFT_DISPLAY_NAME_KEY] = CRAFT_DISPLAY_NAME_SCHEMA;
  }
  if (!(CRAFT_INTENT_KEY in nextProperties)) {
    nextProperties[CRAFT_INTENT_KEY] = CRAFT_INTENT_SCHEMA;
  }

  Object.defineProperty(nextSchema, 'properties', {
    value: nextProperties,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return nextSchema as T;
}

/** 调用上游 Pi 工具实现前，剥除仅用于 Craft 的元数据。 */
export function stripCraftMetadata<T>(input: T): T {
  if (!isRecord(input)) return input;
  if (!(CRAFT_DISPLAY_NAME_KEY in input) && !(CRAFT_INTENT_KEY in input)) return input;

  const cleanInput = { ...input };
  delete cleanInput[CRAFT_DISPLAY_NAME_KEY];
  delete cleanInput[CRAFT_INTENT_KEY];

  return cleanInput as T;
}
