/**
 * Image-describe settings section: configures the vision model that converts
 * dialog images into descriptions at prompt admission. Two modes: pick a
 * registered llm-pi-ai provider and model (baseURL/apiKeyEnv materialized
 * from that provider's profile), or declare a standalone OpenAI-compatible
 * endpoint with its own API key. Writes go through the wire; the section
 * re-renders from pushed invalidations or the post-save reload.
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-web-react'
import {
  IMAGE_DESCRIBE_KEY_REF, ImageDescribeStore, type ImageDescribeState, type ImageDescribeSection,
} from './image-describe-store.ts'
import type { en } from './locales.ts'
import styles from './ImageDescribeSection.module.css'

/** Injected dependencies of {@link ImageDescribeSection} (slot `inject`). */
export interface ImageDescribeSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ImageDescribeStore
  /** uSES subscription hook bound to the store. */
  useSnapshot: SnapshotSelectorHook<ImageDescribeState>
  /** Wire faces the section writes through. */
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Props delivered by the slot outlet: the inject face spread flat (the
 * renderer erases the share boundary at the render call).
 */
export type ImageDescribeSectionProps = Partial<ImageDescribeSectionInjected>

/** Render the Image-describe section content column. */
export function ImageDescribeSection(props: ImageDescribeSectionProps): ReactNode {
  const { controller, useSnapshot, api, t } = props
  if (controller === undefined || useSnapshot === undefined || api === undefined || t === undefined) return null
  return <Loaded injected={{ controller, useSnapshot, api, t }} />
}

/** One edited draft before it is committed. */
interface Draft {
  enabled: boolean
  provider: string
  baseURL: string
  model: string
  systemPrompt: string
  apiKey: string
}

function Loaded({ injected }: { injected: ImageDescribeSectionInjected }): ReactNode {
  const { controller, t } = injected
  const state = injected.useSnapshot(snapshot => snapshot)
  const modelId = useId()
  // One shared draft; edits land here and the save commits it. The stored
  // section seeds the draft once per store load (an external change moves the
  // fields back under the user's edits).
  const [draft, setDraft] = useState<Draft>(() => draftOf(state.section))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const seededRef = useRef(false)

  useEffect(() => {
    if (state.status !== 'ready' || seededRef.current) return
    seededRef.current = true
    setDraft(draftOf(state.section))
  }, [state.status, state.section])

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [state.status, controller])

  const mode = draft.provider.length > 0 ? 'provider' : 'custom'
  const chosen = state.providers.find(choice => choice.provider === draft.provider)
  const models = state.modelsByProvider.get(draft.provider) ?? []
  const writable = state.writable

  const patch = (next: Partial<Draft>): void => {
    setDraft(current => ({ ...current, ...next }))
    setSaved(false)
    setFailure(undefined)
  }

  const pickProvider = (provider: string): void => {
    const choice = state.providers.find(candidate => candidate.provider === provider)
    patch({
      provider,
      // The provider's own endpoint and credential reference materialize into
      // the section, so the picker never asks for a second key.
      ...choice === undefined ? {} : { baseURL: choice.baseURL ?? '', apiKey: '' },
    })
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const keyToStore = draft.apiKey.trim().length > 0 ? draft.apiKey.trim() : undefined
      const section: ImageDescribeSection = {
        enabled: draft.enabled,
        baseURL: draft.baseURL.trim(),
        apiKeyEnv: keyToStore !== undefined
          ? IMAGE_DESCRIBE_KEY_REF
          : draft.provider.length > 0
            ? chosen?.apiKeyEnv ?? ''
            : draft.apiKey.length > 0 ? IMAGE_DESCRIBE_KEY_REF : '',
        model: draft.model.trim(),
        systemPrompt: draft.systemPrompt.trim(),
      }
      const outcome = await controller.save(section, keyToStore)
      if (outcome !== undefined) {
        setFailure(outcome)
        return
      }
      setSaved(true)
      seededRef.current = false
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = (enabled: boolean): void => {
    patch({ enabled })
    if (!enabled) {
      // Disabling is a full save that keeps the other fields for re-enabling.
      void controller.save({ ...state.section, enabled: false }, undefined).then((outcome) => {
        if (outcome !== undefined) setFailure(outcome)
      })
    }
  }

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('visionTitle')}</h2>
      <p className={styles['intro']}>{t('visionIntro')}</p>
      {!writable && state.status === 'ready' ? <p className={styles['notice']}>{t('readOnly')}</p> : null}
      {state.status === 'error'
        ? (
          <div className={styles['errorBlock']}>
            <p className={styles['error']}>{`${t('loadFailed')}: ${state.error ?? ''}`}</p>
            <button type="button" className={styles['secondaryButton']} onClick={() => { void controller.load() }}>
              {t('retry')}
            </button>
          </div>
        )
        : (
          <form
            className={styles['form']}
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('visionEnabled')}</span>
              <input
                type="checkbox"
                className={styles['checkbox']}
                aria-label={t('visionEnabled')}
                checked={draft.enabled}
                disabled={!writable || busy}
                onChange={(event) => { toggleEnabled(event.target.checked) }}
              />
            </div>

            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('visionMode')}</span>
              <select
                className={`${styles['input']} ${styles['selectInput']}`}
                value={mode}
                disabled={!writable || busy}
                aria-label={t('visionMode')}
                onChange={(event) => {
                  patch({ provider: event.target.value === 'provider' ? state.providers[0]?.provider ?? '' : '' })
                }}
              >
                <option value="provider">{t('visionModeProvider')}</option>
                <option value="custom">{t('visionModeCustom')}</option>
              </select>
            </div>

            {mode === 'provider'
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('provider')}</span>
                  <select
                    className={`${styles['input']} ${styles['selectInput']}`}
                    value={draft.provider}
                    disabled={!writable || busy || state.providers.length === 0}
                    aria-label={t('provider')}
                    onChange={(event) => { pickProvider(event.target.value) }}
                  >
                    {state.providers.length === 0
                      ? <option value="">{t('visionNoProvider')}</option>
                      : state.providers.map(choice => (
                        <option key={choice.provider} value={choice.provider}>{choice.displayName}</option>
                      ))}
                  </select>
                </div>
              )
              : null}

            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
              <input
                type="text"
                className={styles['input']}
                aria-label={t('baseUrl')}
                value={draft.baseURL}
                disabled={!writable || busy}
                placeholder={t('baseUrlPlaceholder')}
                onChange={(event) => { patch({ baseURL: event.target.value }) }}
              />
            </div>

            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('model')}</span>
              <input
                type="text"
                className={styles['input']}
                aria-label={t('model')}
                value={draft.model}
                list={models.length > 0 ? modelId : undefined}
                disabled={!writable || busy}
                placeholder={t('modelPlaceholder')}
                onChange={(event) => { patch({ model: event.target.value }) }}
              />
              {models.length > 0
                ? (
                  <datalist id={modelId}>
                    {models.map(id => <option key={id} value={id} />)}
                  </datalist>
                )
                : null}
            </div>

            {mode === 'custom'
              ? (
                <div className={styles['field']}>
                  <span className={styles['fieldLabel']}>{t('keyInput')}</span>
                  <input
                    type="password"
                    className={styles['input']}
                    aria-label={t('keyInput')}
                    value={draft.apiKey}
                    disabled={!writable || busy}
                    placeholder={t('keyPlaceholder')}
                    onChange={(event) => { patch({ apiKey: event.target.value }) }}
                  />
                </div>
              )
              : null}

            <div className={styles['field']}>
              <span className={styles['fieldLabel']}>{t('visionSystemPrompt')}</span>
              <textarea
                className={`${styles['input']} ${styles['textarea']}`}
                aria-label={t('visionSystemPrompt')}
                value={draft.systemPrompt}
                disabled={!writable || busy}
                placeholder={t('visionSystemPromptPlaceholder')}
                onChange={(event) => { patch({ systemPrompt: event.target.value }) }}
              />
            </div>

            {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
            {saved ? <p className={styles['savedNotice']} role="status" aria-live="polite">{t('visionSaved')}</p> : null}

            <div className={styles['actions']}>
              <Button variant="outline" className={styles['saveButton']} disabled={!writable || busy} onClick={() => { void submit() }}>
                {busy ? t('applying') : t('apply')}
              </Button>
            </div>
          </form>
        )}
    </div>
  )
}

/** Map the stored section onto an editable draft. */
function draftOf(section: ImageDescribeSection): Draft {
  return {
    enabled: section.enabled,
    provider: '',
    baseURL: section.baseURL,
    model: section.model,
    systemPrompt: section.systemPrompt,
    apiKey: '',
  }
}
