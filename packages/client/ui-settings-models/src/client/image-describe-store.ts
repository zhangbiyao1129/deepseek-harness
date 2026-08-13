/**
 * Image-describe settings page store: one snapshot joining the `image-describe`
 * settings namespace (the vision model configuration), the `llm-pi-ai`
 * namespace (provider profiles the picker materializes baseURL/apiKeyEnv
 * from), the configurable-provider directory, and the referenced credential.
 * The host stays the single fact source — every mutation writes through the
 * wire and the page re-renders from the next describe, pushed or refetched.
 */

import type {
  ConfigurableProviderView, CredentialView, IApiClient, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { getPath } from '@deepseek-ai/dsh-client-schema-form'

/** Settings namespace holding the vision model configuration. */
export const IMAGE_DESCRIBE_NS = 'image-describe'

/** Conventional credential reference for the standalone vision API key. */
export const IMAGE_DESCRIBE_KEY_REF = 'IMAGE_DESCRIBE_API_KEY'

/** The resolved `image-describe` section, as the page renders it. */
export interface ImageDescribeSection {
  enabled: boolean
  baseURL: string
  apiKeyEnv: string
  model: string
  systemPrompt: string
}

/** One configurable provider that the picker can materialize an endpoint from. */
export interface VisionProviderChoice {
  /** Provider route id. */
  provider: string
  /** Display name for the picker. */
  displayName: string
  /** Resolved baseURL from the provider's llm-pi-ai profile, when declared. */
  baseURL: string | undefined
  /** Resolved apiKeyEnv from the provider's llm-pi-ai profile, when declared. */
  apiKeyEnv: string | undefined
}

/** Page snapshot. */
export interface ImageDescribeState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; write failures stay in the section. */
  error: string | null
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** The resolved vision-model section (all empty while unset). */
  section: ImageDescribeSection
  /** Providers the picker offers, with endpoint facts from llm-pi-ai profiles. */
  providers: readonly VisionProviderChoice[]
  /** Model ids per registered provider route, for the model picker datalist. */
  modelsByProvider: ReadonlyMap<string, readonly string[]>
  /** Credential state for {@link IMAGE_DESCRIBE_KEY_REF}, once described. */
  credential: CredentialView | undefined
  /** Namespace revision the section was read at (mutate conflict detection). */
  revision: number
}

/** Empty section used before any namespace value exists. */
const EMPTY_SECTION: ImageDescribeSection = {
  enabled: false, baseURL: '', apiKeyEnv: '', model: '', systemPrompt: '',
}

/** Human text for a rejected wire call. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the resolved image-describe section out of one namespace view. */
function sectionOf(namespace: SettingsNamespaceView | undefined): ImageDescribeSection {
  const value = namespace?.value
  if (typeof value !== 'object' || value === null) return { ...EMPTY_SECTION }
  const read = (key: string): string => {
    const entry = (value as Record<string, unknown>)[key]
    return typeof entry === 'string' ? entry : ''
  }
  return {
    enabled: (value as Record<string, unknown>).enabled === true,
    baseURL: read('baseURL'),
    apiKeyEnv: read('apiKeyEnv'),
    model: read('model'),
    systemPrompt: read('systemPrompt'),
  }
}

/**
 * Project the provider picker from the configurable-provider directory joined
 * with each provider's llm-pi-ai profile facts. A provider whose profile
 * declares neither baseURL nor apiKeyEnv cannot serve a direct vision call
 * and is withheld.
 * @param providers - the configurable-provider directory.
 * @param piAi - the llm-pi-ai namespace view, when mounted.
 * @returns the pickable providers in directory order.
 */
export function visionProviderChoices(
  providers: readonly ConfigurableProviderView[],
  piAi: SettingsNamespaceView | undefined,
): VisionProviderChoice[] {
  const profiles = getPath(piAi?.value, ['providers'])
  const byRoute = typeof profiles === 'object' && profiles !== null
    ? profiles as Record<string, unknown>
    : {}
  const choices: VisionProviderChoice[] = []
  for (const entry of providers) {
    const profile = byRoute[entry.provider]
    if (typeof profile !== 'object' || profile === null) continue
    const baseURL = (profile as Record<string, unknown>).baseURL
    const apiKeyEnv = (profile as Record<string, unknown>).apiKeyEnv
    if (typeof baseURL !== 'string' || baseURL.length === 0) continue
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) continue
    choices.push({
      provider: entry.provider,
      displayName: entry.displayName,
      baseURL,
      apiKeyEnv,
    })
  }
  return choices
}

/** The image-describe settings page controller (one per settings surface). */
export class ImageDescribeStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ImageDescribeState> = createSnapshotStore<ImageDescribeState>({
    status: 'idle', error: null, writable: false, section: { ...EMPTY_SECTION }, providers: [],
    modelsByProvider: new Map(), credential: undefined, revision: 0,
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param api - the wire face (settings/credentials/llm domains).
   */
  constructor(private readonly api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>) {}

  /**
   * Refresh the whole page snapshot: settings namespaces, the provider
   * directory, and the model catalog in parallel, then one credential
   * describe for the standalone key reference. A failure keeps the last good
   * state and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let writable: boolean
    let namespaces: SettingsNamespaceView[]
    let providers: ConfigurableProviderView[]
    let modelsByProvider: ReadonlyMap<string, readonly string[]>
    try {
      const [settingsResponse, providersResponse, modelsResponse] = await Promise.all([
        this.api.settings.describe({}),
        this.api.llm.providers({}),
        this.api.llm.models({}),
      ])
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
      if (!modelsResponse.result.ok) throw new Error(modelsResponse.result.error.message)
      writable = settingsResponse.result.value.writable
      namespaces = settingsResponse.result.value.namespaces
      providers = providersResponse.result.value.providers
      modelsByProvider = new Map(modelsResponse.result.value.groups.map(group => [group.id, group.models.map(model => model.id)]))
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = messageOf(error)
      })
      return
    }
    const byNs = new Map(namespaces.map(view => [view.ns, view]))
    const section = sectionOf(byNs.get(IMAGE_DESCRIBE_NS))
    const choices = visionProviderChoices(providers, byNs.get('llm-pi-ai'))
    const revision = byNs.get(IMAGE_DESCRIBE_NS)?.revision ?? 0
    let credential: CredentialView | undefined
    try {
      const response = await this.api.credentials.describe({ refs: [IMAGE_DESCRIBE_KEY_REF] })
      if (response.result.ok) credential = response.result.value.credentials[IMAGE_DESCRIBE_KEY_REF]
    } catch {
      // Credential enrichment is advisory; the section stays usable.
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.writable = writable
      s.section = section
      s.providers = choices
      s.modelsByProvider = modelsByProvider
      s.credential = credential
      s.revision = revision
    })
  }

  /**
   * Save the vision-model section and, when a standalone API key was typed,
   * the credential it references. The key write is best-effort-second: the
   * section records the reference unconditionally, and a failed key write is
   * reported so the user can retry the key alone.
   * @param section - the section to store (replaces the user layer).
   * @param apiKey - a new standalone key to store, or undefined to keep/omit.
   * @returns the failure message, or undefined once both writes landed.
   */
  async save(section: ImageDescribeSection, apiKey: string | undefined): Promise<string | undefined> {
    const patch: Record<string, unknown> = {
      enabled: section.enabled,
      baseURL: section.baseURL,
      apiKeyEnv: section.apiKeyEnv,
      model: section.model,
      systemPrompt: section.systemPrompt,
    }
    try {
      const response = await this.api.settings.replace({
        ns: IMAGE_DESCRIBE_NS,
        section: patch,
        expectedRevision: this.store.getSnapshot().revision,
      })
      if (!response.result.ok) return response.result.error.message
    } catch (error) {
      return messageOf(error)
    }
    if (apiKey !== undefined && apiKey.length > 0) {
      try {
        const stored = await this.api.credentials.set({ ref: IMAGE_DESCRIBE_KEY_REF, value: apiKey })
        if (!stored.result.ok) return stored.result.error.message
      } catch (error) {
        return messageOf(error)
      }
    }
    await this.load()
    return undefined
  }
}
