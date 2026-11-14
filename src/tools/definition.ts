/**
 * Structural copy of the DSH tool DSL, plus the projection step the host expects.
 *
 * What the host actually consumes differs from what a tool author wants to write:
 *  - `tools.register()` validates `output.schema` with assertSupportedJsonSchema, which
 *    accepts only the raw JSON-Schema subset (type/oneOf/properties/required/
 *    additionalProperties/items/enum/const + annotations). Per-property
 *    `required: true` is an author convenience that must be compiled into the
 *    object's `required: [...]` array first.
 *  - `parameters` is handed to the model verbatim, so it must already be a raw
 *    object schema, not a bare property map.
 *
 * The plugin still ships no runtime dependency on @deepseek-ai/dsh-tools: this file
 * reproduces the two conversions that dsh-tools' defineTool() performs.
 */
export type SchemaNode = {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json';
  readonly required?: boolean;
  readonly description?: string;
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: boolean;
  readonly enum?: readonly string[];
};

/** Raw JSON Schema in the subset the host accepts. */
export interface RawSchema {
  readonly type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, RawSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: RawSchema;
}

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolExecution {
  readonly signal?: AbortSignal;
}

export interface ToolDefinition<Args, Value> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, SchemaNode>>;
  readonly output: {
    readonly schema: SchemaNode;
    render(args: Args, value: Value): readonly TextBlock[];
  };
  execute(args: Args, exec: ToolExecution): Promise<Value>;
}

export function defineTool<Args, Value>(definition: ToolDefinition<Args, Value>): ToolDefinition<Args, Value> {
  return definition;
}

/** Compile one author node into the raw subset; `required: true` becomes a parent list. */
export function toRawSchema(node: SchemaNode): RawSchema {
  const description = node.description === undefined ? {} : { description: node.description };
  if (node.type === 'json') return description;
  if (node.type === 'array') {
    return node.items === undefined
      ? { type: 'array', ...description }
      : { type: 'array', items: toRawSchema(node.items), ...description };
  }
  if (node.type === 'object') {
    const properties = Object.entries(node.properties ?? {});
    const compiled: Record<string, RawSchema> = {};
    for (const [key, child] of properties) compiled[key] = toRawSchema(child);
    const required = properties.filter(([, child]) => child.required === true).map(([key]) => key);
    return {
      type: 'object',
      properties: compiled,
      ...(required.length === 0 ? {} : { required }),
      additionalProperties: node.additionalProperties ?? false,
      ...description,
    };
  }
  const leaf: RawSchema = { type: node.type, ...description };
  return node.enum === undefined ? leaf : { ...leaf, enum: node.enum };
}

/** Compile the author parameter map into a raw object schema for the model. */
export function toRawParameters(parameters: Readonly<Record<string, SchemaNode>>): RawSchema {
  return toRawSchema({ type: 'object', properties: parameters });
}

/** Compile a definition into exactly what `ctx.tools.register()` accepts. */
export function toRegisteredTool<Args, Value>(definition: ToolDefinition<Args, Value>): {
  readonly name: string;
  readonly description: string;
  readonly parameters: RawSchema;
  readonly output: { readonly schema: RawSchema; render(args: Args, value: Value): readonly TextBlock[] };
  execute(args: Args, exec: ToolExecution): Promise<Value>;
} {
  return {
    name: definition.name,
    description: definition.description,
    parameters: toRawParameters(definition.parameters),
    output: { schema: toRawSchema(definition.output.schema), render: definition.output.render },
    execute: async (args: Args, exec: ToolExecution) => toLosslessJson(await definition.execute(args, exec)),
  };
}

/**
 * The host rejects a result that does not survive a JSON round-trip ("value is not
 * lossless JSON"). An own property holding `undefined` is the usual cause: JSON drops
 * the key, so the round-trip is no longer deep-equal. Optional fields are therefore
 * omitted rather than set to undefined, and undefined array slots become null.
 */
export function toLosslessJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : toLosslessJson(item))) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      out[key] = toLosslessJson(item);
    }
    return out as T;
  }
  return value;
}

export interface ToolRegisterTarget {
  readonly tools: { register(definition: unknown): void };
}

export function registerTool<Args, Value>(target: ToolRegisterTarget, definition: ToolDefinition<Args, Value>): void {
  target.tools.register(toRegisteredTool(definition));
}
