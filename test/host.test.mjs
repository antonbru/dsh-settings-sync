/**
 * dsh-settings-sync — офлайн-интеграционные тесты.
 *
 * Проверяют: состав синхронизации, capture/push/pull/apply, шаблоны путей,
 * перенос локального плагина, бэкап/восстановление, расхождение веток,
 * скан секретов, GitHub-клиент на моке fetch и HTTP-маршруты.
 *
 * Запуск: node --test test/
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-settings-sync-test-'))
const homeA = path.join(root, 'home-a')
const homeB = path.join(root, 'home-b')
const remote = path.join(root, 'remote.git')
const pluginSrc = path.join(root, 'plugin-src')

process.env.DSH_HOME = homeA
process.env.GIT_TERMINAL_PROMPT = '0'

const mod = await import('../lib/index.js')
const i = mod.__internals

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function seed(home, marker) {
  const profile = path.join(home, 'profiles', 'desktop')
  await fsp.mkdir(profile, { recursive: true })
  await fsp.writeFile(
    path.join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-desktop',
        private: true,
        dependencies: {
          'dsh-local-plugin': 'link:' + pluginSrc,
          '@deepseek-ai/dsh-base': '0.2.1-rc.3',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      },
      null,
      2,
    ),
  )
  await fsp.writeFile(
    path.join(profile, 'cordis.patch.yml'),
    [
      '# marker ' + marker,
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      "    cwd: '" + home + "/work'",
      "    token: 'ghp_abcdefghijklmnopqrstuvwxyz012345'",
      '    headers:',
      "      Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345'",
      '',
    ].join('\n'),
  )
  await fsp.writeFile(path.join(profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await fsp.writeFile(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  await fsp.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  await fsp.writeFile(path.join(profile, 'node_modules-marker'), 'ignore me\n')
  await fsp.writeFile(path.join(home, 'AGENTS.md'), '# rules ' + marker + '\n')
  await fsp.writeFile(path.join(home, 'settings.yaml'), 'ui-theme:\n  density: compact\n')
  await fsp.mkdir(path.join(home, 'skills', 'feed'), { recursive: true })
  await fsp.writeFile(path.join(home, 'skills', 'feed', 'SKILL.md'), '# Feed\nversion ' + marker + '\n')
  await fsp.mkdir(path.join(home, 'sessions'), { recursive: true })
  await fsp.writeFile(path.join(home, 'sessions', 'session.v4.jsonl.zstd'), 'not-for-sync')
  await fsp.writeFile(path.join(home, '.credentials.yaml'), 'token: never-sync\n')
  await fsp.mkdir(path.join(home, 'dsh-runtimes', 'dsh-primary-runtime'), { recursive: true })
  await fsp.writeFile(
    path.join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'),
    JSON.stringify({ desktopVersion: '0.2.1-rc.3', node: '24.21.0', pnpm: '11.28.5' }),
  )
}

async function seedPluginSource() {
  await fsp.mkdir(pluginSrc, { recursive: true })
  await fsp.writeFile(path.join(pluginSrc, 'package.json'), JSON.stringify({ name: 'dsh-local-plugin', version: '0.0.1' }))
  await fsp.writeFile(path.join(pluginSrc, 'index.js'), 'export const name = "local"\n')
  await fsp.mkdir(path.join(pluginSrc, 'node_modules', 'junk'), { recursive: true })
  await fsp.writeFile(path.join(pluginSrc, 'node_modules', 'junk', 'x.js'), 'never')
}

test('host flow: capture, push, pull, apply, restore, scan, github mock, routes', async (t) => {
  await seedPluginSource()
  await seed(homeA, 'a1')
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' })

  await t.test('templates and helpers', () => {
    assert.equal(i.encodePaths(homeA + '/work'), '${DSH_HOME}/work')
    assert.equal(i.decodePaths('${DSH_HOME}/work'), homeA + '/work')
    assert.deepEqual(i.parseRepoUrl('https://github.com/a/b.git'), { host: 'github.com', owner: 'a', repo: 'b' })
    assert.equal(i.parseRepoUrl('git@github.com:a/b.git').owner, 'a')
    assert.equal(i.parseRepoUrl('https://example.com/a/b'), null)
  })

  await t.test('init + status before capture', async () => {
    await i.saveSettings({ repoUrl: remote, branch: 'main' })
    await i.initRun()
    assert.ok(fs.existsSync(path.join(homeA, 'settings-sync', 'repo', '.git')))

    const status = await i.statusRun()
    assert.equal(status.repoExists, true)
    assert.equal(status.managed, 9)
    assert.equal(status.diff.onlyLive.length, 9)
    assert.equal(status.diff.onlyRepo.length, 0)
    assert.equal(status.localPlugins.length, 1)
    assert.equal(status.dshVersion, '0.2.1-rc.3')
    assert.equal(status.hasToken, false)
  })

  await t.test('capture writes managed files only, with templates', async () => {
    const result = await i.captureRun({})
    assert.equal(result.files, 9)
    assert.equal(result.localPlugins, 1)
    assert.equal(result.added.length, 7)
    assert.equal(result.committed, true)

    const repoHome = path.join(homeA, 'settings-sync', 'repo', 'home')
    const patch = await fsp.readFile(path.join(repoHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.includes('${DSH_HOME}/work'))
    assert.ok(!patch.includes(homeA + '/work'))
    assert.ok(fs.existsSync(path.join(repoHome, 'skills', 'feed', 'SKILL.md')))
    assert.ok(fs.existsSync(path.join(repoHome, 'AGENTS.md')))
    assert.ok(fs.existsSync(path.join(repoHome, 'settings.yaml')))
    assert.ok(!fs.existsSync(path.join(repoHome, '.credentials.yaml')))
    assert.ok(!fs.existsSync(path.join(repoHome, 'sessions')))
    assert.ok(!fs.existsSync(path.join(repoHome, 'profiles', 'desktop', 'cordis.yml')))
    assert.ok(!fs.existsSync(path.join(repoHome, 'profiles', 'desktop', 'node_modules-marker')))

    const repoPlugins = path.join(homeA, 'settings-sync', 'repo', 'plugins', 'dsh-local-plugin')
    assert.ok(fs.existsSync(path.join(repoPlugins, 'index.js')))
    assert.ok(!fs.existsSync(path.join(repoPlugins, 'node_modules')))

    const cfg = JSON.parse(await fsp.readFile(path.join(homeA, 'settings-sync', 'repo', 'dshcfg.json'), 'utf8'))
    assert.equal(cfg.localPlugins.length, 1)
    assert.equal(cfg.localPlugins[0].name, 'dsh-local-plugin')
  })

  await t.test('capture is idempotent and pushes', async () => {
    const second = await i.captureRun({ push: true })
    assert.equal(second.committed, false)
    assert.equal(second.pushed, true)
    assert.match(git(['--git-dir', remote, 'rev-parse', 'main']), /^[0-9a-f]{40}$/)
  })

  await t.test('pull + apply on a second machine restores config and local plugin', async () => {
    process.env.DSH_HOME = homeB
    await seed(homeB, 'b1')
    await i.saveSettings({ repoUrl: remote, branch: 'main' })

    const pulled = await i.pullRun()
    assert.equal(pulled.updated, true)

    // имитируем отсутствие исходников плагина на новой машине
    await fsp.rm(pluginSrc, { recursive: true, force: true })

    const applied = await i.applyRun({ install: false })
    assert.equal(applied.applied, 7)
    assert.deepEqual(applied.localPlugins, ['dsh-local-plugin'])
    assert.equal(applied.restored.length, 1)
    assert.ok(fs.existsSync(path.join(pluginSrc, 'index.js')))
    assert.ok(fs.existsSync(path.join(pluginSrc, 'package.json')))

    const patchB = await fsp.readFile(path.join(homeB, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    assert.ok(patchB.includes(homeB + '/work'))
    assert.ok(!patchB.includes('${DSH_HOME}'))
    assert.equal(await fsp.readFile(path.join(homeB, 'AGENTS.md'), 'utf8'), '# rules a1\n')
    assert.ok(fs.existsSync(path.join(homeB, 'settings.yaml')))
    assert.equal(await fsp.readFile(path.join(homeB, '.credentials.yaml'), 'utf8'), 'token: never-sync\n')
    assert.ok(!fs.existsSync(path.join(homeB, 'settings-sync', 'repo', 'home', '.credentials.yaml')))

    const status = await i.statusRun()
    assert.deepEqual(status.diff.modified, [])
    assert.deepEqual(status.diff.onlyLive, [])
    assert.deepEqual(status.diff.onlyRepo, [])
    assert.equal(status.managed, 9)
  })

  await t.test('restore returns the backup taken before apply', async () => {
    await fsp.writeFile(path.join(homeB, 'AGENTS.md'), '# broken edit\n')
    const restored = await i.restoreRun({})
    assert.ok(restored.restored > 0)
    assert.equal(await fsp.readFile(path.join(homeB, 'AGENTS.md'), 'utf8'), '# rules b1\n')
  })

  await t.test('diverged branches are reported, remote can be taken', async () => {
    await fsp.writeFile(path.join(homeB, 'AGENTS.md'), '# rules b2\n')
    await i.captureRun({})
    process.env.DSH_HOME = homeA
    await fsp.writeFile(path.join(homeA, 'AGENTS.md'), '# rules a2\n')
    await i.captureRun({ push: true })
    process.env.DSH_HOME = homeB
    await assert.rejects(i.pullRun(), (error) => error.code === 'diverged')
    const resolved = await i.resolveRun({ strategy: 'remote' })
    assert.equal(resolved.strategy, 'remote')
    const status = await i.statusRun()
    assert.equal(status.git.diverged, false)
  })

  await t.test('scan reports secrets in the snapshot', async () => {
    const scan = await i.scanRun()
    assert.ok(scan.hits.length >= 2)
    assert.ok(scan.hits.some((hit) => hit.pattern === 'Bearer'))
  })

  await t.test('github client works against a mocked fetch', async () => {
    await i.saveSettings({ repoUrl: 'https://github.com/tester/repo.git', token: 'ghp_test_token' })
    const realFetch = global.fetch
    const calls = []
    global.fetch = async (url, init) => {
      calls.push(String(url))
      const method = (init && init.method) || 'GET'
      const payload = method === 'POST'
        ? { full_name: 'tester/repo', private: true, clone_url: 'https://github.com/tester/repo.git', default_branch: 'main' }
        : String(url).endsWith('/user')
          ? { login: 'tester', name: 'Test' }
          : String(url).includes('/user/repos')
            ? [{ full_name: 'tester/repo', name: 'repo', private: true, default_branch: 'main', updated_at: '2026-10-27T00:00:00Z' }]
            : { full_name: 'tester/repo', private: false, clone_url: 'https://github.com/tester/repo.git', default_branch: 'main' }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const account = await i.githubAccountRun()
      assert.equal(account.login, 'tester')
      const repos = await i.githubReposRun('')
      assert.equal(repos.length, 1)
      assert.equal(repos[0].fullName, 'tester/repo')
      const created = await i.githubCreateRun({ name: 'dsh-settings' })
      assert.equal(created.repoUrl, 'https://github.com/tester/repo.git')
      await assert.rejects(i.captureRun({ push: true }), /публичный/i)
      assert.ok(calls.some((url) => url.includes('/repos/tester/repo')))
    } finally {
      global.fetch = realFetch
    }
  })

  await t.test('http routes answer on loopback', async () => {
    const routes = i.buildRoutes()
    const server = http.createServer((req, res) => {
      const route = routes.find((entry) => entry.path === req.url.split('?')[0])
      if (!route) {
        res.writeHead(404)
        res.end()
        return
      }
      route.handler(req, res)
    })
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const address = server.address()
    try {
      const response = await fetch('http://127.0.0.1:' + address.port + '/api/dsh-settings-sync/status')
      const payload = await response.json()
      assert.equal(response.status, 200)
      assert.equal(payload.ok, true)
      assert.ok(payload.data.dshHome)
    } finally {
      await new Promise((resolvePromise) => server.close(resolvePromise))
    }
  })

  await t.test('client bundle registers the settings section', async () => {
    let captured = null
    global.window = { __ModuleLoader__: { load: (entry) => { captured = entry } } }
    await import('../client/bundle.js')
    assert.equal(captured.id, 'dsh-settings-sync')
    const React = {
      createElement: (...args) => ({ args }),
      useState: (value) => [value, () => {}],
      useCallback: (fn) => fn,
      useEffect: () => {},
    }
    const mod = captured.factory(() => React)
    const registered = []
    const ctx = {
      slots: {
        inject: (_name, callback) => callback(),
        register: (options, component) => {
          registered.push({ options, component })
          return () => {}
        },
      },
    }
    mod.apply(ctx)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].options.name, 'settings.section')
    assert.equal(registered[0].options.id, 'sync')
    assert.equal(typeof registered[0].component, 'function')
  })
})
