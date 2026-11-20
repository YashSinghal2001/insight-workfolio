// Dashboard unit-test loader: `node --import ./test/register-tsx.mjs --test …`.
// In-thread module hooks (module.registerHooks; module.register is deprecated on Node 26) that
//  - resolve the `@/` alias to src/ and extensionless relative imports (.ts, .tsx, /index.ts[x]), as Next does;
//  - transpile .ts/.tsx to ESM with the installed `typescript` (jsx: react-jsx). Types are not checked here:
//    `pnpm typecheck` does that.
//  - serve `react/jsx-runtime` (CommonJS whose named exports Node cannot detect) through an ESM shim.
import { registerHooks } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const JSX_SHIM = "iw-shim:react-jsx-runtime";
const JSX_SOURCE = `import { createRequire } from "node:module";
const r = createRequire(${JSON.stringify(import.meta.url)})("react/jsx-runtime");
export const { jsx, jsxs, Fragment } = r;`;
const SRC = new URL("../src/", import.meta.url);
const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const isFile = (url) => {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
};

registerHooks({
  resolve(specifier, context, next) {
    if (context.conditions?.includes("require")) return next(specifier, context); // CommonJS: Node's own rules
    if (specifier === "react/jsx-runtime") return { url: JSX_SHIM, shortCircuit: true };
    const base = specifier.startsWith("@/")
      ? new URL(specifier.slice(2), SRC).href
      : /^\.{0,2}\//.test(specifier) && context.parentURL?.startsWith("file:")
        ? new URL(specifier, context.parentURL).href
        : null;
    const hit = base && SUFFIXES.map((s) => base + s).find(isFile);
    return next(hit || specifier, context);
  },
  load(url, context, next) {
    if (url === JSX_SHIM) return { format: "module", source: JSX_SOURCE, shortCircuit: true };
    if (!url.startsWith("file:") || !/\.tsx?$/.test(new URL(url).pathname)) return next(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        sourceMap: false,
        inlineSourceMap: true,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
