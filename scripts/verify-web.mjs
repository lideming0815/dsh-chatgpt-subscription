/** Exercise the installed browser extension through a real, isolated DSH Web profile. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'

const project = fileURLToPath(new URL('..', import.meta.url))
const checkout = resolve(process.env.DSH_CHECKOUT ?? join(project, '../deepseek-harness'))
const cli = join(checkout, 'apps/cli/lib/bin.js')
const root = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-'))
const home = join(root, 'home')
const artifacts = join(project, 'artifacts')
await mkdir(artifacts, { recursive: true })
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1', NODE_NO_WARNINGS: '1' }
delete env.NODE_OPTIONS
delete env.NODE_PATH
for (const name of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|OAUTH_TOKEN)$/u.test(name)) delete env[name]
let child
let browser
let page
let output = ''
const pageErrors = []
const wireErrors = []
async function snapshot(name, text) {
  const directory = join(project, 'tests/expected')
  const path = join(directory, name)
  const actual = `${text.trimEnd()}\n`
  if (process.env.UPDATE_EXPECTED === '1') {
    await mkdir(directory, { recursive: true })
    await writeFile(path, actual)
  }
  assert.equal(actual, await readFile(path, 'utf8'))
}
try {
  execFileSync(process.execPath, [cli, '--profile', 'web', '--dump-config'], { cwd: root, env, stdio: 'pipe' })
  const profile = join(home, 'profiles/web')
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies = { ...manifest.dependencies, 'dsh-chatgpt-subscription': `link:${project}` }
  manifest.dsh.profile.bundles.push('dsh-chatgpt-subscription')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await symlink(project, join(profile, 'node_modules/dsh-chatgpt-subscription'), 'junction')
  const patch = join(root, 'verify.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'llm-pi-ai', config: { providers: { openai: {}, 'openai-codex': {} } } },
    { id: 'chatgpt-subscription', config: { loginTimeoutMs: 30000, revocationTimeoutMs: 1000 } },
  ]))
  child = spawn(process.execPath, [cli, '--profile', 'web', '--patch',
    join(checkout, 'apps/web/tests/pin-browse-picker.overlay.yml'), '--patch', patch, '--no-open', '--port', '0'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const url = await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('DSH Web did not become ready.')), 60000)
    const check = () => {
      const match = output.match(/dsh web: (http:\/\/[^\s]+)/u)
      if (match) { clearTimeout(timeout); resolveReady(match[1]) }
    }
    child.stdout.on('data', check)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`DSH Web exited before readiness (${code}).`)) })
    check()
  })
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
  page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    if (typeof payload === 'string' && /"error"|"failure"/u.test(payload)) wireErrors.push(payload)
  }))
  await page.goto(url, { waitUntil: 'load' })
  // A fresh profile displays the normal first-run notices before Settings.
  const preview = page.getByRole('dialog', { name: '预览版说明' })
  await preview.waitFor({ timeout: 15000 })
  await preview.getByRole('button', { name: '继续', exact: true }).click()
  const later = page.getByRole('button', { name: '稍后配置', exact: true })
  if (await later.isVisible({ timeout: 3000 }).catch(() => false)) await later.click()
  await page.getByRole('button', { name: '账号菜单', exact: true }).click({ timeout: 15000 })
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: '模型', exact: true }).click()
  const official = settings.getByRole('region', { name: 'ChatGPT 订阅', exact: true })
  const legacy = settings.getByRole('region', { name: 'ChatGPT 订阅（旧版 Codex）', exact: true })
  await official.getByText('连接 ChatGPT 账号以使用此提供商', { exact: true }).waitFor({ timeout: 10000 })
  await official.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).waitFor()
  await legacy.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).waitFor()
  await snapshot('models-disconnected.aria.md', `${await official.ariaSnapshot()}\n${await legacy.ariaSnapshot()}`)
  await page.screenshot({ path: join(artifacts, 'models-light.png'), fullPage: false })
  await official.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).click()
  const authorize = official.getByRole('link', { name: '打开 ChatGPT 登录页面', exact: true })
  await authorize.waitFor({ timeout: 10000 })
  const authorizeUrl = new URL(await authorize.getAttribute('href'))
  assert.equal(authorizeUrl.origin, 'https://auth.openai.com')
  assert.equal(authorizeUrl.searchParams.get('agent_name_hint'), 'DeepSeek Harness')
  assert.match(authorizeUrl.searchParams.get('ext_agent_host_id'), /^urn:uuid:/u)
  assert.ok(authorizeUrl.searchParams.get('scope').includes('chatgpt.tokens.use.direct'))
  await official.getByRole('button', { name: '取消登录', exact: true }).click()
  await official.getByRole('button', { name: '使用 ChatGPT 登录', exact: true }).waitFor()
  // A synthetic grant exercises cross-process file updates and local-only legacy sign-out.
  const writer = new Context()
  try {
    await writer.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await writer.credentials.modifyRecord(recordKeyFor('openai-codex'), async () => ({
      kind: 'grant', payload: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 4_000_000_000_000 },
    }))
  } finally { await writer.fiber.dispose() }
  await legacy.getByRole('button', { name: '断开连接', exact: true }).waitFor({ timeout: 10000 })
  await snapshot('models-connected.aria.md', await legacy.ariaSnapshot())
  await page.screenshot({ path: join(artifacts, 'models-connected.png') })
  await legacy.getByRole('button', { name: '断开连接', exact: true }).click()
  await legacy.getByText('已在本地断开连接，请前往 ChatGPT 移除此连接以撤销授权', { exact: true }).waitFor()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('body[data-ds-dark-theme]').waitFor()
  await page.screenshot({ path: join(artifacts, 'models-dark.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await official.scrollIntoViewIfNeeded()
  const bounds = await official.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'The subscription card stays within the narrow viewport.')
  await page.screenshot({ path: join(artifacts, 'models-mobile.png') })
  await context.close()
  assert.deepEqual(pageErrors, [])
  console.log('PASS real DSH profile: both provider cards, OAuth URL, cancellation, cross-process status, logout, light/dark and narrow layout, and no browser errors.')
} catch (error) {
  await writeFile(join(artifacts, 'browser-failure.json'), JSON.stringify({ pageErrors, wireErrors }, null, 2))
  if (page && !page.isClosed()) await page.screenshot({ path: join(artifacts, 'web-failure.png') }).catch(() => {})
  // Startup logs can contain the scratch profile's bearer URL, so keep them local and redact it.
  await writeFile(join(artifacts, 'web-failure.log'), output.replace(/([?&](?:token|auth)=)[^\s&]+/gu, '$1<redacted>'))
  throw error
} finally {
  await browser?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'exit')
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 10000)
    await closed
    clearTimeout(force)
  }
  await rm(root, { recursive: true, force: true })
}
