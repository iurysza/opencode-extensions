// Pure release policy shared by local pack checks and production publication.
export const PACKAGES = Object.freeze([
  Object.freeze({ directory: "packages/opencode-cursor-sdk", name: "@iurysza/opencode-cursor-sdk", component: "opencode-cursor-sdk" }),
  Object.freeze({ directory: "packages/opencode-cursor-cloud", name: "@iurysza/opencode-cursor-cloud", component: "opencode-cursor-cloud" }),
]);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$(?![\s\S])/;
export const REGISTRY = "https://registry.npmjs.org";

export function packageForDirectory(directory) {
  const pkg = PACKAGES.find((entry) => entry.directory === directory);
  if (!pkg) throw new Error("Only the two allowlisted child packages can be packed or published; root publication is forbidden");
  return pkg;
}

export function parseReleaseTag(tag) {
  if (typeof tag !== "string") throw new Error("Release tag is required");
  const pkg = PACKAGES.find((entry) => tag.startsWith(`${entry.component}-v`));
  const version = pkg && tag.slice(pkg.component.length + 2);
  if (!pkg || !stableVersion.test(version)) throw new Error("Unknown release tag or noncanonical stable version");
  return { ...pkg, version, tag };
}

export function validateManifest({ rootManifest, manifest, directory, release, production = false }) {
  const pkg = packageForDirectory(directory);
  if (rootManifest.private !== true) throw new Error("Root workspace must remain private");
  if (manifest.name !== pkg.name) throw new Error("Package name does not match the directory allowlist");
  if (!stableVersion.test(manifest.version)) throw new Error("Package version must be canonical stable semver");
  if (release && (release.directory !== directory || release.name !== manifest.name || release.version !== manifest.version)) {
    throw new Error("Release tag, package name, directory and current version must agree");
  }
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    const value = manifest[field];
    if (value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0)) {
      throw new Error("Bundled dependencies are forbidden, including @cursor/sdk");
    }
  }
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    if (typeof range !== "string" || /^(?:file:|link:|workspace:|git|https?:|[./])/.test(range)) {
      throw new Error(`Non-registry runtime dependency is forbidden: ${name}`);
    }
  }
  if (production) {
    if (!release) throw new Error("Production publication requires a validated release tag");
    if (manifest.private !== undefined && manifest.private !== false) throw new Error("Child package is still private");
    const config = manifest.publishConfig;
    if (config?.access !== "public" || config?.provenance !== true || config?.registry !== REGISTRY) {
      throw new Error("Publication requires explicit public access, npm registry and provenance");
    }
  }
  return pkg;
}

export function validatePack({ files, manifest }) {
  if (!Array.isArray(files) || !files.length) throw new Error("Packed file list is empty");
  const seen = new Set();
  for (const path of files) {
    if (typeof path !== "string" || seen.has(path)) throw new Error("Invalid or duplicate packed path");
    seen.add(path);
    if (/[\r\n\\]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Unsafe packed path");
    }
    const docs = /^(?:package\.json|README(?:\.md)?|LICENSE(?:\.md|\.txt)?|CHANGELOG\.md)$/i.test(path);
    const compiled = /^dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|d\.ts)$/.test(path);
    if ((!docs && !compiled) || /(?:^|\/)(?:node_modules|vendor|vendors|bundled|sdk)(?:\/|$)/i.test(path)) {
      throw new Error(`File outside pack allowlist, SDK vendoring forbidden: ${path}`);
    }
  }
  if (!seen.has("package.json") || !files.some((path) => path.endsWith(".js")) || !files.some((path) => path.endsWith(".d.ts"))) {
    throw new Error("Tarball must contain its manifest, compiled JavaScript and declarations");
  }
  const targets = (value) => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
  for (const target of targets(manifest.exports)) {
    if (!target.startsWith("./dist/") || !seen.has(target.slice(2))) throw new Error("Export target missing from compiled tarball");
  }
}
