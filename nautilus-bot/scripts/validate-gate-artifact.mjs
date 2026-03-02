#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const schemaPathArg = valueFor("--schema");
const filePathArg = valueFor("--file");

if (!schemaPathArg || !filePathArg) {
  console.error("Usage: node scripts/validate-gate-artifact.mjs --schema <schema.json> --file <artifact.json>");
  process.exit(1);
}

const schemaPath = path.resolve(process.cwd(), schemaPathArg);
const filePath = path.resolve(process.cwd(), filePathArg);

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

function typeMatches(expectedType, value) {
  if (expectedType === "null") return value === null;
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  if (expectedType === "integer") return Number.isInteger(value);
  if (expectedType === "boolean") return typeof value === "boolean";
  if (expectedType === "string") return typeof value === "string";
  return false;
}

function pushError(errors, ptr, message) {
  errors.push(`${ptr}: ${message}`);
}

function validateNode(schemaNode, value, ptr, errors) {
  if (!schemaNode || typeof schemaNode !== "object") return;

  if (schemaNode.type) {
    const expectedTypes = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    const matches = expectedTypes.some((candidate) => typeMatches(candidate, value));
    if (!matches) {
      pushError(errors, ptr, `expected type ${expectedTypes.join(" or ")}`);
      return;
    }
  }

  if (schemaNode.enum && Array.isArray(schemaNode.enum) && !schemaNode.enum.includes(value)) {
    pushError(errors, ptr, `expected one of ${schemaNode.enum.join(", ")}`);
  }

  if (typeof value === "number") {
    if (typeof schemaNode.minimum === "number" && value < schemaNode.minimum) {
      pushError(errors, ptr, `must be >= ${schemaNode.minimum}`);
    }
    if (typeof schemaNode.exclusiveMinimum === "number" && value <= schemaNode.exclusiveMinimum) {
      pushError(errors, ptr, `must be > ${schemaNode.exclusiveMinimum}`);
    }
    if (typeof schemaNode.maximum === "number" && value > schemaNode.maximum) {
      pushError(errors, ptr, `must be <= ${schemaNode.maximum}`);
    }
  }

  if (typeof value === "string") {
    if (typeof schemaNode.minLength === "number" && value.length < schemaNode.minLength) {
      pushError(errors, ptr, `length must be >= ${schemaNode.minLength}`);
    }
    if (typeof schemaNode.pattern === "string") {
      try {
        const regex = new RegExp(schemaNode.pattern);
        if (!regex.test(value)) {
          pushError(errors, ptr, `must match pattern ${schemaNode.pattern}`);
        }
      } catch {
        pushError(errors, ptr, `invalid schema pattern ${schemaNode.pattern}`);
      }
    }
    if (typeof schemaNode.format === "string" && schemaNode.format === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        pushError(errors, ptr, "must match date format YYYY-MM-DD");
      }
    }
    if (typeof schemaNode.format === "string" && schemaNode.format === "date-time") {
      if (Number.isNaN(Date.parse(value))) {
        pushError(errors, ptr, "must match date-time format");
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schemaNode.minItems === "number" && value.length < schemaNode.minItems) {
      pushError(errors, ptr, `must contain at least ${schemaNode.minItems} items`);
    }
    if (schemaNode.items) {
      value.forEach((entry, index) => {
        validateNode(schemaNode.items, entry, `${ptr}/${index}`, errors);
      });
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    const required = Array.isArray(schemaNode.required) ? schemaNode.required : [];
    for (const key of required) {
      if (!(key in value)) {
        pushError(errors, ptr, `missing required property '${key}'`);
      }
    }

    if (schemaNode.properties && typeof schemaNode.properties === "object") {
      for (const [key, propertySchema] of Object.entries(schemaNode.properties)) {
        if (key in value) {
          validateNode(propertySchema, value[key], `${ptr}/${key}`, errors);
        }
      }
    }
  }
}

const errors = [];
validateNode(schema, data, "$", errors);

if (errors.length > 0) {
  console.error(`Schema validation failed for ${filePath} against ${schemaPath}:`);
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

console.log(`Schema validation passed: ${filePath} against ${schemaPath}`);
