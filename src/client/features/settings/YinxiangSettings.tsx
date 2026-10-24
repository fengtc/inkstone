import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, NotebookPen, Pause, Play, RefreshCw, Unplug } from 'lucide-react'
import type { Folder, YinxiangConnectionInfo } from '@shared/types'
import { api } from '../../lib/api'
import { Button } from '../../components/primitives'
import { Checkbox, Input, Select, SettingRow } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'

export function YinxiangSettings() {
  const toast = useUi((state) => state.toast)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [canConfigure, setCanConfigure] = useState(false)
  const [consumerKeyHint, setConsumerKeyHint] = useState('')
  const [consumerKey, setConsumerKey] = useState('')
  const [consumerSecret, setConsumerSecret] = useState('')
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('production')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [connection, setConnection] = useState<YinxiangConnectionInfo | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [includeAttachments, setIncludeAttachments] = useState(true)
  const [frequency, setFrequency] = useState<'manual' | 'hourly' | 'daily'>('hourly')
  const [rootFolderId, setRootFolderId] = useState<string | null>(null)

  const load = async () => {
    try {
      const result = await api.yinxiang.status()
      setConfigured(result.configured)
      setCanConfigure(result.canConfigure)
      setConnection(result.connection)
      if (result.admin) {
        setConsumerKeyHint(result.admin.consumerKeyHint)
        setEnvironment(result.admin.environment)
        setCallbackUrl(result.admin.callbackUrl ?? `${window.location.origin}/oauth/yinxiang/callback`)
      }
      if (result.connection) {
        setSelected(result.connection.selectedNotebookGuids)
        setIncludeAttachments(result.connection.includeAttachments)
        setFrequency(result.connection.frequency)
        setRootFolderId(result.connection.rootFolderId)
      }
      const folderResult = await api.folders.list()
      setFolders(folderResult.folders)
    } catch (error) {
      toast({ title: t('settings.yinxiang_load_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }
  useEffect(() => { void load() }, [])

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    try { await action() } catch (error) { toast({ title: t('common.action_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' }) } finally { setBusy(null) }
  }
  const save = () => run('save', async () => { const result = await api.yinxiang.saveSettings({ selectedNotebookGuids: selected, rootFolderId, includeAttachments, frequency }); setConnection(result.connection); toast({ title: t('settings.yinxiang_settings_saved'), tone: 'success' }) })
  const saveAdmin = () => run('admin', async () => { const result = await api.yinxiang.saveAdmin({ consumerKey, consumerSecret: consumerSecret || undefined, environment, callbackUrl }); setConfigured(result.configured); setConsumerKey(''); setConsumerSecret(''); setConsumerKeyHint(result.admin?.consumerKeyHint ?? ''); toast({ title: t('settings.yinxiang_admin_saved'), tone: 'success' }) })
  const connect = () => run('connect', async () => { const result = await api.yinxiang.connect(); if (result.authorizationUrl) window.location.assign(result.authorizationUrl); else toast({ title: t('settings.yinxiang_not_configured'), tone: 'warning' }) })
  const sync = () => run('sync', async () => { await api.yinxiang.sync(); toast({ title: t('settings.yinxiang_sync_queued'), tone: 'success' }); await load() })
  const disconnect = () => run('disconnect', async () => { if (!await confirm({ title: t('settings.yinxiang_disconnect_confirm'), tone: 'danger' })) return; await api.yinxiang.disconnect(); setConnection(null); toast({ title: t('settings.yinxiang_disconnected'), tone: 'success' }) })
  const statusLabel = connection ? t(`settings.yinxiang_status_${connection.status}` as Parameters<typeof t>[0]) : configured === false ? t('settings.yinxiang_status_not_configured') : t('settings.yinxiang_status_not_connected')
  const notebookCount = connection?.notebooks.length ?? 0
  const selectedCount = selected.length
  const scope = useMemo(() => connection?.authorizedScopes.join(', ') ?? '', [connection])

  return <div className="space-y-6">
    {canConfigure && <section>
      <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('settings.yinxiang_admin_section')}</h3>
      <div className="space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <p className="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{t('settings.yinxiang_admin_description')}</p>
        <SettingRow title={t('settings.yinxiang_consumer_key')} description={consumerKeyHint ? t('settings.yinxiang_current_value', { value0: consumerKeyHint }) : undefined}>
          <Input value={consumerKey} onChange={(event) => setConsumerKey(event.target.value)} placeholder={consumerKeyHint || t('settings.yinxiang_consumer_key_placeholder')} autoComplete="off" className="min-w-[230px]" />
        </SettingRow>
        <SettingRow title={t('settings.yinxiang_consumer_secret')} description={t('settings.yinxiang_secret_not_displayed')}>
          <Input type="password" value={consumerSecret} onChange={(event) => setConsumerSecret(event.target.value)} placeholder={t('settings.yinxiang_secret_placeholder')} autoComplete="new-password" className="min-w-[230px]" />
        </SettingRow>
        <SettingRow title={t('settings.yinxiang_environment')}>
          <Select value={environment} onChange={(event) => setEnvironment(event.target.value as typeof environment)} className="min-w-[150px]"><option value="production">{t('settings.yinxiang_environment_production')}</option><option value="sandbox">{t('settings.yinxiang_environment_sandbox')}</option></Select>
        </SettingRow>
        <SettingRow title={t('settings.yinxiang_callback_url')} description={t('settings.yinxiang_callback_url_description')}>
          <Input value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="https://notes.example.com/oauth/yinxiang/callback" autoComplete="url" className="min-w-[280px]" />
        </SettingRow>
        <div className="pt-1"><Button size="sm" loading={busy === 'admin'} onClick={() => void saveAdmin()}>{t('settings.yinxiang_save_admin')}</Button></div>
      </div>
    </section>}
    <section className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
      <div className="flex items-start gap-3">
        <NotebookPen size={18} className="mt-0.5 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('settings.yinxiang_title')}</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{t('settings.yinxiang_description')}</p>
          <div className="mt-2 text-[12px] text-[var(--text-secondary)]">{statusLabel}</div>
          {connection?.accountId && <div className="mt-1 text-[11.5px] text-[var(--text-quaternary)]">{t('settings.yinxiang_account')}: {connection.accountLabel ?? connection.accountId}</div>}
          {scope && <div className="mt-1 text-[11.5px] text-[var(--text-quaternary)]">{t('settings.yinxiang_scope')}: {scope}</div>}
          {connection?.lastError && <div role="alert" className="mt-2 text-[11.5px] text-[var(--danger)]">{connection.lastError}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {!connection || connection.status === 'disconnected' ? <Button size="sm" icon={<ExternalLink size={13} />} loading={busy === 'connect'} onClick={() => void connect()}>{t('settings.yinxiang_connect')}</Button> : <>
            <Button size="sm" icon={<RefreshCw size={13} />} loading={busy === 'sync'} onClick={() => void sync()}>{t('settings.yinxiang_sync_now')}</Button>
            <Button size="sm" variant="ghost" icon={<Unplug size={13} />} loading={busy === 'disconnect'} onClick={() => void disconnect()}>{t('settings.yinxiang_disconnect')}</Button>
          </>}
        </div>
      </div>
    </section>

    {connection && <>
      <section>
        <h3 className="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{t('settings.yinxiang_scope_section')}</h3>
        {notebookCount === 0 ? <p className="py-3 text-[12px] text-[var(--text-tertiary)]">{t('settings.yinxiang_no_notebooks')}</p> : <div className="space-y-1 border-b border-[var(--border-subtle)] py-2">{connection.notebooks.map((notebook) => <Checkbox key={notebook.guid} checked={selected.includes(notebook.guid)} onChange={(checked) => { if (!notebook.canRead) return; setSelected((current) => checked ? [...current, notebook.guid] : current.filter((id) => id !== notebook.guid)) }} label={<span className={!notebook.canRead ? 'opacity-50' : undefined}>{notebook.name}{notebook.shared ? ` (${t('settings.yinxiang_shared')})` : ''}</span>} />)}</div>}
        <p className="mt-2 text-[11.5px] text-[var(--text-quaternary)]">{t('settings.yinxiang_selected_count', { value0: selectedCount })}</p>
      </section>
      <section>
        <SettingRow title={t('settings.yinxiang_root_folder')} description={t('settings.yinxiang_root_folder_description')}>
          <Select value={rootFolderId ?? ''} onChange={(event) => setRootFolderId(event.target.value || null)} className="min-w-[180px]"><option value="">{t('settings.yinxiang_top_level')}</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</Select>
        </SettingRow>
        <SettingRow title={t('settings.yinxiang_attachments')} description={t('settings.yinxiang_attachments_description')}>
          <Checkbox checked={includeAttachments} onChange={setIncludeAttachments} label={t('settings.yinxiang_attachments')} />
        </SettingRow>
        <SettingRow title={t('settings.yinxiang_frequency')}>
          <Select value={frequency} onChange={(event) => setFrequency(event.target.value as typeof frequency)} className="min-w-[130px]"><option value="manual">{t('settings.yinxiang_frequency_manual')}</option><option value="hourly">{t('settings.yinxiang_frequency_hourly')}</option><option value="daily">{t('settings.yinxiang_frequency_daily')}</option></Select>
        </SettingRow>
        <div className="flex flex-wrap items-center gap-2 pt-3"><Button size="sm" loading={busy === 'save'} onClick={() => void save()}>{t('common.save')}</Button>{connection.status === 'paused' ? <Button size="sm" variant="ghost" icon={<Play size={13} />} onClick={() => void run('resume', async () => { const result = await api.yinxiang.resume(); setConnection(result.connection) })}>{t('settings.yinxiang_resume')}</Button> : <Button size="sm" variant="ghost" icon={<Pause size={13} />} onClick={() => void run('pause', async () => { const result = await api.yinxiang.pause(); setConnection(result.connection) })}>{t('settings.yinxiang_pause')}</Button>}</div>
      </section>
    </>}
  </div>
}
