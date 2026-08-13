/**
 * MCP settings section: one card per configured MCP server joined with its
 * live activation status, an add flow, and one editor at a time. Every
 * mutation writes through the settings wire (`mcp` namespace), and the page
 * re-renders from pushed invalidations or the post-write reload. The server
 * name doubles as the settings map key, so a rename saves as an unset of the
 * old key followed by a set of the new one in a single mutate.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconPlusOutline16, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import { draftFrom, entryFrom, messageOf } from './store.ts'
import type { McpServerEntryView, McpSettingsState, McpSettingsStore, ServerEditorDraft } from './store.ts'
import type { en } from './locales.ts'
import styles from './McpSection.module.css'

/** Injected dependencies of {@link McpSection} (slot `inject`). */
export interface McpSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: McpSettingsStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<McpSettingsState>
  /** Wire faces the editor writes through. */
  api: Pick<IApiClient, 'settings' | 'mcp'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type McpSectionProps = Partial<McpSectionInjected>

/** Stable server-identity label for copy and aria purposes. */
function serverLabel(serverName: string): string {
  return serverName
}

/** The state-dot state for one server's activation status. */
function statusDot(status: McpSettingsState['rows'][number]['status']): 'done' | 'warning' | 'ongoing' | 'error' | undefined {
  if (status === undefined) return undefined
  if (status.status === 'running') return 'done'
  if (status.status === 'pending') return 'ongoing'
  return 'error'
}

/** The status copy for one server's activation status. */
function statusText(status: McpSettingsState['rows'][number]['status'], t: (key: keyof typeof en) => string): string {
  if (status === undefined) return t('statusUnknown')
  if (status.status === 'running') return t('statusConnected')
  if (status.status === 'pending') return t('statusPending')
  return status.error === undefined ? t('statusError') : `${t('statusError')}: ${status.error}`
}

/**
 * Render the MCP section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function McpSection(props: McpSectionProps): ReactNode {
  const { controller, useSnapshot, api, t } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || t === undefined) return null
  return <Loaded injected={{ controller, useSnapshot, api, t }} />
}

function Loaded({ injected }: { injected: McpSectionInjected }): ReactNode {
  const { controller, api, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<string | undefined>(undefined)

  const announceSaved = (serverName: string): void => {
    void controller.load().then(() => { setSavedTarget(serverName) })
  }

  const closeEditor = (changed: boolean, serverName: string): void => {
    setEditing(undefined)
    setAdding(false)
    if (changed) announceSaved(serverName)
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void removeServer(api, controller, deleteTarget)
      .then((failure) => {
        if (failure !== undefined) {
          setDeleteFailure(failure)
          return
        }
        setDeleteTarget(undefined)
      })
      .finally(() => { setDeleting(false) })
  }

  if (state.status === 'idle') void controller.load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {savedTarget === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {t('saved').replace('{server}', () => serverLabel(savedTarget))}
          </p>
        )}
      {state.rows.length === 0 && !adding
        ? <p className={styles['empty']}>{t('noServers')}</p>
        : (
          <ul className={styles['rows']}>
            {state.rows.map((row) => {
              const open = !adding && editing === row.serverName
              return (
                <li key={row.serverName} className={styles['rowCard']}>
                  <div className={styles['rowHead']}>
                    <span className={styles['rowIdentity']}>
                      <span className={styles['rowName']}>{row.serverName}</span>
                      <span className={styles['rowTag']}>{t(row.entry.transport === 'stdio' ? 'transportStdio' : 'transportHttp')}</span>
                      {row.entry.enabled === false
                        ? <span className={styles['rowTag']}>{t('enabled')} ✕</span>
                        : null}
                      {statusDot(row.status) === undefined
                        ? null
                        : (
                          <span
                            className={styles['statusRow']}
                            role="img"
                            aria-label={statusText(row.status, t)}
                            title={statusText(row.status, t)}
                          >
                            <StateDot state={statusDot(row.status) as 'done' | 'warning' | 'ongoing' | 'error'} />
                            <span className={styles['statusText']}>{statusText(row.status, t)}</span>
                          </span>
                        )}
                    </span>
                    <span className={styles['rowActions']}>
                      <button
                        type="button"
                        className={styles['secondaryButton']}
                        aria-label={`${t('edit')} ${row.serverName}`}
                        onClick={() => {
                          setSavedTarget(undefined)
                          setAdding(false)
                          setEditing(open ? undefined : row.serverName)
                        }}
                      >
                        {t('edit')}
                      </button>
                      {row.removable
                        ? (
                          <button
                            type="button"
                            className={styles['dangerButton']}
                            aria-label={`${t('remove')} ${row.serverName}`}
                            disabled={!state.writable}
                            onClick={() => {
                              setSavedTarget(undefined)
                              setDeleteFailure(undefined)
                              setDeleteTarget(row.serverName)
                            }}
                          >
                            {t('remove')}
                          </button>
                        )
                        : null}
                    </span>
                  </div>
                  {open
                    ? (
                      <ServerEditor
                        serverName={row.serverName}
                        entry={row.entry}
                        api={api}
                        t={t}
                        readOnly={!state.writable}
                        onClose={(changed, name) => { closeEditor(changed, name) }}
                      />
                    )
                    : null}
                </li>
              )
            })}
            {adding
              ? (
                <li className={styles['rowCard']}>
                  <ServerEditor
                    serverName={undefined}
                    entry={undefined}
                    api={api}
                    t={t}
                    readOnly={!state.writable}
                    onClose={(changed, name) => { closeEditor(changed, name) }}
                  />
                </li>
              )
              : null}
          </ul>
        )}
      {!adding && editing === undefined
        ? (
          <div className={styles['addBlock']}>
            <button
              type="button"
              className={styles['addButton']}
              disabled={!state.writable}
              onClick={() => {
                setSavedTarget(undefined)
                setAdding(true)
              }}
            >
              <IconPlusOutline16 size={14} />
              {t('add')}
            </button>
          </div>
        )
        : null}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : t('deleteTitle').replace('{server}', () => serverLabel(deleteTarget))}
        closeLabel={t('close')}
        description={deleteTarget === undefined ? '' : t('deleteDescription').replace('{server}', () => serverLabel(deleteTarget))}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : t(deleting ? 'deleting' : 'deleteConfirm').replace('{server}', () => serverLabel(deleteTarget))}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}

/**
 * Save one server entry to the `mcp` namespace: a new server sets its key, an
 * edited one unsets the old key when renamed and sets the new key — both in
 * one mutate so a rename is atomic. The settings seam validates the whole
 * section (server-name pattern, transport fields), so a rejected write names
 * the exact problem. The caller reloads the page snapshot after success.
 * @param api - settings wire face.
 * @param originalName - the server's current key, undefined when adding.
 * @param serverName - the next key.
 * @param entry - the next entry.
 * @returns the failure message, or undefined once the write landed.
 */
export async function saveServer(
  api: Pick<IApiClient, 'settings'>,
  originalName: string | undefined,
  serverName: string,
  entry: McpServerEntryView,
): Promise<string | undefined> {
  const ops: SettingsPathOpView[] = []
  if (originalName !== undefined && originalName !== serverName) {
    ops.push({ op: 'unset', path: ['servers', originalName] })
  }
  ops.push({ op: 'set', path: ['servers', serverName], value: entry })
  try {
    const response = await api.settings.mutate({ ns: 'mcp', ops })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    return messageOf(error)
  }
  return undefined
}

/**
 * Remove one server from the `mcp` namespace, naming its key rather than
 * rebuilding the section from a partial view.
 * @param api - settings wire face.
 * @param controller - the page store to refresh.
 * @param serverName - the server's settings key.
 * @returns the failure message, or undefined once the write and reload landed.
 */
export async function removeServer(
  api: Pick<IApiClient, 'settings'>,
  controller: McpSettingsStore,
  serverName: string,
): Promise<string | undefined> {
  try {
    const response = await api.settings.mutate({
      ns: 'mcp',
      ops: [{ op: 'unset', path: ['servers', serverName] }],
    })
    if (!response.result.ok) return response.result.error.message
  } catch (error) {
    return messageOf(error)
  }
  await controller.load()
  return undefined
}

/** The one-server editor card, shared by the add flow and expanded rows. */
export function ServerEditor({ serverName, entry, api, t, readOnly, onClose }: {
  /** The server's current settings key; undefined in the add flow. */
  serverName: string | undefined
  /** The current entry; undefined in the add flow. */
  entry: McpServerEntryView | undefined
  /** Settings wire face for the save. */
  api: Pick<IApiClient, 'settings'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every write control in a read-only deployment. */
  readOnly: boolean
  /** Fired on close; `changed` is true only after a successful save. */
  onClose: (changed: boolean, serverName: string) => void
}): ReactNode {
  const [draft, setDraft] = useState<ServerEditorDraft>(() => draftFrom(serverName, entry))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [dirty, setDirty] = useState(false)

  const set = (patch: Partial<ServerEditorDraft>): void => {
    setDraft(previous => ({ ...previous, ...patch }))
    setDirty(true)
    setFailure(undefined)
  }

  const save = (): void => {
    if (saving) return
    const resolved = entryFrom(draft)
    if (resolved.problem !== undefined) {
      setFailure(resolved.problem)
      return
    }
    setSaving(true)
    setFailure(undefined)
    void saveServer(api, serverName, draft.serverName.trim(), resolved.entry)
      .then((problem) => {
        if (problem !== undefined) {
          setFailure(problem)
          return
        }
        onClose(true, draft.serverName.trim())
      })
      .finally(() => { setSaving(false) })
  }

  return (
    <form
      className={styles['editor']}
      onSubmit={(event) => { event.preventDefault(); save() }}
    >
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('serverName')}</span>
        <input
          className={styles['input']}
          value={draft.serverName}
          disabled={readOnly || serverName !== undefined}
          aria-label={t('serverName')}
          placeholder="github"
          onChange={(event) => { set({ serverName: event.target.value }) }}
        />
        <span className={styles['fieldHint']}>{t('serverNameHint')}</span>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('transport')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={draft.transport}
          disabled={readOnly}
          aria-label={t('transport')}
          onChange={(event) => { set({ transport: event.target.value as 'stdio' | 'streamable-http' }) }}
        >
          <option value="stdio">{t('transportStdio')}</option>
          <option value="streamable-http">{t('transportHttp')}</option>
        </select>
      </div>
      {draft.transport === 'stdio'
        ? (
          <>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('command')}</span>
              <input
                className={styles['input']}
                value={draft.command}
                disabled={readOnly}
                aria-label={t('command')}
                placeholder="npx -y @modelcontextprotocol/server-github"
                onChange={(event) => { set({ command: event.target.value }) }}
              />
              <span className={styles['fieldHint']}>{t('commandHint')}</span>
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('args')}</span>
              <textarea
                className={`${styles['input']} ${styles['textarea']}`}
                value={draft.argsText}
                disabled={readOnly}
                aria-label={t('args')}
                rows={3}
                onChange={(event) => { set({ argsText: event.target.value }) }}
              />
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('env')}</span>
              <textarea
                className={`${styles['input']} ${styles['textarea']}`}
                value={draft.envText}
                disabled={readOnly}
                aria-label={t('env')}
                rows={3}
                onChange={(event) => { set({ envText: event.target.value }) }}
              />
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('cwd')}</span>
              <input
                className={styles['input']}
                value={draft.cwd}
                disabled={readOnly}
                aria-label={t('cwd')}
                onChange={(event) => { set({ cwd: event.target.value }) }}
              />
            </div>
          </>
        )
        : (
          <>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('url')}</span>
              <input
                className={styles['input']}
                value={draft.url}
                disabled={readOnly}
                aria-label={t('url')}
                placeholder="http://localhost:3000/mcp"
                onChange={(event) => { set({ url: event.target.value }) }}
              />
            </div>
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('headers')}</span>
              <textarea
                className={`${styles['input']} ${styles['textarea']}`}
                value={draft.headersText}
                disabled={readOnly}
                aria-label={t('headers')}
                rows={3}
                onChange={(event) => { set({ headersText: event.target.value }) }}
              />
            </div>
          </>
        )}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('toolCallTimeoutMs')}</span>
        <input
          className={styles['input']}
          value={draft.toolCallTimeoutMs}
          disabled={readOnly}
          aria-label={t('toolCallTimeoutMs')}
          inputMode="numeric"
          placeholder="60000"
          onChange={(event) => { set({ toolCallTimeoutMs: event.target.value }) }}
        />
      </div>
      <label className={styles['checkRow']}>
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={readOnly}
          onChange={(event) => { set({ enabled: event.target.checked }) }}
        />
        <span>{t('enabled')}</span>
      </label>
      <span className={styles['fieldHint']}>{t('enabledHint')}</span>
      {failure === undefined ? null : <p className={styles['error']}>{`${t('saveFailed')}: ${failure}`}</p>}
      <div className={styles['editorActions']}>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={saving}
          onClick={() => { onClose(false, serverName ?? '') }}
        >
          {t('cancel')}
        </button>
        <button
          type="submit"
          className={styles['primaryButton']}
          disabled={readOnly || saving || !dirty}
        >
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </form>
  )
}
