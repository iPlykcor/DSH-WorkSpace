/**
 * Declarations for the build-time virtual wasm modules the `archive` chunk
 * imports (`dsh-wasm/7z`, `dsh-wasm/unrar`). tsdown resolves these to the
 * base64-encoded .wasm payloads (see inlineWasmPlugin in tsdown.config.ts);
 * this file only gives TypeScript a concrete type so the chunk source typechecks.
 */
declare module 'dsh-wasm/7z' {
  const base64: string
  export default base64
}

declare module 'dsh-wasm/unrar' {
  const base64: string
  export default base64
}
