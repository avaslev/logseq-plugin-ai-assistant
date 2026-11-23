import type { ToolCall, ToolSpec } from "./llm";

type JsonObject = Record<string, unknown>;
type Schema = Record<string, unknown>;

export interface RepairedToolCall {
  call: ToolCall;
  // Set when the call cannot be executed as-is. The message is meant to be
  // returned to the model as the tool result so it can correct itself.
  error?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(text: string): JsonObject | null {
  let raw = (text || "").trim();
  if (!raw) return {};
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) raw = fenced[1].trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    // Small models often emit trailing commas or wrap JSON into prose.
    const withoutTrailingCommas = raw.replace(/,\s*([}\]])/g, "$1");
    const candidates = [withoutTrailingCommas];
    const start = withoutTrailingCommas.indexOf("{");
    const end = withoutTrailingCommas.lastIndexOf("}");
    if (start >= 0 && end > start) {
      candidates.push(withoutTrailingCommas.slice(start, end + 1));
    }
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (isObject(parsed)) return parsed;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }
}

function coerce(
  value: unknown,
  schema: Schema,
  key: string
): { value?: unknown; error?: string } {
  if (value === undefined) {
    return Object.prototype.hasOwnProperty.call(schema, "default")
      ? { value: schema.default }
      : {};
  }
  const type = schema.type;
  if (type === "string") {
    if (typeof value === "string") return { value };
    if (typeof value === "number" || typeof value === "boolean") {
      return { value: String(value) };
    }
    return { error: `${key} must be a string` };
  }
  if (type === "number" || type === "integer") {
    const num = typeof value === "string" ? Number(value.trim()) : value;
    if (typeof num === "number" && Number.isFinite(num)) {
      if (type === "integer" && !Number.isInteger(num)) {
        return { error: `${key} must be an integer` };
      }
      return { value: num };
    }
    return { error: `${key} must be a number` };
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return { value };
    if (value === "true" || value === 1) return { value: true };
    if (value === "false" || value === 0) return { value: false };
    return { error: `${key} must be true or false` };
  }
  if (type === "array") {
    if (Array.isArray(value)) return { value };
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) return { value: parsed };
      } catch {
        return { value: value.split(",").map((item) => item.trim()) };
      }
    }
    return { error: `${key} must be an array` };
  }
  if (type === "object") {
    if (isObject(value)) return { value };
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (isObject(parsed)) return { value: parsed };
      } catch {
        // Fall through to the validation error.
      }
    }
    return { error: `${key} must be an object` };
  }
  return { value };
}

function schemaSummary(schema: Schema): string {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const parts = Object.entries(properties).map(([key, raw]) => {
    const type = isObject(raw) && typeof raw.type === "string" ? raw.type : "any";
    return required.includes(key) ? `${key}: ${type} (required)` : `${key}: ${type}`;
  });
  return parts.length > 0 ? parts.join(", ") : "no parameters";
}

// Repairs the JSON and the obvious type mistakes a weak model makes. If a
// required field is still missing (or has the wrong type), returns a short
// error for the model instead of calling the tool with garbage.
export function repairToolCall(call: ToolCall, tools: ToolSpec[]): RepairedToolCall {
  const spec = tools.find((item) => item.function.name === call.function.name);
  if (!spec) return { call };

  const schema = spec.function.parameters;
  const raw = parseArguments(
    typeof call.function.arguments === "string" ? call.function.arguments : ""
  );
  if (!raw) {
    return {
      call,
      error: `Invalid JSON arguments for ${call.function.name}. Expected: ${schemaSummary(schema)}`,
    };
  }

  const properties = isObject(schema.properties) ? schema.properties : {};
  const repaired: JsonObject = {};
  const errors: string[] = [];
  const knownKeys = new Set(Object.keys(properties));

  for (const [key, value] of Object.entries(raw)) {
    if (knownKeys.size > 0 && !knownKeys.has(key)) continue;
    const property = properties[key];
    if (!isObject(property)) {
      repaired[key] = value;
      continue;
    }
    const result = coerce(value, property, key);
    const allowed = property.enum;
    if (result.error) {
      errors.push(result.error);
    } else if (
      Array.isArray(allowed) &&
      result.value !== undefined &&
      !allowed.includes(result.value)
    ) {
      errors.push(`${key} must be one of ${allowed.join(", ")}`);
    } else if (result.value !== undefined) {
      repaired[key] = result.value;
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    if (
      repaired[key] === undefined &&
      isObject(property) &&
      Object.prototype.hasOwnProperty.call(property, "default")
    ) {
      repaired[key] = property.default;
    }
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (repaired[key] === undefined) {
      errors.push(`missing required "${key}"`);
    }
  }

  if (errors.length > 0) {
    return {
      call,
      error: `Invalid arguments for ${call.function.name}: ${errors.join("; ")}. Expected: ${schemaSummary(schema)}`,
    };
  }

  return {
    call: {
      ...call,
      function: { ...call.function, arguments: JSON.stringify(repaired) },
    },
  };
}
