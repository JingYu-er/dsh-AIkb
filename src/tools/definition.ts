/**
 * Structural copy of the DSH tool DSL. The plugin ships no runtime dependency on
 * @deepseek-ai/dsh-tools: the host validates and dispatches the definition, we only
 * have to produce a conforming object. Keeping the types here also keeps the plugin
 * loadable across DSH releases.
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
