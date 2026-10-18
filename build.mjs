/** Build ordinary Node ESM, generated Remote codecs, and a DSH lazy-CJS browser half. */
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { WorkspaceTypertGenerator, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'
import { transform } from 'lightningcss'
import { build } from 'tsdown'

const root = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)
const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
const compiler = require.resolve('typescript/bin/tsc')
const compile = config => execFileSync(process.execPath, [compiler, '--project', config], { cwd: root, stdio: 'inherit' })

await rm(join(root, 'lib'), { recursive: true, force: true })
compile('tsconfig.json')

// The public generator discovers packages beneath a workspace's packages/ directory.
const workspace = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-build-'))
try {
  const packageRoot = join(workspace, 'packages', 'plugin')
  await mkdir(packageRoot, { recursive: true })
  await cp(join(root, 'src'), join(packageRoot, 'src'), { recursive: true })
  await cp(join(root, 'package.json'), join(packageRoot, 'package.json'))
  await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'junction')
  const compilerOptions = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')).compilerOptions
  const protocolRoot = join(workspace, 'packages', 'protocol')
  await mkdir(protocolRoot, { recursive: true })
  const installedProtocol = dirname(require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'))
  await cp(join(installedProtocol, 'lib/types'), join(protocolRoot, 'src'), { recursive: true })
  await writeFile(join(protocolRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-typert-protocol', type: 'module',
    exports: { '.': './src/index.d.ts', './types': './src/types.d.ts' },
  }))
  const paths = {
    '@deepseek-ai/dsh-typert-protocol': [join(protocolRoot, 'src/index.d.ts')],
    '@deepseek-ai/dsh-typert-protocol/types': [join(protocolRoot, 'src/types.d.ts')],
  }
  await writeFile(join(packageRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { ...compilerOptions, paths }, include: ['src/*.ts'], exclude: ['src/client'],
  }))
  await writeFile(join(protocolRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { ...compilerOptions, paths, noEmit: true }, include: ['src/**/*.d.ts'],
  }))
  await writeFile(join(workspace, 'tsconfig.host.json'), JSON.stringify({
    compilerOptions: { ...compilerOptions, paths },
    files: [],
    references: [{ path: './packages/plugin' }, { path: './packages/protocol' }],
  }))
  const artifacts = new WorkspaceTypertGenerator(workspace).generate([manifest.name], ['host'])
  if (artifacts.length !== 1 || artifacts[0].remote === undefined) throw new Error('Host Remote metadata was not generated')
  writePackageArtifacts(root, artifacts)
} finally {
  await rm(workspace, { recursive: true, force: true })
}

compile('tsconfig.client.json')

await build({
  config: false,
  cwd: root,
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  deps: { neverBundle: [/@deepseek-ai\//, /@earendil-works\//, /^zod(?:\/|$)/] },
})

const platformModules = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit', ...(manifest.dsh.client.external ?? []),
]
const external = specifier => platformModules.includes(specifier)
await build({
  config: false,
  cwd: root,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  fixedExtension: false,
  deps: { neverBundle: external, alwaysBundle: specifier => !external(specifier) },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'subscription-css-modules',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css') || importer === undefined) return null
      const emitted = resolve(dirname(importer), source)
      const file = join(root, 'src', relative(join(root, 'lib/types'), emitted))
      return `\0subscription-css:${file}.mjs`
    },
    async load(id) {
      if (!id.startsWith('\0subscription-css:')) return null
      const file = id.slice('\0subscription-css:'.length, -'.mjs'.length)
      const result = transform({ filename: file, code: await readFile(file), cssModules: true, minify: true })
      const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([name, entry]) => [name, entry.name]))
      return [
        'const style = document.createElement("style");',
        `style.dataset.plugin = ${JSON.stringify(manifest.name)};`,
        `style.dataset.pluginCss = ${JSON.stringify(`${manifest.name}/SubscriptionCard.module.css`)};`,
        `style.textContent = ${JSON.stringify(result.code.toString())};`,
        'document.head.appendChild(style);',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})

const registrations = []
runInNewContext(await readFile(join(root, 'lib/client.js'), 'utf8'), {
  window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
})
assert.equal(registrations.length, 1)
assert.equal(registrations[0].id, manifest.name)
assert.equal(typeof registrations[0].factory, 'function')
const { default: remote } = await import('./lib/typert.remote-client.js')
assert.equal(remote.descriptors.length, 6)
assert.equal(remote.methods['chatgptSubscription/start'].input().create().safeParse({ owner: 'fixture', provider: 'unsupported' }).success, false)
console.log('Verified lazy client registration and generated Remote validation')
