/** Link this checkout to an existing, built DSH checkout without editing it. */
import { lstat, mkdir, readFile, readdir, realpath, symlink, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const checkout = resolve(process.argv[2] ?? '../deepseek-harness')
const destination = join(project, 'node_modules')
const ownManifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))

async function link(source, target) {
  try {
    const entry = await lstat(target)
    if (!entry.isSymbolicLink() || await realpath(source) === await realpath(target)) return
    await unlink(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(target), { recursive: true })
  await symlink(source, target, 'junction')
}

for (const entry of await readdir(join(checkout, 'node_modules'), { withFileTypes: true })) {
  if (entry.name === '@deepseek-ai' || entry.name === '.bin') continue
  await link(join(checkout, 'node_modules', entry.name), join(destination, entry.name))
}

const candidates = []
for (const group of await readdir(join(checkout, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const entry of await readdir(join(checkout, 'packages', group.name), { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(join(checkout, 'packages', group.name, entry.name))
  }
}
for (const entry of await readdir(join(checkout, 'vendor'), { withFileTypes: true })) {
  if (entry.isDirectory()) candidates.push(join(checkout, 'vendor', entry.name))
}
for (const directory of candidates) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') continue
    throw error
  }
  if (typeof manifest.name === 'string') await link(directory, join(destination, manifest.name))
}
const needed = Object.keys({ ...ownManifest.dependencies, ...ownManifest.peerDependencies, ...ownManifest.devDependencies })
for (const name of needed) {
  try {
    await readFile(join(destination, name, 'package.json'), 'utf8')
    continue
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
  }
  for (const directory of [checkout, ...candidates]) {
    const source = join(directory, 'node_modules', name)
    try {
      await readFile(join(source, 'package.json'), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      throw error
    }
    await link(source, join(destination, name))
    break
  }
}
await link(join(destination, 'vitest/vitest.mjs'), join(destination, '.bin/vitest'))
await link(join(destination, 'typescript/bin/tsc'), join(destination, '.bin/tsc'))
console.log(`Linked build dependencies from ${checkout}`)
