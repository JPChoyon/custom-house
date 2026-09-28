import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionPackage = JSON.parse(
  readFileSync(
    new URL(
      "../extensions/customhouse-creator-cart-validation/package.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("the Creator cart validation Function declares its reproducible codegen toolchain", () => {
  assert.equal(extensionPackage.dependencies?.["@shopify/shopify_function"], "~2.0.0");
  assert.equal(extensionPackage.devDependencies?.["@graphql-codegen/cli"], "5.0.5");
  assert.equal(extensionPackage.devDependencies?.["@graphql-codegen/typescript"], "4.1.6");
  assert.equal(
    extensionPackage.devDependencies?.["@graphql-codegen/typescript-operations"],
    "4.6.0",
  );
});

test("Shopify app configs no longer use include_config_on_deploy", () => {
  for (const config of ["../shopify.app.toml", "../shopify.app.production.toml"]) {
    const source = readFileSync(new URL(config, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\binclude_config_on_deploy\b/);
  }
});

test("pnpm permits the core-js build needed by the successful Function toolchain", () => {
  const source = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.match(source, /^\s*core-js:\s*true\s*$/m);
});

test("root verification ignores regenerated Function codegen output", () => {
  const source = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(source, /^\/extensions\/\*\/generated\/$/m);
});
