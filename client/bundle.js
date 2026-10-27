window.__ModuleLoader__.load({
  id: 'dsh-settings-sync',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-settings-sync'

    async function call(path, method, body) {
      const init = { method: method || 'GET' }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch {
        throw new Error('Нет связи с хостом: проверьте, что плагин включён и DSH перезапущен')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error((payload && payload.error) || 'HTTP ' + response.status)
      }
      return payload.data
    }

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 940, padding: '4px 0 28px' },
      header: { display: 'flex', flexDirection: 'column', gap: 4 },
      title: { margin: 0, fontSize: 18, fontWeight: 600 },
      subtitle: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #666)' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      cardTitle: { fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 34,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        fontSize: 13,
      },
      row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
      checkRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 },
      button: {
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      primary: {
        height: 32,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid #2f6bff',
        background: '#2f6bff',
        color: '#ffffff',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      },
      danger: {
        height: 32,
        padding: '0 12px',
        borderRadius: 8,
        border: '1px solid rgba(220,38,38,.5)',
        background: 'rgba(220,38,38,.1)',
        color: '#dc2626',
        fontSize: 13,
        cursor: 'pointer',
      },
      pre: {
        margin: 0,
        padding: 12,
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 340,
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      error: {
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid rgba(220,38,38,.4)',
        background: 'rgba(220,38,38,.08)',
        color: '#dc2626',
        fontSize: 13,
        whiteSpace: 'pre-wrap',
      },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)', lineHeight: '18px' },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 20,
        padding: '0 8px',
        borderRadius: 999,
        fontSize: 11,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        color: 'var(--dsw-alias-label-secondary, #666)',
      },
      ok: { color: '#16a34a' },
      warn: { color: '#d97706' },
      bad: { color: '#dc2626' },
      list: { display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' },
      listItem: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: 8,
        alignItems: 'center',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.2))',
        fontSize: 13,
      },
      details: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #666)' },
      divider: { height: 1, background: 'var(--dsw-alias-border-secondary, rgba(128,128,128,.2))' },
    }

    function field(label, input, hint) {
      return h(
        'label',
        { style: S.field },
        h('span', { style: S.label }, label),
        input,
        hint ? h('span', { style: S.hint }, hint) : null,
      )
    }

    function fmtDate(value) {
      if (!value) return '—'
      try {
        return new Date(value).toLocaleString('ru-RU')
      } catch {
        return String(value)
      }
    }

    function statusSummary(status) {
      if (!status) return ['Загрузка…']
      const git = status.git || {}
      const diff = status.diff || { same: 0, modified: [], onlyLive: [], onlyRepo: [] }
      const lines = [
        'DSH_HOME: ' + status.dshHome,
        'Репозиторий: ' + (status.repoUrl || 'не настроен') + '  [' + (status.branch || 'main') + ']',
        'Локальная копия: ' + status.repoDir + (status.repoExists ? '' : ' (не инициализирована)'),
        'GitHub: ' + (status.github && status.github.login ? status.github.login : 'не подключён') +
          (status.tokenSource ? ' · токен: ' + status.tokenSource : ''),
        'DSH ' + (status.dshVersion || '?') + ' · Node ' + status.nodeVersion,
        'Файлов: ' + status.managed + ' · совпадает ' + diff.same +
          ' · изменено ' + diff.modified.length +
          ' · только локально ' + diff.onlyLive.length +
          ' · только в репозитории ' + diff.onlyRepo.length,
        'Локальные плагины: ' + (status.localPlugins && status.localPlugins.length
          ? status.localPlugins.map((p) => p.name).join(', ')
          : 'нет'),
        'Git: не закоммичено ' + (git.dirty || 0) +
          (git.ahead !== null && git.ahead !== undefined ? ' · впереди ' + git.ahead + ' / позади ' + git.behind : ''),
        'Последний захват: ' + fmtDate(status.lastCaptureAt) +
          (status.lastCaptureHost ? ' @ ' + status.lastCaptureHost : ''),
      ]
      if (status.lastOp) {
        lines.push('Последняя операция: ' + status.lastOp.kind + ' ' + (status.lastOp.ok ? 'ok' : 'ошибка: ' + status.lastOp.error))
      }
      return lines
    }

    function FileList(props) {
      const { title, files } = props
      if (!files || !files.length) return null
      return h(
        'details',
        { style: S.details },
        h('summary', null, title + ' (' + files.length + ')'),
        h('pre', { style: { ...S.pre, marginTop: 8 } }, files.join('\n')),
      )
    }

    function StatusCard(props) {
      const { status } = props
      return h(
        'section',
        { style: S.card },
        h('div', { style: S.cardTitle }, 'Состояние'),
        status && status.git && status.git.diverged
          ? h('div', { style: { ...S.error, color: '#d97706', borderColor: 'rgba(217,119,6,.4)', background: 'rgba(217,119,6,.08)' } },
              'Локальные и удалённые изменения разошлись. Разрешите расхождение в блоке «Расхождение» ниже.')
          : null,
        h('pre', { style: S.pre }, statusSummary(status).join('\n')),
        status
          ? h(
              'div',
              { style: S.row },
              h(FileList, { title: 'Изменены локально', files: status.diff.modified }),
              h(FileList, { title: 'Только локально', files: status.diff.onlyLive }),
              h(FileList, { title: 'Только в репозитории', files: status.diff.onlyRepo }),
              h(FileList, { title: 'Бэкапы', files: status.backups }),
            )
          : null,
      )
    }

    function SettingsSyncSection() {
      const [status, setStatus] = React.useState(null)
      const [settings, setSettings] = React.useState(null)
      const [account, setAccount] = React.useState(null)
      const [repos, setRepos] = React.useState([])
      const [history, setHistory] = React.useState(null)
      const [scan, setScan] = React.useState(null)
      const [form, setForm] = React.useState({
        repoUrl: '',
        branch: 'main',
        token: '',
        autoOnStart: false,
        autoOnChange: false,
        autoPush: false,
        intervalMinutes: 10,
        categories: { settings: true, plugins: true, skills: true, instructions: true },
      })
      const [hasToken, setHasToken] = React.useState(false)
      const [repoName, setRepoName] = React.useState('')
      const [repoQuery, setRepoQuery] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [output, setOutput] = React.useState('')
      const [restartNeeded, setRestartNeeded] = React.useState(false)
      const [confirm, setConfirm] = React.useState('')

      const refresh = React.useCallback(async () => {
        const [nextStatus, nextSettings] = await Promise.all([call('/status'), call('/settings')])
        setStatus(nextStatus)
        setSettings(nextSettings)
        setHasToken(Boolean(nextSettings.hasToken))
        setForm((current) => ({
          ...current,
          repoUrl: nextSettings.repoUrl || '',
          branch: nextSettings.branch || 'main',
          autoOnStart: Boolean(nextSettings.autoOnStart),
          autoOnChange: Boolean(nextSettings.autoOnChange),
          autoPush: Boolean(nextSettings.autoPush),
          intervalMinutes: nextSettings.intervalMinutes || 10,
          categories: { ...current.categories, ...(nextSettings.categories || {}) },
        }))
        try {
          setAccount(await call('/github/account'))
        } catch {
          setAccount(null)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        refresh().catch((e) => {
          if (alive) setError(String((e && e.message) || e))
        })
        return () => {
          alive = false
        }
      }, [refresh])

      const run = async (label, action, onData) => {
        setBusy(label)
        setError('')
        try {
          const data = await action()
          if (onData) onData(data)
          setOutput(label + '\n' + formatResult(data))
          await refresh()
          return data
        } catch (e) {
          setError(String((e && e.message) || e))
          return null
        } finally {
          setBusy('')
          setConfirm('')
        }
      }

      const update = (key, value) => setForm((current) => ({ ...current, [key]: value }))
      const updateCategory = (key, value) =>
        setForm((current) => ({ ...current, categories: { ...current.categories, [key]: value } }))

      const save = async (extra) => {
        const payload = {
          repoUrl: form.repoUrl,
          branch: form.branch,
          autoOnStart: Boolean(form.autoOnStart),
          autoOnChange: Boolean(form.autoOnChange),
          autoPush: Boolean(form.autoPush),
          intervalMinutes: Number(form.intervalMinutes) || 10,
          categories: form.categories,
          ...(extra || {}),
        }
        if (form.token) payload.token = form.token
        return run('Сохранено', async () => {
          const data = await call('/settings', 'PUT', payload)
          setForm((current) => ({ ...current, token: '' }))
          return data
        })
      }

      const connectToken = async () => {
        if (!form.token.trim()) {
          setError('Вставьте GitHub PAT (scope repo)')
          return
        }
        await run('GitHub подключён', async () => {
          await call('/settings', 'PUT', { token: form.token.trim() })
          setForm((current) => ({ ...current, token: '' }))
          return await call('/github/account')
        })
      }

      const createRepo = async () => {
        const name = repoName.trim()
        if (!name) {
          setError('Укажите имя репозитория')
          return
        }
        await run('Репозиторий создан', async () => {
          const repo = await call('/github/create', 'POST', { name })
          await call('/settings', 'PUT', { repoUrl: repo.repoUrl, branch: repo.defaultBranch || 'main' })
          setRepoName('')
          await call('/init', 'POST', {})
          return repo
        })
      }

      const loadRepos = async () => {
        await run('Список репозиториев', async () => {
          const data = await call('/github/repos?q=' + encodeURIComponent(repoQuery))
          setRepos(data.repos || [])
          return { repos: data.repos }
        })
      }

      const chooseRepo = async (repo) => {
        await run('Репозиторий выбран', async () => {
          await call('/settings', 'PUT', { repoUrl: 'https://github.com/' + repo.fullName + '.git', branch: repo.defaultBranch || 'main' })
          await call('/init', 'POST', {})
          return repo
        })
      }

      const resolve = async (strategy) => {
        await run(strategy === 'remote' ? 'Взято удалённое' : 'Отправлено локальное', async () => {
          const data = await call('/resolve', 'POST', { strategy })
          if (strategy === 'remote') setRestartNeeded(true)
          return data
        })
      }

      const disabled = busy !== ''
      const categories = [
        ['settings', 'Настройки и MCP (cordis.patch.yml, settings.yaml)'],
        ['plugins', 'Плагины (package.json, lock, локальные исходники)'],
        ['skills', 'Навыки (skills/)'],
        ['instructions', 'Инструкции (AGENTS.md)'],
      ]

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.header },
          h('h2', { style: S.title }, 'Синхронизация настроек'),
          h(
            'p',
            { style: S.subtitle },
            'Настройки профиля, MCP-серверы, установленные плагины (включая локальные) и навыки — в приватном GitHub-репозитории. ' +
              'Другая машина: подключить GitHub → «Получить» → «Применить» → перезапустить DSH. Сессии, storages и .credentials.yaml не синхронизируются.',
          ),
        ),
        error ? h('div', { style: S.error }, error) : null,
        restartNeeded
          ? h('div', { style: { ...S.error, color: '#d97706', borderColor: 'rgba(217,119,6,.4)', background: 'rgba(217,119,6,.08)' } },
              'Настройки записаны. Перезапустите DSH, чтобы изменения вступили в силу.')
          : null,

        h(
          'section',
          { style: S.card },
          h('div', { style: S.cardTitle }, 'GitHub',
            h('span', { style: S.badge }, account && account.connected ? account.login : 'не подключён')),
          account && account.connected
            ? h('div', { style: S.hint },
                'Аккаунт: ' + account.login + (account.name ? ' (' + account.name + ')' : '') +
                  ' · токен: ' + (account.source === 'gh' ? 'из gh CLI' : 'сохранён в плагине'))
            : h('div', { style: S.hint },
                'Можно войти через уже авторизованный gh CLI (если установлен) или вставить PAT со scope repo. ' +
                  'Токен хранится только локально, в репозиторий не попадает.'),
          h(
            'div',
            { style: S.grid },
            field(
              hasToken ? 'Новый PAT (оставьте пустым, чтобы не менять)' : 'GitHub PAT (scope repo)',
              h('input', {
                style: S.input,
                type: 'password',
                autoComplete: 'off',
                value: form.token,
                placeholder: hasToken ? 'токен уже сохранён' : 'ghp_… или github_pat_…',
                onChange: (e) => update('token', e.target.value),
              }),
            ),
            field(
              'Создать приватный репозиторий',
              h(
                'div',
                { style: S.row },
                h('input', {
                  style: { ...S.input, flex: 1, minWidth: 140 },
                  value: repoName,
                  placeholder: 'dsh-settings',
                  spellCheck: false,
                  onChange: (e) => setRepoName(e.target.value),
                }),
                h('button', { style: S.button, disabled, onClick: createRepo }, 'Создать'),
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('button', { style: S.primary, disabled, onClick: connectToken }, 'Подключить / проверить токен'),
            h('button', { style: S.button, disabled, onClick: loadRepos }, 'Мои репозитории'),
            h('input', {
              style: { ...S.input, flex: 1, minWidth: 160 },
              value: repoQuery,
              placeholder: 'поиск по имени',
              onChange: (e) => setRepoQuery(e.target.value),
            }),
          ),
          repos.length
            ? h(
                'ul',
                { style: S.list },
                repos.map((repo) =>
                  h(
                    'li',
                    { key: repo.fullName, style: S.listItem },
                    h('span', null, repo.fullName + (repo.private ? ' · приватный' : ' · ПУБЛИЧНЫЙ')),
                    h('button', { style: S.button, disabled, onClick: () => chooseRepo(repo) }, 'Выбрать'),
                  ),
                ),
              )
            : null,
          h('div', { style: S.hint },
            'Для синхронизации токенов MCP репозиторий должен быть приватным: публичный push блокируется проверкой GitHub API.'),
        ),

        h(
          'section',
          { style: S.card },
          h('div', { style: S.cardTitle }, 'Репозиторий и состав'),
          h(
            'div',
            { style: S.grid },
            field(
              'URL репозитория',
              h('input', {
                style: S.input,
                value: form.repoUrl,
                placeholder: 'https://github.com/user/dsh-settings.git',
                spellCheck: false,
                onChange: (e) => update('repoUrl', e.target.value),
              }),
            ),
            field(
              'Ветка',
              h('input', {
                style: S.input,
                value: form.branch,
                placeholder: 'main',
                spellCheck: false,
                onChange: (e) => update('branch', e.target.value),
              }),
            ),
          ),
          h('div', { style: S.label }, 'Что синхронизировать'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            categories.map(([key, label]) =>
              h(
                'label',
                { key, style: S.checkRow },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(form.categories[key]),
                  onChange: (e) => updateCategory(key, e.target.checked),
                }),
                label,
              ),
            ),
          ),
          h(
            'div',
            { style: S.row },
            h('button', { style: S.primary, disabled, onClick: () => save() }, busy === 'Сохранено' ? 'Сохраняем…' : 'Сохранить настройки'),
            h('button', { style: S.button, disabled, onClick: () => run('Инициализация', () => call('/init', 'POST', {})) }, 'Инициализировать локальную копию'),
          ),
        ),

        h(
          'section',
          { style: S.card },
          h('div', { style: S.cardTitle }, 'Автоматизация'),
          h(
            'div',
            { style: S.row },
            h(
              'label',
              { style: S.checkRow },
              h('input', {
                type: 'checkbox',
                checked: Boolean(form.autoOnStart),
                onChange: (e) => update('autoOnStart', e.target.checked),
              }),
              'При старте DSH забирать и применять удалённое',
            ),
            h(
              'label',
              { style: S.checkRow },
              h('input', {
                type: 'checkbox',
                checked: Boolean(form.autoOnChange),
                onChange: (e) => update('autoOnChange', e.target.checked),
              }),
              'Захватывать изменения каждые',
            ),
            h('input', {
              style: { ...S.input, width: 72, height: 28, padding: '0 8px' },
              type: 'number',
              min: 2,
              max: 1440,
              value: form.intervalMinutes,
              onChange: (e) => update('intervalMinutes', e.target.value),
            }),
            'мин',
            h(
              'label',
              { style: S.checkRow },
              h('input', {
                type: 'checkbox',
                checked: Boolean(form.autoPush),
                onChange: (e) => update('autoPush', e.target.checked),
              }),
              'сразу отправлять',
            ),
          ),
          h('div', { style: S.hint },
            'Авто-захват коммитит только при изменениях. Держите автоматическую отправку включённой на одной «главной» машине, чтобы не плодить конфликты.'),
        ),

        h(
          'section',
          { style: S.card },
          h('div', { style: S.cardTitle }, 'Действия'),
          h(
            'div',
            { style: S.row },
            h('button', { style: S.primary, disabled, onClick: () => run('Синхронизировано', () => call('/sync', 'POST', {})) }, 'Синхронизировать'),
            h('button', { style: S.button, disabled, onClick: () => run('Захвачено и отправлено', () => call('/capture', 'POST', { push: true })) }, 'Захватить и отправить'),
            h('button', { style: S.button, disabled, onClick: () => run('Получено', () => call('/pull', 'POST', {})) }, 'Получить'),
          ),
          h(
            'div',
            { style: S.row },
            h('button', {
              style: S.button,
              disabled,
              onClick: async () => {
                const data = await run('Применено', () => call('/apply', 'POST', { install: true }))
                if (data) setRestartNeeded(true)
              },
            }, 'Применить и установить плагины'),
            h('button', { style: S.button, disabled, onClick: () => run('История', () => call('/history'), setHistory) }, 'История'),
            h('button', { style: S.button, disabled, onClick: () => run('Сканирование', () => call('/scan', 'POST', {}), setScan) }, 'Проверить секреты'),
            confirm === 'restore'
              ? h('button', { style: S.danger, disabled, onClick: () => run('Бэкап восстановлен', () => call('/restore', 'POST', {})) }, 'Точно откатить')
              : h('button', { style: S.button, disabled, onClick: () => setConfirm('restore') }, 'Откатить последний бэкап'),
          ),
          h('div', { style: S.hint },
            '«Применить» сначала делает бэкап, затем перезаписывает файлы профиля и ставит зависимости. После применения нужен перезапуск DSH.'),
        ),

        status && status.git && status.git.diverged
          ? h(
              'section',
              { style: S.card },
              h('div', { style: S.cardTitle }, 'Расхождение'),
              h('div', { style: S.hint },
                'Локальная копия и удалённый репозиторий содержат разные коммиты. Выберите сторону: удалённая перезапишет локальную копию репозитория (живые файлы не тронутся до «Применить»), локальная — отправится принудительно.'),
              h(
                'div',
                { style: S.row },
                confirm === 'remote'
                  ? h('button', { style: S.danger, disabled, onClick: () => resolve('remote') }, 'Взять удалённое (подтвердить)')
                  : h('button', { style: S.button, disabled, onClick: () => setConfirm('remote') }, 'Взять удалённое'),
                confirm === 'local'
                  ? h('button', { style: S.danger, disabled, onClick: () => resolve('local') }, 'Отправить локальное (подтвердить)')
                  : h('button', { style: S.button, disabled, onClick: () => setConfirm('local') }, 'Отправить локальное'),
              ),
            )
          : null,

        output ? h('pre', { style: S.pre }, output) : null,
        scan
          ? h(
              'section',
              { style: S.card },
              h('div', { style: S.cardTitle }, 'Секреты в снапшоте'),
              scan.hits && scan.hits.length
                ? h('pre', { style: S.pre }, scan.hits.map((x) => '[' + x.pattern + '] ' + x.file + ':' + x.line + '  ' + x.text).join('\n'))
                : h('div', { style: S.hint }, 'Подозрительных секретов не найдено'),
            )
          : null,
        history
          ? h(
              'section',
              { style: S.card },
              h('div', { style: S.cardTitle }, 'История коммитов'),
              history.commits && history.commits.length
                ? h(
                    'ul',
                    { style: S.list },
                    history.commits.map((c) =>
                      h(
                        'li',
                        { key: c.sha, style: S.listItem },
                        h('span', null, c.sha.slice(0, 10) + ' · ' + fmtDate(c.date) + ' · ' + c.subject),
                        h(
                          'button',
                          {
                            style: S.button,
                            disabled,
                            onClick: () =>
                              run('Коммит выбран', async () => {
                                const data = await call('/restore-commit', 'POST', { sha: c.sha })
                                setRestartNeeded(true)
                                return data
                              }),
                          },
                          'Восстановить',
                        ),
                      ),
                    ),
                  )
                : h('div', { style: S.hint }, 'История пуста'),
            )
          : null,
        h(StatusCard, { status }),
      )
    }

    function formatResult(data) {
      if (!data) return ''
      if (data.pulled && data.applied && data.captured) {
        return 'Применено файлов: ' + data.applied.applied +
          '\nЛокальные плагины: ' + ((data.applied.localPlugins && data.applied.localPlugins.join(', ')) || 'нет') +
          '\nЗависимости: ' + (data.applied.installOutput || '—') +
          '\nКоммит: ' + (data.captured.commit || 'нет') + ' · push=' + data.captured.pushed
      }
      if (data.applied !== undefined) {
        return 'Записано файлов: ' + data.applied +
          '\nБэкап: ' + (data.backupDir || '—') +
          '\nЛокальные плагины: ' + ((data.localPlugins && data.localPlugins.join(', ')) || 'нет') +
          '\nВосстановлено путей: ' + ((data.restored && data.restored.length) || 0) +
          '\nЗависимости: ' + (data.installOutput || '—') +
          '\nНужен перезапуск DSH.'
      }
      if (data.files !== undefined && data.commit !== undefined) {
        return 'Файлов: ' + data.files + ' · плагинов: ' + (data.localPlugins || 0) +
          '\nДобавлено: ' + (data.added ? data.added.length : 0) +
          ' · изменено: ' + (data.changed ? data.changed.length : 0) +
          ' · устарело: ' + (data.stale ? data.stale.length : 0) +
          '\nКоммит: ' + (data.commit || 'нет') + ' · push=' + data.pushed +
          (data.pushOutput ? '\n' + data.pushOutput : '')
      }
      if (data.commits) {
        return data.commits.length ? data.commits.slice(0, 15).map((c) => c.sha.slice(0, 10) + '  ' + c.subject).join('\n') : 'История пуста'
      }
      if (data.hits) {
        return data.hits.length
          ? data.hits.slice(0, 40).map((x) => '[' + x.pattern + '] ' + x.file + ':' + x.line + '  ' + x.text).join('\n')
          : 'Подозрительных секретов не найдено'
      }
      if (data.restored !== undefined) {
        return 'Восстановлено файлов: ' + (data.restored || 0) + (data.output ? '\n' + data.output : '')
      }
      if (data.repos) return 'Репозиториев: ' + data.repos.length
      if (data.output) return data.output
      try {
        return JSON.stringify(data, null, 2)
      } catch {
        return String(data)
      }
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => {
        try {
          const unregister = ctx.slots.register(
            {
              name: 'settings.section',
              id: 'sync',
              order: 40,
              label: () => 'Синхронизация',
              inject: () => ({}),
            },
            SettingsSyncSection,
          )
          return () => {
            unregister()
          }
        } catch {
          return () => {}
        }
      })
    }

    return {
      apply,
      inject: ['slots'],
      SettingsSyncSection,
    }
  },
})
